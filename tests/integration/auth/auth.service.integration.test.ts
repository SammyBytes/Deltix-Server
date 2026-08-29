import { beforeEach, describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService } from '../../../src/contexts/auth/auth.service';
import {
  InvalidCredentialsError,
  TooManyLoginAttemptsError,
  UserInactiveError,
} from '../../../src/contexts/auth/errors';
import { LibsqlSessionStore } from '../../../src/contexts/auth/libsql-session-store';
import { LibsqlUserStore } from '../../../src/contexts/auth/libsql-user-store';
import { hashPassword } from '../../../src/contexts/auth/password-authenticator';

function generateTestEd25519KeyPairPem() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

describe('auth/auth.service (integration, real libSQL + real JWT signing)', () => {
  let tempDir: string;
  let service: AuthService;
  let now: number;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'deltix-auth-service-test-'));
    const sessionDbPath = join(tempDir, 'sessions.db');
    const userDbPath = join(tempDir, 'users.db');
    const sessionStore = new LibsqlSessionStore(sessionDbPath);
    await sessionStore.init();
    const userStore = new LibsqlUserStore(userDbPath);
    await userStore.init();

    const { privateKeyPem, publicKeyPem } = generateTestEd25519KeyPairPem();
    now = 1_700_000_000_000;
    await userStore.create({
      username: 'alice',
      passwordHash: await hashPassword('s3cret-pass'),
      createdAt: now,
      createdBy: 'seed',
      active: true,
      lastLoginAt: null,
      isGlobalAdmin: false,
      canCreateRepos: true,
    });

    service = new AuthService(
      {
        jwtPrivateKeyPem: privateKeyPem,
        jwtPublicKeyPem: publicKeyPem,
        accessTokenTtlSeconds: 900,
        sessionTtlSeconds: 120,
        maxLoginAttempts: 5,
        loginAttemptWindowMs: 60_000,
        bootstrapAdminConfigured: false,
      },
      userStore,
      sessionStore,
      () => now,
    );
  });

  it('logs in with valid credentials and returns an access token + refresh token', async () => {
    const result = await service.login('alice', 's3cret-pass');

    expect(result.accessToken).toBeString();
    expect(result.refreshToken).toBeString();
    expect(result.expiresInSeconds).toBe(900);
  });

  it('rejects an invalid password', async () => {
    await expect(service.login('alice', 'wrong')).rejects.toThrow(InvalidCredentialsError);
  });

  it('rate-limits repeated failed login attempts for the same username', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(service.login('alice', 'wrong')).rejects.toThrow(InvalidCredentialsError);
    }
    await expect(service.login('alice', 's3cret-pass')).rejects.toThrow(TooManyLoginAttemptsError);
  });

  it('extends the session on keepAlive and revokes it on logout', async () => {
    const { refreshToken } = await service.login('alice', 's3cret-pass');

    now += 100_000;
    await expect(service.keepAlive(refreshToken)).resolves.toBeUndefined();

    now += 100_000;
    await expect(service.assertSessionActive(refreshToken)).resolves.toBeUndefined();

    await service.logout(refreshToken);
    await expect(service.assertSessionActive(refreshToken)).rejects.toThrow();
  });

  it('issues a verifiable access token bound to the logged-in username', async () => {
    const { accessToken } = await service.login('alice', 's3cret-pass');
    const claims = await service.verifyAccessToken(accessToken);

    expect(claims.sub).toBe('alice');
  });

  it('refresh() re-issues an access token and extends the session, without requiring credentials', async () => {
    const { refreshToken } = await service.login('alice', 's3cret-pass');

    now += 100_000;
    const refreshed = await service.refresh(refreshToken);

    expect(refreshed.username).toBe('alice');
    expect(refreshed.accessToken).toBeString();
    expect(refreshed.refreshToken).toBe(refreshToken);

    const claims = await service.verifyAccessToken(refreshed.accessToken);
    expect(claims.sub).toBe('alice');

    now += 100_000;
    await expect(service.assertSessionActive(refreshToken)).resolves.toBeUndefined();
  });

  it('refresh() rejects an expired or unknown session', async () => {
    await expect(service.refresh('nonexistent-token')).rejects.toThrow();
  });

  it('rejects login for a deactivated user', async () => {
    await service.deactivateUser('alice');
    await expect(service.login('alice', 's3cret-pass')).rejects.toBeInstanceOf(UserInactiveError);
  });

  it('supports setupFirstAdmin only once against the real libSQL store', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'deltix-auth-service-empty-'));
    const emptyUserStore = new LibsqlUserStore(join(emptyDir, 'users.db'));
    await emptyUserStore.init();
    const emptySessionStore = new LibsqlSessionStore(join(emptyDir, 'sessions.db'));
    await emptySessionStore.init();
    const { privateKeyPem, publicKeyPem } = generateTestEd25519KeyPairPem();
    const emptyService = new AuthService(
      {
        jwtPrivateKeyPem: privateKeyPem,
        jwtPublicKeyPem: publicKeyPem,
        accessTokenTtlSeconds: 900,
        sessionTtlSeconds: 120,
        maxLoginAttempts: 5,
        loginAttemptWindowMs: 60_000,
        bootstrapAdminConfigured: false,
      },
      emptyUserStore,
      emptySessionStore,
      () => now,
    );

    const first = await emptyService.setupFirstAdmin({ username: 'root', password: 's3cret-pass' });
    expect(first.username).toBe('root');
    await expect(
      emptyService.setupFirstAdmin({ username: 'second', password: 's3cret-pass' }),
    ).rejects.toThrow();

    await rm(emptyDir, { recursive: true, force: true });
  });

  it('login returns canCreateRepos flag from user record', async () => {
    const result = await service.login('alice', 's3cret-pass');
    expect(result.canCreateRepos).toBe(true);
  });

  it('refresh returns canCreateRepos flag from user record', async () => {
    const { refreshToken } = await service.login('alice', 's3cret-pass');
    const refreshed = await service.refresh(refreshToken);
    expect(refreshed.canCreateRepos).toBe(true);
  });

  it('setCanCreateRepos toggles the flag and affects login result', async () => {
    await service.setCanCreateRepos('alice', false);
    const result = await service.login('alice', 's3cret-pass');
    expect(result.canCreateRepos).toBe(false);

    await service.setCanCreateRepos('alice', true);
    const result2 = await service.login('alice', 's3cret-pass');
    expect(result2.canCreateRepos).toBe(true);
  });

  it('canUserCreateRepos returns true for global admins even without the flag', async () => {
    await service.createUser({
      username: 'bob',
      password: 's3cret-pass',
      createdBy: 'test',
      isGlobalAdmin: true,
      canCreateRepos: false,
    });
    expect(await service.canUserCreateRepos('bob')).toBe(true);
  });

  it('canUserCreateRepos returns false when flag is off and not admin', async () => {
    await service.createUser({
      username: 'charlie',
      password: 's3cret-pass',
      createdBy: 'test',
      isGlobalAdmin: false,
      canCreateRepos: false,
    });
    expect(await service.canUserCreateRepos('charlie')).toBe(false);
  });

  it('canUserCreateRepos returns true when flag is on', async () => {
    await service.createUser({
      username: 'dave',
      password: 's3cret-pass',
      createdBy: 'test',
      isGlobalAdmin: false,
      canCreateRepos: true,
    });
    expect(await service.canUserCreateRepos('dave')).toBe(true);
  });

  it('canUserCreateRepos returns false for nonexistent user', async () => {
    expect(await service.canUserCreateRepos('nonexistent')).toBe(false);
  });

  it('listUsers includes canCreateRepos field', async () => {
    const users = await service.listUsers();
    const alice = users.find((u) => u.username === 'alice');
    expect(alice).toBeDefined();
    expect(alice!.canCreateRepos).toBe(true);
  });

  it('setCanCreateRepos throws for nonexistent user', async () => {
    await expect(service.setCanCreateRepos('nonexistent', true)).rejects.toThrow();
  });
});
