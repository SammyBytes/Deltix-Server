import { describe, expect, it } from 'bun:test';
import { AuthService } from '../../../src/contexts/auth/auth.service';
import { hashPassword } from '../../../src/contexts/auth/password-authenticator';
import type { SessionStore } from '../../../src/contexts/auth/session-store';
import type { UserRecord, UserStore } from '../../../src/contexts/auth/user-store';
import { generateTestJwtKeypairPem } from '../../fixtures/license-fixtures';

function inMemorySessionStore(): SessionStore {
  const sessions = new Map<string, { username: string; createdAt: number; expiresAt: number }>();
  return {
    async create(refreshToken, username, expiresAt) {
      sessions.set(refreshToken, { username, createdAt: Date.now(), expiresAt });
    },
    async get(refreshToken) {
      return sessions.get(refreshToken) ?? null;
    },
    async touch(refreshToken, expiresAt) {
      const existing = sessions.get(refreshToken);
      if (existing) existing.expiresAt = expiresAt;
    },
    async revoke(refreshToken) {
      sessions.delete(refreshToken);
    },
    async countActiveSessionsForUser(username, now) {
      let total = 0;
      for (const session of sessions.values()) {
        if (session.username === username && session.expiresAt >= now) total += 1;
      }
      return total;
    },
  };
}

function inMemoryUserStore(user: UserRecord): UserStore {
  const users = new Map([[user.username, user]]);
  return {
    async init() {},
    async count() {
      return users.size;
    },
    async list() {
      return Array.from(users.values());
    },
    async getByUsername(username) {
      return users.get(username) ?? null;
    },
    async create(record) {
      users.set(record.username, record);
    },
    async setActive(username, active) {
      const found = users.get(username);
      if (!found) return false;
      users.set(username, { ...found, active });
      return true;
    },
    async delete(username) {
      return users.delete(username);
    },
    async updateLastLogin(username, lastLoginAt) {
      const found = users.get(username);
      if (!found) return false;
      users.set(username, { ...found, lastLoginAt });
      return true;
    },
    async tryCreateFirstUser(record) {
      if (users.size > 0) return false;
      users.set(record.username, record);
      return true;
    },
    async legacyUsers() {
      return [];
    },
    async getRepoRole() {
      return null;
    },
    async listRepoRoles() {
      return [];
    },
    async upsertRepoRole() {},
    async deleteRepoRole() {
      return false;
    },
  };
}

describe('auth concurrency (real parallel requests, no fakes for timing)', () => {
  it('rate limiter blocks concurrent login floods beyond the configured max, even under real Promise.all concurrency', async () => {
    const { privateKeyPem: jwtPrivateKeyPem, publicKeyPem: jwtPublicKeyPem } =
      generateTestJwtKeypairPem();
    const passwordHash = await hashPassword('s3cret-pass');
    const service = new AuthService(
      {
        jwtPrivateKeyPem,
        jwtPublicKeyPem,
        accessTokenTtlSeconds: 900,
        sessionTtlSeconds: 120,
        maxLoginAttempts: 5,
        loginAttemptWindowMs: 60_000,
        bootstrapAdminConfigured: false,
      },
      inMemoryUserStore({
        username: 'alice',
        passwordHash,
        createdAt: 0,
        createdBy: 'seed',
        active: true,
        lastLoginAt: null,
      }),
      inMemorySessionStore(),
    );

    const attempts = Array.from({ length: 20 }, () =>
      service.login('alice', 'wrong-password').then(
        () => ({ ok: true }),
        (err: Error) => ({ ok: false, name: err.name }),
      ),
    );

    const results = await Promise.all(attempts);
    const rateLimited = results.filter(
      (r): r is { ok: false; name: string } =>
        !r.ok && 'name' in r && r.name === 'TooManyLoginAttemptsError',
    );
    const invalidCreds = results.filter(
      (r): r is { ok: false; name: string } =>
        !r.ok && 'name' in r && r.name === 'InvalidCredentialsError',
    );
    expect(invalidCreds.length).toBe(5);
    expect(rateLimited.length).toBe(15);
  });

  it('session store handles concurrent keep-alive calls on the same session without corrupting its expiry', async () => {
    const { privateKeyPem: jwtPrivateKeyPem, publicKeyPem: jwtPublicKeyPem } =
      generateTestJwtKeypairPem();
    const passwordHash = await hashPassword('s3cret-pass');
    const service = new AuthService(
      {
        jwtPrivateKeyPem,
        jwtPublicKeyPem,
        accessTokenTtlSeconds: 900,
        sessionTtlSeconds: 120,
        maxLoginAttempts: 100,
        loginAttemptWindowMs: 60_000,
        bootstrapAdminConfigured: false,
      },
      inMemoryUserStore({
        username: 'alice',
        passwordHash,
        createdAt: 0,
        createdBy: 'seed',
        active: true,
        lastLoginAt: null,
      }),
      inMemorySessionStore(),
    );

    const { refreshToken } = await service.login('alice', 's3cret-pass');
    await Promise.all(Array.from({ length: 10 }, () => service.keepAlive(refreshToken)));
    await expect(service.assertSessionActive(refreshToken)).resolves.toBeUndefined();
  });
});
