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

    return {
      username,
      accessToken,
      refreshToken,
      expiresInSeconds: this.config.accessTokenTtlSeconds,
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
    const record = await this.buildUserRecord(input.username, input.password, input.createdBy);
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
    const record = await this.buildUserRecord(input.username, input.password, 'setup-wizard');
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
      return;
    }
    const record = await this.buildUserRecord(
      credentials.username,
      credentials.password,
      'bootstrap-env',
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
      };
    }

    return {
      username,
      passwordHash: '',
      createdAt: 0,
      createdBy: 'unknown',
      active: true,
      lastLoginAt: null,
    };
  }

  private async buildUserRecord(
    username: string,
    password: string,
    createdBy: string,
  ): Promise<UserRecord> {
    return {
      username,
      passwordHash: await hashPassword(password),
      createdAt: this.now(),
      createdBy,
      active: true,
      lastLoginAt: null,
    };
  }
}
