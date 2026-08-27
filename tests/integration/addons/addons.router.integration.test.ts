import { beforeEach, describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createAddonsRouter } from '../../../src/contexts/addons/addons.router';
import { LibsqlAddonTrustStore } from '../../../src/contexts/addons/libsql-addon-trust-store';
import { AuthService } from '../../../src/contexts/auth/auth.service';
import { LibsqlSessionStore } from '../../../src/contexts/auth/libsql-session-store';
import { LibsqlUserStore } from '../../../src/contexts/auth/libsql-user-store';
import { hashPassword } from '../../../src/contexts/auth/password-authenticator';
import { generateTestKeypair } from '../../fixtures/license-fixtures';

function generateTestEd25519KeyPairPem() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

describe('addons/addons.router (integration, real HTTP requests via Hono.fetch)', () => {
  const sessionDbPath = `/tmp/deltix-addons-router-sessions-${Date.now()}.db`;
  const trustDbPath = `/tmp/deltix-addons-router-trust-${Date.now()}.db`;
  let app: ReturnType<typeof createAddonsRouter>;
  let authService: AuthService;
  let trustStore: LibsqlAddonTrustStore;
  let userStore: LibsqlUserStore;

  beforeEach(async () => {
    await rm(sessionDbPath, { force: true });
    await rm(sessionDbPath.replace('sessions', 'users'), { force: true });
    await rm(trustDbPath, { force: true });

    const sessionStore = new LibsqlSessionStore(sessionDbPath);
    await sessionStore.init();
    userStore = new LibsqlUserStore(sessionDbPath.replace('sessions', 'users'));
    await userStore.init();
    await userStore.create({
      username: 'alice',
      passwordHash: await hashPassword('s3cret-pass'),
      createdAt: Date.now(),
      createdBy: 'seed',
      active: true,
      lastLoginAt: null,
      isGlobalAdmin: true,
    });
    const { privateKeyPem, publicKeyPem } = generateTestEd25519KeyPairPem();

    authService = new AuthService(
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

    trustStore = new LibsqlAddonTrustStore(trustDbPath);
    await trustStore.init();

    app = createAddonsRouter(authService, trustStore);
  });

  async function loginAndGetAccessToken(): Promise<string> {
    const { accessToken } = await authService.login('alice', 's3cret-pass');
    return accessToken;
  }

  describe('GET /trust', () => {
    it('rejects requests with no Authorization header', async () => {
      const res = await app.request('/trust');
      expect(res.status).toBe(401);
    });

    it('rejects an authenticated non-global-admin with 403', async () => {
      await userStore.create({
        username: 'nonadmin',
        passwordHash: await hashPassword('reader-pass'),
        createdAt: Date.now(),
        createdBy: 'alice',
        active: true,
        lastLoginAt: null,
        isGlobalAdmin: false,
      });
      const { accessToken } = await authService.login('nonadmin', 'reader-pass');

      const res = await app.request('/trust', {
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.status).toBe(403);
    });

    it('lists trusted addons for an authenticated caller', async () => {
      const accessToken = await loginAndGetAccessToken();
      const { publicKeyBase64 } = generateTestKeypair();
      await trustStore.trust({
        addonName: 'my-addon',
        authorPublicKey: publicKeyBase64,
        trustedAt: Date.now(),
        trustedBy: 'alice',
      });

      const res = await app.request('/trust', {
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { trusted: Array<{ addonName: string }> };
      expect(body.trusted).toHaveLength(1);
      expect(body.trusted[0]?.addonName).toBe('my-addon');
    });
  });

  describe('POST /trust', () => {
    it('rejects requests with no Authorization header', async () => {
      const res = await app.request('/trust', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ addonName: 'x', authorPublicKey: 'y' }),
      });
      expect(res.status).toBe(401);
    });

    it('registers a valid addon author public key (copy-paste friendly base64 format)', async () => {
      const accessToken = await loginAndGetAccessToken();
      const { publicKeyBase64 } = generateTestKeypair();

      const res = await app.request('/trust', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ addonName: 'community-tool', authorPublicKey: publicKeyBase64 }),
      });

      expect(res.status).toBe(200);
      const stored = await trustStore.getTrustedKey('community-tool');
      expect(stored?.authorPublicKey).toBe(publicKeyBase64);
      expect(stored?.trustedBy).toBe('alice');
    });

    it('rejects a malformed addonName', async () => {
      const accessToken = await loginAndGetAccessToken();
      const { publicKeyBase64 } = generateTestKeypair();

      const res = await app.request('/trust', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ addonName: 'Not Valid!', authorPublicKey: publicKeyBase64 }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects an authorPublicKey that is not a valid raw 32-byte Ed25519 key', async () => {
      const accessToken = await loginAndGetAccessToken();

      const res = await app.request('/trust', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ addonName: 'community-tool', authorPublicKey: 'not-a-real-key' }),
      });

      expect(res.status).toBe(400);
    });

    it('re-trusting the same addon name replaces the stored key (key rotation)', async () => {
      const accessToken = await loginAndGetAccessToken();
      const first = generateTestKeypair();
      const second = generateTestKeypair();

      await app.request('/trust', {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ addonName: 'rotating', authorPublicKey: first.publicKeyBase64 }),
      });
      await app.request('/trust', {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ addonName: 'rotating', authorPublicKey: second.publicKeyBase64 }),
      });

      const stored = await trustStore.getTrustedKey('rotating');
      expect(stored?.authorPublicKey).toBe(second.publicKeyBase64);
    });
  });

  describe('POST /revoke', () => {
    it('rejects requests with no Authorization header', async () => {
      const res = await app.request('/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ addonName: 'x' }),
      });
      expect(res.status).toBe(401);
    });

    it('revokes a trusted addon key', async () => {
      const accessToken = await loginAndGetAccessToken();
      const { publicKeyBase64 } = generateTestKeypair();
      await trustStore.trust({
        addonName: 'to-revoke',
        authorPublicKey: publicKeyBase64,
        trustedAt: Date.now(),
        trustedBy: 'alice',
      });

      const res = await app.request('/revoke', {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ addonName: 'to-revoke' }),
      });

      expect(res.status).toBe(200);
      expect(await trustStore.getTrustedKey('to-revoke')).toBeNull();
    });

    it('revoking an unknown addon is a safe no-op (still 200)', async () => {
      const accessToken = await loginAndGetAccessToken();

      const res = await app.request('/revoke', {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ addonName: 'never-existed' }),
      });

      expect(res.status).toBe(200);
    });
  });
});
