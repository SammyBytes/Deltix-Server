import { beforeEach, describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createAuthRouter } from '../../../src/contexts/auth/auth.router';
import { AuthService } from '../../../src/contexts/auth/auth.service';
import { LibsqlSessionStore } from '../../../src/contexts/auth/libsql-session-store';
import { hashPassword } from '../../../src/contexts/auth/password-authenticator';

function generateTestEd25519KeyPairPem() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

describe('auth/auth.router (integration, real HTTP requests via Hono.fetch)', () => {
  const dbPath = `/tmp/deltix-auth-router-test-${Date.now()}.db`;
  let app: ReturnType<typeof createAuthRouter>;

  beforeEach(async () => {
    await rm(dbPath, { force: true });
    const store = new LibsqlSessionStore(dbPath);
    await store.init();
    const { privateKeyPem, publicKeyPem } = generateTestEd25519KeyPairPem();

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

  it('POST /login returns 200 with tokens for valid credentials', async () => {
    const res = await app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 's3cret-pass' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { accessToken: string; refreshToken: string };
    expect(body.accessToken).toBeString();
    expect(body.refreshToken).toBeString();
  });

  it('POST /login sets an httpOnly, SameSite=Strict refresh-token cookie', async () => {
    const res = await app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 's3cret-pass' }),
    });

    const setCookieHeader = res.headers.get('set-cookie') ?? '';
    expect(setCookieHeader).toContain('deltix_refresh_token=');
    expect(setCookieHeader).toContain('HttpOnly');
    expect(setCookieHeader).toContain('SameSite=Strict');
  });

  it('POST /refresh restores a session from the cookie alone (browser reload scenario)', async () => {
    const loginRes = await app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 's3cret-pass' }),
    });
    const setCookieHeader = loginRes.headers.get('set-cookie') ?? '';
    const cookiePair = setCookieHeader.split(';')[0];

    const refreshRes = await app.request('/refresh', {
      method: 'POST',
      headers: { Cookie: cookiePair },
    });

    expect(refreshRes.status).toBe(200);
    const body = (await refreshRes.json()) as { accessToken: string; username: string };
    expect(body.accessToken).toBeString();
    expect(body.username).toBe('alice');
  });

  it('POST /refresh returns 401 when there is no session cookie at all', async () => {
    const res = await app.request('/refresh', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('POST /refresh returns 401 for a revoked (logged-out) session cookie', async () => {
    const loginRes = await app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 's3cret-pass' }),
    });
    const setCookieHeader = loginRes.headers.get('set-cookie') ?? '';
    const cookiePair = setCookieHeader.split(';')[0];
    const { refreshToken } = (await loginRes.json()) as { refreshToken: string };

    await app.request('/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    const refreshRes = await app.request('/refresh', {
      method: 'POST',
      headers: { Cookie: cookiePair },
    });
    expect(refreshRes.status).toBe(401);
  });

  it('POST /login returns 401 for invalid credentials, never leaking why', async () => {
    const res = await app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'wrong' }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain('alice');
  });

  it('POST /login returns 400 for a malformed request body', async () => {
    const res = await app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '' }),
    });

    expect(res.status).toBe(400);
  });

  it('POST /keep-alive extends an active session', async () => {
    const loginRes = await app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 's3cret-pass' }),
    });
    const { refreshToken } = (await loginRes.json()) as { refreshToken: string };

    const res = await app.request('/keep-alive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    expect(res.status).toBe(200);
  });

  it('POST /logout revokes the session so a subsequent keep-alive fails', async () => {
    const loginRes = await app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 's3cret-pass' }),
    });
    const { refreshToken } = (await loginRes.json()) as { refreshToken: string };

    const logoutRes = await app.request('/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    expect(logoutRes.status).toBe(200);

    const keepAliveRes = await app.request('/keep-alive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    expect(keepAliveRes.status).toBe(401);
  });

  it('POST /logout via cookie alone (no body) revokes the session and clears the cookie', async () => {
    const loginRes = await app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 's3cret-pass' }),
    });
    const setCookieHeader = loginRes.headers.get('set-cookie') ?? '';
    const cookiePair = setCookieHeader.split(';')[0];

    const logoutRes = await app.request('/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookiePair },
      body: JSON.stringify({}),
    });
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.headers.get('set-cookie') ?? '').toContain('Max-Age=0');

    const refreshRes = await app.request('/refresh', {
      method: 'POST',
      headers: { Cookie: cookiePair },
    });
    expect(refreshRes.status).toBe(401);
  });
});
