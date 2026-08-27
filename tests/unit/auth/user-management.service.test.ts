import { describe, expect, it } from 'bun:test';
import { AuthService } from '../../../src/contexts/auth/auth.service';
import {
  SetupAlreadyConfiguredError,
  UserAlreadyExistsError,
  UserHasActiveSessionsError,
  UserInactiveError,
  UserNotFoundError,
} from '../../../src/contexts/auth/errors';
import type { SessionStore } from '../../../src/contexts/auth/session-store';
import type { RepoRoleAssignment } from '../../../src/contexts/auth/types';
import type { UserRecord, UserStore } from '../../../src/contexts/auth/user-store';
import { generateTestJwtKeypairPem } from '../../fixtures/license-fixtures';

function createInMemorySessionStore(): SessionStore {
  const sessions = new Map<string, { username: string; createdAt: number; expiresAt: number }>();
  return {
    async create(refreshToken, username, expiresAt) {
      sessions.set(refreshToken, { username, createdAt: Date.now(), expiresAt });
    },
    async get(refreshToken) {
      return sessions.get(refreshToken) ?? null;
    },
    async touch(refreshToken, newExpiresAt) {
      const existing = sessions.get(refreshToken);
      if (existing) {
        existing.expiresAt = newExpiresAt;
      }
    },
    async revoke(refreshToken) {
      sessions.delete(refreshToken);
    },
    async countActiveSessionsForUser(username, now) {
      let total = 0;
      for (const session of sessions.values()) {
        if (session.username === username && session.expiresAt >= now) {
          total += 1;
        }
      }
      return total;
    },
  };
}

function createInMemoryUserStore(): UserStore {
  const users = new Map<string, UserRecord>();
  const repoRoles = new Map<string, RepoRoleAssignment>();
  const repoRoleKey = (username: string, repoId: string) => `${username}::${repoId}`;
  let setupWinner = false;
  return {
    async init() {},
    async count() {
      return users.size;
    },
    async list() {
      return Array.from(users.values()).sort((a, b) => a.username.localeCompare(b.username));
    },
    async getByUsername(username) {
      return users.get(username) ?? null;
    },
    async create(user) {
      if (users.has(user.username)) {
        throw new UserAlreadyExistsError(user.username);
      }
      users.set(user.username, user);
    },
    async setActive(username, active) {
      const existing = users.get(username);
      if (!existing) {
        return false;
      }
      users.set(username, { ...existing, active });
      return true;
    },
    async updateLastLogin(username, lastLoginAt) {
      const existing = users.get(username);
      if (!existing) {
        return false;
      }
      users.set(username, { ...existing, lastLoginAt });
      return true;
    },
    async delete(username) {
      return users.delete(username);
    },
    async tryCreateFirstUser(user) {
      if (setupWinner || users.size > 0) {
        return false;
      }
      setupWinner = true;
      users.set(user.username, user);
      return true;
    },
    async legacyUsers() {
      return [];
    },
    async getRepoRole(username, repoId) {
      return repoRoles.get(repoRoleKey(username, repoId))?.role ?? null;
    },
    async listRepoRoles(repoId) {
      return Array.from(repoRoles.values())
        .filter((assignment) => assignment.repoId === repoId)
        .sort((a, b) => a.username.localeCompare(b.username));
    },
    async upsertRepoRole(assignment) {
      repoRoles.set(repoRoleKey(assignment.username, assignment.repoId), assignment);
    },
    async deleteRepoRole(username, repoId) {
      return repoRoles.delete(repoRoleKey(username, repoId));
    },
  };
}

