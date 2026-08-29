import {
  InvalidRepoRoleError,
  RepoRoleAssignmentNotFoundError,
  SetupAlreadyConfiguredError,
  UserAlreadyExistsError,
  UserHasActiveSessionsError,
  UserInactiveError,
  UserNotFoundError,
} from './errors';
import { issueAccessToken, verifyAccessToken } from './jwt-issuer';
import { LoginRateLimiter } from './login-rate-limiter';
import { hashPassword, verifyCredentials } from './password-authenticator';
import { SlidingWindowSessionManager } from './session-manager';
import type { SessionStore } from './session-store';
import type {
  AccessTokenClaims,
  CreateUserInput,
  LoginResult,
  RepoRole,
  RepoRoleAssignment,
  SetupStatus,
  UserSummary,
} from './types';
import type { UserRecord, UserStore } from './user-store';

const REPO_ROLES: RepoRole[] = ['reader', 'writer', 'admin'];

export interface AuthServiceConfig {
  jwtPrivateKeyPem: string;
  jwtPublicKeyPem: string;
  accessTokenTtlSeconds: number;
  sessionTtlSeconds: number;
  maxLoginAttempts: number;
  loginAttemptWindowMs: number;
  bootstrapAdminConfigured: boolean;
}

export class AuthService {
  private readonly rateLimiter: LoginRateLimiter;
  private readonly sessionManager: SlidingWindowSessionManager;

  constructor(
    private readonly config: AuthServiceConfig,
    private readonly userStore: UserStore,
    private readonly sessionStore: SessionStore,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.rateLimiter = new LoginRateLimiter(
      config.maxLoginAttempts,
      config.loginAttemptWindowMs,
      now,
    );
    this.sessionManager = new SlidingWindowSessionManager(
      sessionStore,
      config.sessionTtlSeconds,
      now,
    );
  }

  async login(username: string, password: string): Promise<LoginResult> {
    this.rateLimiter.assertAllowed(username);
    this.rateLimiter.recordAttempt(username);

    const user = await this.findUserForLogin(username);
    if (!user.active) {
      throw new UserInactiveError(username);
    }

    const authenticatedUsername = await verifyCredentials(username, password, [user]);
    await this.userStore.updateLastLogin(authenticatedUsername, this.now());

    const accessToken = await issueAccessToken(
      authenticatedUsername,
      this.config.jwtPrivateKeyPem,
      this.config.accessTokenTtlSeconds,
    );
    const refreshToken = await this.sessionManager.createSession(authenticatedUsername);

    return {
      username: authenticatedUsername,
      accessToken,
      refreshToken,
      expiresInSeconds: this.config.accessTokenTtlSeconds,
      isGlobalAdmin: user.isGlobalAdmin,
      canCreateRepos: user.canCreateRepos,
    };
  }

  async keepAlive(refreshToken: string): Promise<void> {
    await this.sessionManager.keepAlive(refreshToken);
  }

  async refresh(refreshToken: string): Promise<LoginResult> {
    const username = await this.sessionManager.usernameFor(refreshToken);
    await this.sessionManager.keepAlive(refreshToken);

    const accessToken = await issueAccessToken(
      username,
      this.config.jwtPrivateKeyPem,
      this.config.accessTokenTtlSeconds,
    );

    const user = await this.userStore.getByUsername(username);
    return {
      username,
      accessToken,
      refreshToken,
      expiresInSeconds: this.config.accessTokenTtlSeconds,
      isGlobalAdmin: user?.isGlobalAdmin ?? false,
      canCreateRepos: user?.canCreateRepos ?? false,
    };
  }

  async assertSessionActive(refreshToken: string): Promise<void> {
    await this.sessionManager.assertActive(refreshToken);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.sessionManager.revoke(refreshToken);
  }

  async verifyAccessToken(accessToken: string): Promise<AccessTokenClaims> {
    return verifyAccessToken(accessToken, this.config.jwtPublicKeyPem);
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const existing = await this.userStore.getByUsername(input.username);
    if (existing) {
      throw new UserAlreadyExistsError(input.username);
    }
    const record = await this.buildUserRecord(
      input.username,
      input.password,
      input.createdBy,
      input.isGlobalAdmin ?? false,
      input.canCreateRepos ?? true,
    );
    await this.userStore.create(record);
    return record;
  }

  async listUsers(): Promise<UserSummary[]> {
    const users = await this.userStore.list();
    return Promise.all(
      users.map(async (user) => ({
        username: user.username,
        createdAt: user.createdAt,
        createdBy: user.createdBy,
        active: user.active,
        lastLoginAt: user.lastLoginAt,
        isGlobalAdmin: user.isGlobalAdmin,
        canCreateRepos: user.canCreateRepos,
        activeSessions: await this.sessionStore.countActiveSessionsForUser(
          user.username,
          this.now(),
        ),
      })),
    );
  }

