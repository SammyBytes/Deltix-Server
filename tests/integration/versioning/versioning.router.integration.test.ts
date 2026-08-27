import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { AuthService } from '../../../src/contexts/auth/auth.service';
import { LibsqlSessionStore } from '../../../src/contexts/auth/libsql-session-store';
import { hashPassword } from '../../../src/contexts/auth/password-authenticator';
import { LibsqlRepoStore } from '../../../src/contexts/versioning/libsql-repo-store';
import { RepoProvisioningService } from '../../../src/contexts/versioning/repo-provisioning.service';
import { createVersioningRouter } from '../../../src/contexts/versioning/versioning.router';

function generateTestEd25519KeyPairPem() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

describe('versioning/versioning.router (integration, real HTTP requests via Hono.fetch)', () => {
  const sessionDbPath = `/tmp/deltix-versioning-router-sessions-${Date.now()}.db`;
  const repoDbPath = `/tmp/deltix-versioning-router-repos-${Date.now()}.db`;
  let app: ReturnType<typeof createVersioningRouter>;
  let authService: AuthService;

  beforeEach(async () => {
    await rm(sessionDbPath, { force: true });
    await rm(repoDbPath, { force: true });

    const sessionStore = new LibsqlSessionStore(sessionDbPath);
    await sessionStore.init();
    const { privateKeyPem, publicKeyPem } = generateTestEd25519KeyPairPem();

    authService = new AuthService(
      {
        users: [{ username: 'alice', passwordHash: await hashPassword('s3cret-pass') }],
        jwtPrivateKeyPem: privateKeyPem,
        jwtPublicKeyPem: publicKeyPem,
        accessTokenTtlSeconds: 900,
        sessionTtlSeconds: 120,
        maxLoginAttempts: 5,
        loginAttemptWindowMs: 60_000,
      },
      sessionStore,
    );

    const repoStore = new LibsqlRepoStore(repoDbPath);
    await repoStore.init();
    // No real `dolt` binary here — this suite is about the HTTP/auth
    // contract, not Dolt itself (covered by the versioning integration
    // suite with the real binary).
    const runDoltInit = mock(async () => {});
    const provisioningService = new RepoProvisioningService(
      repoStore,
      runDoltInit,
      '/tmp/dolt-repos',
    );

    app = createVersioningRouter(authService, provisioningService);
  });

  async function loginAndGetAccessToken(): Promise<string> {
    const { accessToken } = await authService.login('alice', 's3cret-pass');
    return accessToken;
  }

  describe('POST /repos', () => {
    it('rejects requests with no Authorization header', async () => {
      const res = await app.request('/repos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repoId: 'demo-repo' }),
      });
      expect(res.status).toBe(401);
    });

    it('provisions a repo for an authenticated user', async () => {
      const token = await loginAndGetAccessToken();

      const res = await app.request('/repos', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ repoId: 'demo-repo' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.repo.repoId).toBe('demo-repo');
      expect(body.repo.createdBy).toBe('alice');
    });

    it('rejects an invalid repoId with 400', async () => {
      const token = await loginAndGetAccessToken();

      const res = await app.request('/repos', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ repoId: '../escape' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 409 when the repoId is already provisioned', async () => {
      const token = await loginAndGetAccessToken();
      await app.request('/repos', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ repoId: 'demo-repo' }),
      });

      const res = await app.request('/repos', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ repoId: 'demo-repo' }),
      });

      expect(res.status).toBe(409);
    });
  });

  describe('GET /repos', () => {
    it('rejects requests with no Authorization header', async () => {
      const res = await app.request('/repos');
      expect(res.status).toBe(401);
    });

    it('lists provisioned repos for an authenticated user', async () => {
      const token = await loginAndGetAccessToken();
      await app.request('/repos', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ repoId: 'demo-repo' }),
      });

      const res = await app.request('/repos', {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.repos).toHaveLength(1);
    });
  });

  describe('GET /repos/:repoId', () => {
    it('returns 404 for a repo that does not exist', async () => {
      const token = await loginAndGetAccessToken();

      const res = await app.request('/repos/does-not-exist', {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(404);
    });

    it('returns the repo record when it exists', async () => {
      const token = await loginAndGetAccessToken();
      await app.request('/repos', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ repoId: 'demo-repo' }),
      });

      const res = await app.request('/repos/demo-repo', {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.repo.repoId).toBe('demo-repo');
    });
  });
});
