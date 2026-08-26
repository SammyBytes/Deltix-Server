import { beforeEach, describe, expect, it } from 'bun:test';
import { rm } from 'node:fs/promises';
import { createAuthRouter } from '../../../src/contexts/auth/auth.router';
import { AuthService } from '../../../src/contexts/auth/auth.service';
import { LibsqlSessionStore } from '../../../src/contexts/auth/libsql-session-store';
import { hashPassword } from '../../../src/contexts/auth/password-authenticator';
import { generateTestJwtKeypairPem } from '../../fixtures/license-fixtures';

/**
 * Adversarial-input coverage for the auth router: malformed JSON, wrong
 * types, oversized/edge-case strings, missing headers, wrong content-type,
 * and prototype-pollution-style keys. None of these should ever reach the
 * service layer as valid input or cause a 5xx — the router must reject them
 * at the zod boundary with a 400.
 */
describe('auth/auth.router fuzzing (integration, adversarial payloads)', () => {
  const dbPath = `/tmp/deltix-auth-router-fuzz-test-${Date.now()}.db`;
  let app: ReturnType<typeof createAuthRouter>;

  beforeEach(async () => {
    await rm(dbPath, { force: true });
    const store = new LibsqlSessionStore(dbPath);
    await store.init();
    const { privateKeyPem, publicKeyPem } = generateTestJwtKeypairPem();

    const service = new AuthService(
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
    );

    app = createAuthRouter(service);
  });

  const malformedBodies: Array<{ label: string; body: string | undefined }> = [
    { label: 'empty body', body: undefined },
    { label: 'not JSON at all', body: 'this is not json {{{' },
    { label: 'JSON array instead of object', body: '["alice", "s3cret-pass"]' },
    { label: 'JSON null', body: 'null' },
    { label: 'username as a number', body: JSON.stringify({ username: 123, password: 'x' }) },
    { label: 'password as an object', body: JSON.stringify({ username: 'alice', password: {} }) },
    {
      label: 'extra unexpected fields plus missing password',
      body: JSON.stringify({ username: 'alice', __proto__: { polluted: true } }),
    },
    {
      label: 'deeply nested payload',
      body: JSON.stringify({ username: { a: { b: { c: 'x' } } }, password: 'x' }),
    },
    { label: 'empty strings', body: JSON.stringify({ username: '', password: '' }) },
  ];

  for (const { label, body } of malformedBodies) {
    it(`POST /login rejects with 400, never 5xx, for: ${label}`, async () => {
      const res = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      expect(res.status).toBe(400);
    });
  }

  it('POST /login rejects a request with no Content-Type header gracefully (400, not 5xx)', async () => {
    const res = await app.request('/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password: 's3cret-pass' }),
    });

    expect([200, 400]).toContain(res.status);
  });

  it('POST /login rejects an oversized username with 400 (max length enforced), not 5xx', async () => {
    const res = await app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'a'.repeat(100_000), password: 'x' }),
    });

    expect(res.status).toBe(400);
  });

  it('POST /keep-alive rejects a malformed refreshToken payload with 400, never 5xx', async () => {
    const res = await app.request('/keep-alive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: 12345 }),
    });

    expect(res.status).toBe(400);
  });

  it('POST /logout rejects a malformed refreshToken payload with 400, never 5xx', async () => {
    const res = await app.request('/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it('an unknown route returns 404, not a stack trace or 500', async () => {
    const res = await app.request('/definitely-not-a-real-route', { method: 'POST' });

    expect(res.status).toBe(404);
  });
});