  async deactivateUser(username: string): Promise<void> {
    const updated = await this.userStore.setActive(username, false);
    if (!updated) {
      throw new UserNotFoundError(username);
    }
  }

  async reactivateUser(username: string): Promise<void> {
    const updated = await this.userStore.setActive(username, true);
    if (!updated) {
      throw new UserNotFoundError(username);
    }
  }

  async deleteUser(username: string): Promise<void> {
    const activeSessions = await this.sessionStore.countActiveSessionsForUser(username, this.now());
    if (activeSessions > 0) {
      throw new UserHasActiveSessionsError(username);
    }
    const deleted = await this.userStore.delete(username);
    if (!deleted) {
      throw new UserNotFoundError(username);
    }
  }

  /**
   * Global admin gates the Admin Web UI and the user-management API
   * (`/api/v1/auth/users*`) — it is intentionally distinct from any
   * per-repo `RepoRole`. A repo admin must never be able to reach here:
   * only an existing global admin may call this (enforced by the router,
   * not this method, mirroring every other authorization check in this
   * service).
   */
  async setGlobalAdmin(username: string, isGlobalAdmin: boolean): Promise<void> {
    const updated = await this.userStore.setGlobalAdmin(username, isGlobalAdmin);
    if (!updated) {
      throw new UserNotFoundError(username);
    }
  }

  async setCanCreateRepos(username: string, canCreateRepos: boolean): Promise<void> {
    const updated = await this.userStore.setCanCreateRepos(username, canCreateRepos);
    if (!updated) {
      throw new UserNotFoundError(username);
    }
  }

  async isGlobalAdmin(username: string): Promise<boolean> {
    const user = await this.userStore.getByUsername(username);
    return user?.isGlobalAdmin ?? false;
  }

  /**
   * Returns true if the user can create new repos — either via the
   * `canCreateRepos` flag or by being a global admin (who bypasses
   * all per-feature gates).
   */
  async canUserCreateRepos(username: string): Promise<boolean> {
    const user = await this.userStore.getByUsername(username);
    if (!user) {
      return false;
    }
    return user.isGlobalAdmin || user.canCreateRepos;
  }

  async getSetupStatus(): Promise<SetupStatus> {
    if (this.config.bootstrapAdminConfigured) {
      return { eligible: false, reason: 'bootstrap_env_configured' };
    }
    const count = await this.userStore.count();
    return count === 0
      ? { eligible: true, reason: 'not_configured' }
      : { eligible: false, reason: 'users_exist' };
  }

  async setupFirstAdmin(input: { username: string; password: string }): Promise<UserRecord> {
    const status = await this.getSetupStatus();
    if (!status.eligible) {
      throw new SetupAlreadyConfiguredError();
    }
    // The very first account created for a fresh install is always a
    // global admin — otherwise nobody could ever reach the Admin Web UI.
    const record = await this.buildUserRecord(input.username, input.password, 'setup-wizard', true);
    const created = await this.userStore.tryCreateFirstUser(record);
    if (!created) {
      throw new SetupAlreadyConfiguredError();
    }
    return record;
  }

  async ensureBootstrapAdmin(
    credentials: { username: string; password: string } | null,
  ): Promise<void> {
    if (!credentials) {
      return;
    }
    const count = await this.userStore.count();
    if (count > 0) {
      // Self-healing migration path: a server that already had users before
      // the global-admin flag existed (pre-v0.3.0) got every existing user
      // migrated to `isGlobalAdmin: false`, including the operator-configured
      // bootstrap admin. Without this, that account would be permanently
      // locked out of the Admin Web UI after an upgrade, with no other
      // global admin able to fix it. If the configured bootstrap account
      // already exists but isn't a global admin, promote it — we never
      // touch its password or create a duplicate account.
      const existing = await this.userStore.getByUsername(credentials.username);
      if (existing && !existing.isGlobalAdmin) {
        await this.userStore.setGlobalAdmin(credentials.username, true);
      }
      return;
    }
    // Same reasoning as setupFirstAdmin(): the operator-configured
    // bootstrap account must be a global admin, or the freshly-booted
    // server would have no way to grant that role to anyone.
    const record = await this.buildUserRecord(
      credentials.username,
      credentials.password,
      'bootstrap-env',
      true,
    );
    const created = await this.userStore.tryCreateFirstUser(record);
    if (!created) {
      throw new SetupAlreadyConfiguredError(
        'Bootstrap admin could not be created because setup already completed',
      );
    }
  }