describe('auth/AuthService user management', () => {
  async function createService(options?: { bootstrapConfigured?: boolean }) {
    const { privateKeyPem: jwtPrivateKeyPem, publicKeyPem: jwtPublicKeyPem } =
      generateTestJwtKeypairPem();
    const userStore = createInMemoryUserStore();
    const sessionStore = createInMemorySessionStore();
    const nowRef = { value: 1_700_000_000_000 };
    const service = new AuthService(
      {
        jwtPrivateKeyPem,
        jwtPublicKeyPem,
        accessTokenTtlSeconds: 900,
        sessionTtlSeconds: 120,
        maxLoginAttempts: 5,
        loginAttemptWindowMs: 60_000,
        bootstrapAdminConfigured: options?.bootstrapConfigured ?? false,
      },
      userStore,
      sessionStore,
      () => nowRef.value,
    );
    return { service, userStore, sessionStore, nowRef };
  }

  it('creates and lists DB-backed users with analytics fields', async () => {
    const { service } = await createService();

    const created = await service.createUser({
      username: 'alice',
      password: 's3cret-pass',
      createdBy: 'setup',
    });

    expect(created.username).toBe('alice');
    expect(created.active).toBe(true);
    expect(created.createdBy).toBe('setup');
    expect(created.lastLoginAt).toBeNull();

    const users = await service.listUsers();
    expect(users).toHaveLength(1);
    expect(users[0]?.activeSessions).toBe(0);
  });

  it('rejects login for a deactivated user with a typed error', async () => {
    const { service } = await createService();
    await service.createUser({ username: 'alice', password: 's3cret-pass', createdBy: 'setup' });
    await service.deactivateUser('alice');

    await expect(service.login('alice', 's3cret-pass')).rejects.toBeInstanceOf(UserInactiveError);
  });

  it('deactivates and reactivates a user without deleting history', async () => {
    const { service } = await createService();
    await service.createUser({ username: 'alice', password: 's3cret-pass', createdBy: 'setup' });

    await service.deactivateUser('alice');
    let users = await service.listUsers();
    expect(users[0]?.active).toBe(false);

    await service.reactivateUser('alice');
    users = await service.listUsers();
    expect(users[0]?.active).toBe(true);
  });

  it('refuses to hard-delete a user that still has active sessions', async () => {
    const { service } = await createService();
    await service.createUser({ username: 'alice', password: 's3cret-pass', createdBy: 'setup' });
    await service.login('alice', 's3cret-pass');

    await expect(service.deleteUser('alice')).rejects.toBeInstanceOf(UserHasActiveSessionsError);
  });

  it('tracks active sessions and last login in user analytics', async () => {
    const { service, nowRef } = await createService();
    await service.createUser({ username: 'alice', password: 's3cret-pass', createdBy: 'setup' });

    await service.login('alice', 's3cret-pass');
    nowRef.value += 1_000;
    await service.login('alice', 's3cret-pass');

    const users = await service.listUsers();
    expect(users[0]?.activeSessions).toBe(2);
    expect(users[0]?.lastLoginAt).toBe(1_700_000_001_000);
  });

  it('reports first-boot setup eligibility only when no users exist and no bootstrap env is configured', async () => {
    const { service } = await createService();
    expect(await service.getSetupStatus()).toEqual({ eligible: true, reason: 'not_configured' });

    await service.createUser({ username: 'alice', password: 's3cret-pass', createdBy: 'setup' });
    expect(await service.getSetupStatus()).toEqual({ eligible: false, reason: 'users_exist' });

    const bootstrap = await createService({ bootstrapConfigured: true });
    expect(await bootstrap.service.getSetupStatus()).toEqual({
      eligible: false,
      reason: 'bootstrap_env_configured',
    });
  });

  it('allows only one concurrent first-boot setup winner', async () => {
    const { service } = await createService();

    const attempts = await Promise.allSettled([
      service.setupFirstAdmin({ username: 'alice', password: 's3cret-pass' }),
      service.setupFirstAdmin({ username: 'bob', password: 's3cret-pass' }),
    ]);

    const fulfilled = attempts.filter((result) => result.status === 'fulfilled');
    const rejected = attempts.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      SetupAlreadyConfiguredError,
    );
    expect(await service.listUsers()).toHaveLength(1);
  });

  it('throws UserNotFoundError for updates on an unknown user', async () => {
    const { service } = await createService();
    await expect(service.deactivateUser('missing')).rejects.toBeInstanceOf(UserNotFoundError);
  });

  it('backfills admin on an orphaned repo (no roles at all) to the bootstrap admin', async () => {
    const { service } = await createService();
    await service.createUser({
      username: 'hemiblade',
      password: 's3cret-pass',
      createdBy: 'setup',
    });

    const assignment = await service.backfillOrphanedRepoAdmin('analytics', 'hemiblade');

    expect(assignment).toMatchObject({ username: 'hemiblade', repoId: 'analytics', role: 'admin' });
    expect(await service.getRepoRole('hemiblade', 'analytics')).toBe('admin');
  });

  it('does nothing (returns null) for a repo that already has at least one role assigned', async () => {
    const { service } = await createService();
    await service.createUser({
      username: 'hemiblade',
      password: 's3cret-pass',
      createdBy: 'setup',
    });
    await service.createUser({ username: 'alice', password: 's3cret-pass', createdBy: 'setup' });
    await service.grantRepoRole({
      username: 'alice',
      repoId: 'analytics',
      role: 'admin',
      grantedBy: 'repo-bootstrap',
    });

    const assignment = await service.backfillOrphanedRepoAdmin('analytics', 'hemiblade');

    expect(assignment).toBeNull();
    expect(await service.getRepoRole('hemiblade', 'analytics')).toBeNull();
    expect(await service.getRepoRole('alice', 'analytics')).toBe('admin');
  });
});
