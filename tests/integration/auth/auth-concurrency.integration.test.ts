import { describe, expect, it } from 'bun:test';
import { AuthService } from '../../../src/contexts/auth/auth.service';
import { hashPassword } from '../../../src/contexts/auth/password-authenticator';
import type { SessionStore } from '../../../src/contexts/auth/session-store';
import { generateTestJwtKeypairPem } from '../../fixtures/license-fixtures';

function inMemorySessionStore(): SessionStore {
  const sessions = new Map<string, { refreshToken: string; username: string; expiresAt: number }>();
  return {
    async create(refreshToken, username, expiresAt) {
      sessions.set(refreshToken, { refreshToken, username, expiresAt });
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
  };
}

describe('auth concurrency (real parallel requests, no fakes for timing)', () => {
  it('rate limiter blocks concurrent login floods beyond the configured max, even under real Promise.all concurrency', async () => {
    const { privateKeyPem: jwtPrivateKeyPem, publicKeyPem: jwtPublicKeyPem } =
      generateTestJwtKeypairPem();
    const passwordHash = await hashPassword('s3cret-pass');

    const service = new AuthService(
      {
        users: [{ username: 'alice', passwordHash }],
        jwtPrivateKeyPem,
        jwtPublicKeyPem,
        accessTokenTtlSeconds: 900,
        sessionTtlSeconds: 120,
        maxLoginAttempts: 5,
        loginAttemptWindowMs: 60_000,
      },
      inMemorySessionStore(),
    );

    // Fire 20 concurrent login attempts with a wrong password for the same
    // username. The rate limiter's assertAllowed/recordAttempt pair is
    // synchronous with no `await` in between, so JS run-to-completion
    // semantics make it atomic even without an explicit lock — this test
    // proves that guarantee holds under real concurrent load rather than
    // just asserting it in isolation.
    const attempts = Array.from({ length: 20 }, () =>
      service.login('alice', 'wrong-password').then(
        () => ({ ok: true as const }),
        (err: Error) => ({ ok: false as const, name: err.name }),
      ),
    );

    const results = await Promise.all(attempts);
    const rateLimited = results.filter((r) => !r.ok && r.name === 'TooManyLoginAttemptsError');
    const invalidCreds = results.filter((r) => !r.ok && r.name === 'InvalidCredentialsError');

    // Exactly maxAttempts (5) should get through to the credential check;
    // the rest must be rejected by the limiter — never more than 5 "leak"
    // through due to a race.
    expect(invalidCreds.length).toBe(5);
    expect(rateLimited.length).toBe(15);
  });

  it('session store handles concurrent keep-alive calls on the same session without corrupting its expiry', async () => {
    const { privateKeyPem: jwtPrivateKeyPem, publicKeyPem: jwtPublicKeyPem } =
      generateTestJwtKeypairPem();
    const passwordHash = await hashPassword('s3cret-pass');

    const service = new AuthService(
      {
        users: [{ username: 'alice', passwordHash }],
        jwtPrivateKeyPem,
        jwtPublicKeyPem,
        accessTokenTtlSeconds: 900,
        sessionTtlSeconds: 120,
        maxLoginAttempts: 100,
        loginAttemptWindowMs: 60_000,
      },
      inMemorySessionStore(),
    );

    const { refreshToken } = await service.login('alice', 's3cret-pass');

    const keepAlives = Array.from({ length: 10 }, () => service.keepAlive(refreshToken));
    await Promise.all(keepAlives);

    // The session must still be active after concurrent keep-alives — no
    // exception means no corruption/race left it in a revoked/invalid state.
    await expect(service.assertSessionActive(refreshToken)).resolves.toBeUndefined();
  });
});
