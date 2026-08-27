import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { AuthService } from '../../../src/contexts/auth/auth.service';
import { LibsqlSessionStore } from '../../../src/contexts/auth/libsql-session-store';
import { LibsqlUserStore } from '../../../src/contexts/auth/libsql-user-store';
import { hashPassword } from '../../../src/contexts/auth/password-authenticator';
import { BranchService } from '../../../src/contexts/versioning/branch.service';
import { LibsqlRepoStore } from '../../../src/contexts/versioning/libsql-repo-store';
import { RepoProvisioningService } from '../../../src/contexts/versioning/repo-provisioning.service';
import { SyncPreferenceService } from '../../../src/contexts/versioning/sync-preference.service';
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
    await rm(sessionDbPath.replace('sessions', 'users'), { force: true });
    await rm(repoDbPath, { force: true });

    const sessionStore = new LibsqlSessionStore(sessionDbPath);
    await sessionStore.init();
    const userStore = new LibsqlUserStore(sessionDbPath.replace('sessions', 'users'));
    await userStore.init();
    await userStore.create({
      username: 'alice',
      passwordHash: await hashPassword('s3cret-pass'),
      createdAt: Date.now(),
      createdBy: 'seed',
      active: true,
      lastLoginAt: null,
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

    const repoStore = new LibsqlRepoStore(repoDbPath);
    await repoStore.init();
    const runDoltInit = mock(async () => {});
    const provisioningService = new RepoProvisioningService(
      repoStore,
      runDoltInit,
      '/tmp/dolt-repos',
    );
    const syncPreferenceService = new SyncPreferenceService(repoStore, async () => [
      {
        tableName: 'orders',
        referencedTableName: 'customers',
        constraintName: 'fk_orders_customers',
      },
    ]);

    const branchService = new BranchService(repoStore, {
      runDoltListBranches: mock(async () => [
        { name: 'main', isCurrent: true },
        { name: 'feature/demo', isCurrent: false },
      ]),
      runDoltCurrentBranch: mock(async () => 'main'),
      runDoltCreateBranch: mock(async () => {}),
      runDoltCheckoutBranch: mock(async () => {}),
      runDoltDeleteBranch: mock(async () => {}),
    });

    app = createVersioningRouter(
      authService,
      provisioningService,
      syncPreferenceService,
      branchService,
    );
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
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
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
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ repoId: '../escape' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 409 when the repoId is already provisioned', async () => {
      const token = await loginAndGetAccessToken();
      await app.request('/repos', {
        method: 'POST',
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ repoId: 'demo-repo' }),
      });

      const res = await app.request('/repos', {
        method: 'POST',
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
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
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ repoId: 'demo-repo' }),
      });

      const res = await app.request('/repos', {
        headers: { authorization: ['Bearer ', token].join('') },
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
        headers: { authorization: ['Bearer ', token].join('') },
      });

      expect(res.status).toBe(404);
    });

    it('returns the repo record when it exists', async () => {
      const token = await loginAndGetAccessToken();
      await app.request('/repos', {
        method: 'POST',
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ repoId: 'demo-repo' }),
      });

      const res = await app.request('/repos/demo-repo', {
        headers: { authorization: ['Bearer ', token].join('') },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.repo.repoId).toBe('demo-repo');
    });
  });

  describe('sync preferences endpoints', () => {
    it('returns null when no preference has been stored yet', async () => {
      const token = await loginAndGetAccessToken();
      await app.request('/repos', {
        method: 'POST',
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ repoId: 'demo-repo' }),
      });

      const res = await app.request('/repos/demo-repo/sync-preferences', {
        headers: { authorization: ['Bearer ', token].join('') },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.preference).toBeNull();
    });

    it('persists per-repo sync preferences when the submitted subset is already FK-closed', async () => {
      const token = await loginAndGetAccessToken();
      await app.request('/repos', {
        method: 'POST',
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ repoId: 'demo-repo' }),
      });

      const res = await app.request('/repos/demo-repo/sync-preferences', {
        method: 'PUT',
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'schema_only', tables: ['customers', 'orders'] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.preference.mode).toBe('schema_only');
      expect(body.preference.requestedTables).toEqual(['customers', 'orders']);
    });

    it('fails closed with 409 when the client excludes FK-required tables', async () => {
      const token = await loginAndGetAccessToken();
      await app.request('/repos', {
        method: 'POST',
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ repoId: 'demo-repo' }),
      });

      const res = await app.request('/repos/demo-repo/sync-preferences', {
        method: 'PUT',
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'schema_and_data', tables: ['orders'] }),
      });

      expect(res.status).toBe(409);
    });

    it('provides a dry-run preview of the FK closure without persisting it', async () => {
      const token = await loginAndGetAccessToken();
      await app.request('/repos', {
        method: 'POST',
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ repoId: 'demo-repo' }),
      });

      const res = await app.request('/repos/demo-repo/sync-preferences/dry-run', {
        method: 'POST',
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'schema_only', tables: ['orders'] }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain('FK dependencies');
    });
  });

  describe('branch endpoints', () => {
    it('lists branches for an authenticated user', async () => {
      const token = await loginAndGetAccessToken();
      await app.request('/repos', {
        method: 'POST',
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ repoId: 'demo-repo' }),
      });

      const res = await app.request('/repos/demo-repo/branches', {
        headers: { authorization: ['Bearer ', token].join('') },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.branches).toHaveLength(2);
    });

    it('creates a branch for an authenticated user', async () => {
      const token = await loginAndGetAccessToken();
      await app.request('/repos', {
        method: 'POST',
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ repoId: 'demo-repo' }),
      });

      const res = await app.request('/repos/demo-repo/branches', {
        method: 'POST',
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'feature/demo' }),
      });

      expect(res.status).toBe(201);
    });

    it('returns the current branch', async () => {
      const token = await loginAndGetAccessToken();
      await app.request('/repos', {
        method: 'POST',
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ repoId: 'demo-repo' }),
      });

      const res = await app.request('/repos/demo-repo/branches/current', {
        headers: { authorization: ['Bearer ', token].join('') },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.branch.name).toBe('main');
    });

    it('checks out a branch', async () => {
      const token = await loginAndGetAccessToken();
      await app.request('/repos', {
        method: 'POST',
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ repoId: 'demo-repo' }),
      });

      const res = await app.request('/repos/demo-repo/branches/feature%2Fdemo/checkout', {
        method: 'POST',
        headers: { authorization: ['Bearer ', token].join('') },
      });

      expect(res.status).toBe(200);
    });

    it('deletes a branch', async () => {
      const token = await loginAndGetAccessToken();
      await app.request('/repos', {
        method: 'POST',
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ repoId: 'demo-repo' }),
      });

      const res = await app.request('/repos/demo-repo/branches/feature%2Fdemo', {
        method: 'DELETE',
        headers: { authorization: ['Bearer ', token].join('') },
      });

      expect(res.status).toBe(204);
    });
  });
});
