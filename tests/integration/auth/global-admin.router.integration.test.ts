import { beforeEach, describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuthRouter } from '../../../src/contexts/auth/auth.router';
import { AuthService } from '../../../src/contexts/auth/auth.service';
import { LibsqlSessionStore } from '../../../src/contexts/auth/libsql-session-store';
import { LibsqlUserStore } from '../../../src/contexts/auth/libsql-user-store';
import { hashPassword } from '../../../src/contexts/auth/password-authenticator';

/**
 * Global-admin gating for the Admin Web UI's underlying API
 * (`/api/v1/auth/users*`) — this is a distinct privilege from any per-repo
 * `RepoRole` (see versioning.router.ts). Covers the success path (an actual
 * global admin can manage users and grant/revoke the role) as a complement
 * to the 403-on-non-admin coverage in `auth.router.integration.test.ts`.
 */
function generateTestEd25519KeyPairPem() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

describe('auth/auth.router global admin management (integration, real HTTP requests)', () => {
  let app: ReturnType<typeof createAuthRouter>;

  beforeEach(async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'deltix-global-admin-test-'));
    const sessionStore = new LibsqlSessionStore(join(tempDir, 'sessions.db'));
    await sessionStore.init();
    const userStore = new LibsqlUserStore(join(tempDir, 'users.db'));
    await userStore.init();
    const { privateKeyPem, publicKeyPem } = generateTestEd25519KeyPairPem();

    await userStore.create({
      username: 'hemiblade',
      passwordHash: await hashPassword('s3cret-pass'),
      createdAt: Date.now(),
      createdBy: 'setup',
      active: true,
      lastLoginAt: null,
      isGlobalAdmin: true,
      canCreateRepos: true,
    });
    await userStore.create({
      username: 'bob',
      passwordHash: await hashPassword('another-pass'),
      createdAt: Date.now(),
      createdBy: 'hemiblade',
      active: true,
      lastLoginAt: null,
      isGlobalAdmin: false,
      canCreateRepos: true,
    });

    const service = new AuthService(
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
    );

    app = createAuthRouter(service);
  });

  async function loginAs(username: string, password: string) {
    const res = await app.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = (await res.json()) as { accessToken: string; isGlobalAdmin: boolean };
    return body;
  }

  it('POST /login reports isGlobalAdmin: true for a global admin account', async () => {
    const body = await loginAs('hemiblade', 's3cret-pass');
    expect(body.isGlobalAdmin).toBe(true);
  });

  it('a global admin can list users via GET /users', async () => {
    const { accessToken } = await loginAs('hemiblade', 's3cret-pass');

    const res = await app.request('/users', {
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: { username: string; isGlobalAdmin: boolean }[] };
    expect(body.users.map((u) => u.username).sort()).toEqual(['bob', 'hemiblade']);
    expect(body.users.find((u) => u.username === 'bob')?.isGlobalAdmin).toBe(false);
  });

  it('a global admin can grant the global-admin role to another user', async () => {
    const { accessToken } = await loginAs('hemiblade', 's3cret-pass');

    const grantRes = await app.request('/users/bob/global-admin', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(grantRes.status).toBe(200);

    const bobLogin = await loginAs('bob', 'another-pass');
    expect(bobLogin.isGlobalAdmin).toBe(true);
  });

  it('a global admin can revoke the global-admin role from another user', async () => {
    const { accessToken } = await loginAs('hemiblade', 's3cret-pass');
    await app.request('/users/bob/global-admin', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    const revokeRes = await app.request('/users/bob/global-admin', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(revokeRes.status).toBe(200);

    const bobLogin = await loginAs('bob', 'another-pass');
    expect(bobLogin.isGlobalAdmin).toBe(false);
  });

  it('refuses to let the sole remaining global admin revoke their own global-admin role (would lock everyone out)', async () => {
    const { accessToken } = await loginAs('hemiblade', 's3cret-pass');

    const res = await app.request('/users/hemiblade/global-admin', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.status).toBe(409);
    const relogin = await loginAs('hemiblade', 's3cret-pass');
    expect(relogin.isGlobalAdmin).toBe(true);
  });

  it('allows removing global-admin from oneself when another global admin still exists', async () => {
    const { accessToken } = await loginAs('hemiblade', 's3cret-pass');
    await app.request('/users/bob/global-admin', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    const res = await app.request('/users/hemiblade/global-admin', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.status).toBe(200);
    const relogin = await loginAs('hemiblade', 's3cret-pass');
    expect(relogin.isGlobalAdmin).toBe(false);
  });

  it('a global admin can create a new user, who defaults to non-admin', async () => {
    const { accessToken } = await loginAs('hemiblade', 's3cret-pass');

    const res = await app.request('/users', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ username: 'carol', password: 'carolpassword1' }),
    });

    expect(res.status).toBe(201);
    const carolLogin = await loginAs('carol', 'carolpassword1');
    expect(carolLogin.isGlobalAdmin).toBe(false);
  });
});
