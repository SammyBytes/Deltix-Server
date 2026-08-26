import { beforeEach, describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { AuthService } from '../../../src/contexts/auth/auth.service';
import {
  InvalidCredentialsError,
  TooManyLoginAttemptsError,
} from '../../../src/contexts/auth/errors';
import { LibsqlSessionStore } from '../../../src/contexts/auth/libsql-session-store';
import { hashPassword } from '../../../src/contexts/auth/password-authenticator';

function generateTestEd25519KeyPairPem() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

describe('auth/auth.service (integration, real libSQL + real JWT signing)', () => {
  const dbPath = `/tmp/deltix-auth-service-test-${Date.now()}.db`;
  let service: AuthService;
  let now: number;

  beforeEach(async () => {
    await rm(dbPath, { force: true });
    const store = new LibsqlSessionStore(dbPath);
    await store.init();

    const { privateKeyPem, publicKeyPem } = generateTestEd25519KeyPairPem();
    now = 1_700_000_000_000;
    service = new AuthService(
      {
        users: [{ username: 'alice', passwordHash: await hashPassword('s3cret-pass') }],
        jwtPrivateKeyPem: privateKeyPem,
        jwtPublicKeyPem: publicKeyPem,
        accessTokenTtlSeconds: 900,
        sessionTtlSeconds: 120,
        maxLoginAttempts: 5,
        loginAttemptWindowMs: 60_000,
      },
      store,
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

    now += 100_000; // within the 120s window
    await expect(service.keepAlive(refreshToken)).resolves.toBeUndefined();

    now += 100_000; // would be expired without the keepAlive above
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

    now += 100_000; // within the 120s window
    const refreshed = await service.refresh(refreshToken);

    expect(refreshed.username).toBe('alice');
    expect(refreshed.accessToken).toBeString();
    expect(refreshed.refreshToken).toBe(refreshToken);

    const claims = await service.verifyAccessToken(refreshed.accessToken);
    expect(claims.sub).toBe('alice');

    now += 100_000; // would be expired without the refresh() call above sliding the window
    await expect(service.assertSessionActive(refreshToken)).resolves.toBeUndefined();
  });

  it('refresh() rejects an expired or unknown session', async () => {
    await expect(service.refresh('nonexistent-token')).rejects.toThrow();
  });
});