  async getRepoRole(username: string, repoId: string): Promise<RepoRole | null> {
    return this.userStore.getRepoRole(username, repoId);
  }

  async listRepoRoles(repoId: string): Promise<RepoRoleAssignment[]> {
    return this.userStore.listRepoRoles(repoId);
  }

  async grantRepoRole(params: {
    username: string;
    repoId: string;
    role: RepoRole;
    grantedBy: string;
  }): Promise<RepoRoleAssignment> {
    await this.assertUserExists(params.username);
    this.assertValidRepoRole(params.role);
    const assignment: RepoRoleAssignment = {
      username: params.username,
      repoId: params.repoId,
      role: params.role,
      grantedAt: this.now(),
      grantedBy: params.grantedBy,
    };
    await this.userStore.upsertRepoRole(assignment);
    return assignment;
  }

  async revokeRepoRole(username: string, repoId: string): Promise<void> {
    const deleted = await this.userStore.deleteRepoRole(username, repoId);
    if (!deleted) {
      throw new RepoRoleAssignmentNotFoundError(username, repoId);
    }
  }

  async grantRepoAdminToCreator(repoId: string, username: string): Promise<RepoRoleAssignment> {
    return this.grantRepoRole({ username, repoId, role: 'admin', grantedBy: 'repo-bootstrap' });
  }

  /**
   * Break-glass recovery for repos left with zero role assignments (e.g. a
   * repo provisioned before per-repo authorization existed, or one whose
   * auto-admin-on-creation grant never landed). Fail-closed access control
   * (ADR: Fase 5.6) means such a repo is otherwise permanently
   * inaccessible to everyone, including the system's own bootstrap admin --
   * there is no self-service way to grant a role without already holding
   * one. This only acts when the repo has NO roles at all; a repo with any
   * existing assignment (even to a different user) is left untouched, so
   * this can never be used to silently override an already-governed repo.
   */
  async backfillOrphanedRepoAdmin(
    repoId: string,
    bootstrapAdminUsername: string,
  ): Promise<RepoRoleAssignment | null> {
    const existingRoles = await this.listRepoRoles(repoId);
    if (existingRoles.length > 0) {
      return null;
    }
    const bootstrapAdmin = await this.userStore.getByUsername(bootstrapAdminUsername);
    if (!bootstrapAdmin) {
      // The configured bootstrap admin username doesn't actually exist as a
      // user (e.g. a different admin was already provisioned before this
      // env var was set) -- skip rather than crash the whole boot sequence
      // over a single orphaned repo.
      return null;
    }
    return this.grantRepoRole({
      username: bootstrapAdminUsername,
      repoId,
      role: 'admin',
      grantedBy: 'orphaned-repo-backfill',
    });
  }

  async legacyUsers() {
    return this.userStore.legacyUsers();
  }

  private assertValidRepoRole(role: string): asserts role is RepoRole {
    if (!REPO_ROLES.includes(role as RepoRole)) {
      throw new InvalidRepoRoleError(role);
    }
  }

  private async assertUserExists(username: string): Promise<void> {
    const user = await this.userStore.getByUsername(username);
    if (user) {
      return;
    }
    const legacyUsers = await this.userStore.legacyUsers();
    if (legacyUsers.some((candidate) => candidate.username === username)) {
      return;
    }
    throw new UserNotFoundError(username);
  }

  private async findUserForLogin(username: string): Promise<UserRecord> {
    const dbUser = await this.userStore.getByUsername(username);
    if (dbUser) {
      return dbUser;
    }

    const legacyUsers = await this.userStore.legacyUsers();
    const legacyUser = legacyUsers.find((candidate) => candidate.username === username);
    if (legacyUser) {
      return {
        username: legacyUser.username,
        passwordHash: legacyUser.passwordHash,
        createdAt: 0,
        createdBy: 'legacy-env',
        active: true,
        lastLoginAt: null,
        isGlobalAdmin: false,
      };
    }

    return {
      username,
      passwordHash: '',
      createdAt: 0,
      createdBy: 'unknown',
      active: true,
      lastLoginAt: null,
      isGlobalAdmin: false,
    };
  }

  private async buildUserRecord(
    username: string,
    password: string,
    createdBy: string,
    isGlobalAdmin = false,
    canCreateRepos = true,
  ): Promise<UserRecord> {
    return {
      username,
      passwordHash: await hashPassword(password),
      createdAt: this.now(),
      createdBy,
      active: true,
      lastLoginAt: null,
      isGlobalAdmin,
      canCreateRepos,
    };
  }
}
