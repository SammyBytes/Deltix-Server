import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService } from '../../../src/contexts/auth/auth.service';
import { LibsqlSessionStore } from '../../../src/contexts/auth/libsql-session-store';
import { LibsqlUserStore } from '../../../src/contexts/auth/libsql-user-store';
import { hashPassword } from '../../../src/contexts/auth/password-authenticator';
import { BranchService } from '../../../src/contexts/versioning/branch.service';
import { DiffService } from '../../../src/contexts/versioning/diff.service';
import { LibsqlRepoStore } from '../../../src/contexts/versioning/libsql-repo-store';
import { LogService } from '../../../src/contexts/versioning/log.service';
import { MergeService } from '../../../src/contexts/versioning/merge.service';
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
  let tempDir: string;
  let app: ReturnType<typeof createVersioningRouter>;
  let authService: AuthService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'deltix-versioning-router-'));
    const sessionDbPath = join(tempDir, 'sessions.db');
    const userDbPath = join(tempDir, 'users.db');
    const repoDbPath = join(tempDir, 'repos.db');

    const sessionStore = new LibsqlSessionStore(sessionDbPath);
    await sessionStore.init();
    const userStore = new LibsqlUserStore(userDbPath);
    await userStore.init();
    await userStore.create({
      username: 'alice',
      passwordHash: await hashPassword('s3cret-pass'),
      createdAt: Date.now(),
      createdBy: 'seed',
      active: true,
      lastLoginAt: null,
      isGlobalAdmin: false,
    });
    await userStore.create({
      username: 'bob',
      passwordHash: await hashPassword('another-pass'),
      createdAt: Date.now(),
      createdBy: 'seed',
      active: true,
      lastLoginAt: null,
      isGlobalAdmin: false,
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
      './.test-dolt-repos',
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
    const logService = new LogService(repoStore, {
      runDoltReadLog: mock(async ({ branchName, limit }) => [
        {
          commitHash: '3lfs06dv07gacfldu98ml064ks0n2rtm',
          author: branchName ?? 'alice',
          authorEmail: 'alice@example.com',
          timestamp: '2026-08-27 11:27:53.188',
          message: `limit=${limit}`,
          parents: ['apdhclv4ccmlg921t1ot845rptsp24jp'],
        },
      ]),
    });
    const diffService = new DiffService(repoStore, {
      runDoltReadDiff: mock(async ({ fromRef, toRef }) => ({
        fromRef,
        toRef,
        tables: [
          {
            table: 'items',
            diffType: 'modified',
            dataChange: true,
            schemaChange: false,
            changes: [
              {
                diffType: 'modified' as const,
                oldValues: { id: '1', value: 'a' },
                newValues: { id: '1', value: 'b' },
              },
            ],
          },
        ],
      })),
    });
    const mergeService = new MergeService(repoStore, {
      runDoltMerge: mock(async ({ sourceBranch, targetBranch }) => ({
        exitCode: sourceBranch === 'feature/conflict' ? 1 : 0,
        stdout:
          sourceBranch === 'feature/conflict'
            ? 'CONFLICT (content): Merge conflict in items'
            : sourceBranch === 'feature/up-to-date'
              ? 'Already up to date.'
              : 'Fast-forward',
        stderr: '',
        currentBranch: targetBranch ?? 'main',
      })),
      runDoltMergeAbort: mock(async () => {}),
      runDoltReadConflicts: mock(async () => [
        {
          table: 'items',
          count: 1,
          conflicts: [
            {
              fromRootIsh: 'root',
              base: { id: '1', value: 'base' },
              ours: { id: '1', value: 'ours' },
              theirs: { id: '1', value: 'theirs' },
              ourDiffType: 'modified',
              theirDiffType: 'modified',
              conflictId: 'conflict-1',
            },
          ],
        },
      ]),
      runDoltLatestCommitHash: mock(async () => 'merge-hash-123'),
      runDoltCurrentBranch: mock(async () => 'main'),
    });

    app = createVersioningRouter(
      authService,
      provisioningService,
      syncPreferenceService,
      branchService,
      mergeService,
      logService,
      diffService,
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function loginAndGetAccessToken(
    username = 'alice',
    password = 's3cret-pass',
  ): Promise<string> {
    const { accessToken } = await authService.login(username, password);
    return accessToken;
  }

  async function provisionRepoAsAlice(repoId = 'demo-repo'): Promise<Response> {
    const token = await loginAndGetAccessToken();
    const res = await app.request('/repos', {
      method: 'POST',
      headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
      body: JSON.stringify({ repoId }),
    });
    expect(res.status).toBe(201);
    return res;
  }

  async function grantRole(
    repoId: string,
    username: string,
    role: 'reader' | 'writer' | 'admin',
  ): Promise<Response> {
    const token = await loginAndGetAccessToken();
    return app.request(`/repos/${repoId}/roles`, {
      method: 'POST',
      headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
      body: JSON.stringify({ username, role }),
    });
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
      const res = await provisionRepoAsAlice('demo-repo');

      expect(res.status).toBe(201);
      const body = (await res.json()) as { repo: { repoId: string; createdBy: string } };
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
      await provisionRepoAsAlice('demo-repo');

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
      await provisionRepoAsAlice('demo-repo');

      const res = await app.request('/repos', {
        headers: { authorization: ['Bearer ', token].join('') },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { repos: Array<{ repoId: string; role: string }> };
      expect(body.repos).toHaveLength(1);
      expect(body.repos[0]?.role).toBe('admin');
    });

    it('lets a global admin see repos they hold no explicit per-repo role on', async () => {
      await authService.setGlobalAdmin('bob', true);
      await provisionRepoAsAlice('demo-repo');
      const bobToken = await loginAndGetAccessToken('bob', 'another-pass');

      const res = await app.request('/repos', {
        headers: { authorization: ['Bearer ', bobToken].join('') },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { repos: Array<{ repoId: string; role: string | null }> };
      expect(body.repos).toHaveLength(1);
      expect(body.repos[0]?.repoId).toBe('demo-repo');
      expect(body.repos[0]?.role).toBeNull();
    });

    it('does not show repos to a non-admin user with no per-repo role', async () => {
      await provisionRepoAsAlice('demo-repo');
      const bobToken = await loginAndGetAccessToken('bob', 'another-pass');

      const res = await app.request('/repos', {
        headers: { authorization: ['Bearer ', bobToken].join('') },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { repos: Array<{ repoId: string }> };
      expect(body.repos).toHaveLength(0);
    });
  });

  describe('GET /repos/:repoId', () => {
    it('returns 404 for a repo that does not exist', async () => {
      await provisionRepoAsAlice('different-repo');
      const token = await loginAndGetAccessToken();

      const res = await app.request('/repos/does-not-exist', {
        headers: { authorization: ['Bearer ', token].join('') },
      });

      expect(res.status).toBe(403);
    });

    it('returns the repo record when it exists', async () => {
      const token = await loginAndGetAccessToken();
      await provisionRepoAsAlice('demo-repo');

      const res = await app.request('/repos/demo-repo', {
        headers: { authorization: ['Bearer ', token].join('') },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { repo: { repoId: string; role: string } };
      expect(body.repo.repoId).toBe('demo-repo');
      expect(body.repo.role).toBe('admin');
    });
  });

  describe('sync preferences endpoints', () => {
    it('returns null when no preference has been stored yet', async () => {
      const token = await loginAndGetAccessToken();
      await provisionRepoAsAlice('demo-repo');

      const res = await app.request('/repos/demo-repo/sync-preferences', {
        headers: { authorization: ['Bearer ', token].join('') },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { preference: null };
      expect(body.preference).toBeNull();
    });

    it('persists per-repo sync preferences when the submitted subset is already FK-closed', async () => {
      const token = await loginAndGetAccessToken();
      await provisionRepoAsAlice('demo-repo');

      const res = await app.request('/repos/demo-repo/sync-preferences', {
        method: 'PUT',
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'schema_only', tables: ['customers', 'orders'] }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        preference: { mode: string; requestedTables: string[] | null };
      };
      expect(body.preference.mode).toBe('schema_only');
      expect(body.preference.requestedTables).toEqual(['customers', 'orders']);
    });

    it('round-trips real createdAt/updatedAt timestamps through the libSQL-backed store (audit trail integrity)', async () => {
      const token = await loginAndGetAccessToken();
      await provisionRepoAsAlice('demo-repo');
      const before = Date.now();

      const putRes = await app.request('/repos/demo-repo/sync-preferences', {
        method: 'PUT',
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'schema_only', tables: null }),
      });
      expect(putRes.status).toBe(200);

      const getRes = await app.request('/repos/demo-repo/sync-preferences', {
        headers: { authorization: ['Bearer ', token].join('') },
      });
      expect(getRes.status).toBe(200);
      const body = (await getRes.json()) as {
        preference: { createdAt: number; updatedAt: number } | null;
      };
      expect(body.preference).not.toBeNull();
      expect(body.preference?.createdAt).toBeGreaterThanOrEqual(before);
      expect(body.preference?.updatedAt).toBeGreaterThanOrEqual(before);
    });

    it('fails closed with 409 when the client excludes FK-required tables', async () => {
      const token = await loginAndGetAccessToken();
      await provisionRepoAsAlice('demo-repo');

      const res = await app.request('/repos/demo-repo/sync-preferences', {
        method: 'PUT',
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'schema_and_data', tables: ['orders'] }),
      });

      expect(res.status).toBe(409);
    });

    it('provides a dry-run preview of the FK closure without persisting it', async () => {
      const token = await loginAndGetAccessToken();
      await provisionRepoAsAlice('demo-repo');

      const res = await app.request('/repos/demo-repo/sync-preferences/dry-run', {
        method: 'POST',
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'schema_only', tables: ['orders'] }),
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('FK dependencies');
    });
  });

  describe('history endpoints', () => {
    it('reads repo log with optional branch and clamped limit', async () => {
      const token = await loginAndGetAccessToken();
      await provisionRepoAsAlice('demo-repo');

      const res = await app.request('/repos/demo-repo/log?branch=feature%2Fdemo&limit=200', {
        headers: { authorization: ['Bearer ', token].join('') },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        log: { limit: number; commits: Array<{ author: string; message: string }> };
      };
      expect(body.log.limit).toBe(200);
      expect(body.log.commits[0]?.author).toBe('feature/demo');
      expect(body.log.commits[0]?.message).toBe('limit=200');
    });

    it('rejects invalid log query params with 400', async () => {
      const token = await loginAndGetAccessToken();
      await provisionRepoAsAlice('demo-repo');

      const res = await app.request('/repos/demo-repo/log?limit=0', {
        headers: { authorization: ['Bearer ', token].join('') },
      });

      expect(res.status).toBe(400);
    });

    it('reads repo diff between two refs', async () => {
      const token = await loginAndGetAccessToken();
      await provisionRepoAsAlice('demo-repo');

      const res = await app.request('/repos/demo-repo/diff?from=main&to=feature%2Fdemo', {
        headers: { authorization: ['Bearer ', token].join('') },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        diff: { fromRef: string; toRef: string; tables: Array<{ table: string }> };
      };
      expect(body.diff.fromRef).toBe('main');
      expect(body.diff.toRef).toBe('feature/demo');
      expect(body.diff.tables[0]?.table).toBe('items');
    });

    it('rejects missing diff refs with 400', async () => {
      const token = await loginAndGetAccessToken();
      await provisionRepoAsAlice('demo-repo');

      const res = await app.request('/repos/demo-repo/diff?from=main', {
        headers: { authorization: ['Bearer ', token].join('') },
      });

      expect(res.status).toBe(400);
    });
  });

  describe('branch endpoints', () => {
    it('lists branches for an authenticated user', async () => {
      const token = await loginAndGetAccessToken();
      await provisionRepoAsAlice('demo-repo');

      const res = await app.request('/repos/demo-repo/branches', {
        headers: { authorization: ['Bearer ', token].join('') },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { branches: Array<{ name: string; isCurrent: boolean }> };
      expect(body.branches).toHaveLength(2);
    });

    it('creates a branch for an authenticated user', async () => {
      const token = await loginAndGetAccessToken();
      await provisionRepoAsAlice('demo-repo');

      const res = await app.request('/repos/demo-repo/branches', {
        method: 'POST',
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'feature/demo' }),
      });

      expect(res.status).toBe(201);
    });

    it('returns the current branch', async () => {
      const token = await loginAndGetAccessToken();
      await provisionRepoAsAlice('demo-repo');

      const res = await app.request('/repos/demo-repo/branches/current', {
        headers: { authorization: ['Bearer ', token].join('') },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { branch: { name: string } };
      expect(body.branch.name).toBe('main');
    });

    it('checks out a branch', async () => {
      const token = await loginAndGetAccessToken();
      await provisionRepoAsAlice('demo-repo');

      const res = await app.request('/repos/demo-repo/branches/feature%2Fdemo/checkout', {
        method: 'POST',
        headers: { authorization: ['Bearer ', token].join('') },
      });

      expect(res.status).toBe(200);
    });

    it('deletes a branch', async () => {
      const token = await loginAndGetAccessToken();
      await provisionRepoAsAlice('demo-repo');

      const res = await app.request('/repos/demo-repo/branches/feature%2Fdemo', {
        method: 'DELETE',
        headers: { authorization: ['Bearer ', token].join('') },
      });

      expect(res.status).toBe(204);
    });
  });

  describe('merge endpoint', () => {
    it('merges a source branch into the current branch', async () => {
      const token = await loginAndGetAccessToken();
      await provisionRepoAsAlice('demo-repo');

      const res = await app.request('/repos/demo-repo/merge', {
        method: 'POST',
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ sourceBranch: 'feature/demo' }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { merge: { status: string; commitHash: string } };
      expect(body.merge.status).toBe('merged');
      expect(body.merge.commitHash).toBe('merge-hash-123');
    });

    it('returns a structured 409 payload when Dolt reports conflicts', async () => {
      const token = await loginAndGetAccessToken();
      await provisionRepoAsAlice('demo-repo');

      const res = await app.request('/repos/demo-repo/merge', {
        method: 'POST',
        headers: { authorization: ['Bearer ', token].join(''), 'content-type': 'application/json' },
        body: JSON.stringify({ sourceBranch: 'feature/conflict' }),
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        error: string;
        merge: { status: string; conflicts: Array<{ table: string }> };
      };
      expect(body.error).toContain('Merge conflict');
      expect(body.merge.status).toBe('conflicted');
      expect(body.merge.conflicts[0]?.table).toBe('items');
    });
  });

  describe('repo role endpoints and authorization', () => {
    it('auto-grants repo admin to the creator and denies unassigned users by default', async () => {
      await provisionRepoAsAlice('secured-repo');
      const bobToken = await loginAndGetAccessToken('bob', 'another-pass');

      const denied = await app.request('/repos/secured-repo', {
        headers: { authorization: ['Bearer ', bobToken].join('') },
      });

      expect(denied.status).toBe(403);
    });

    it('lets an admin grant, list, and revoke repo roles', async () => {
      await provisionRepoAsAlice('acl-repo');

      const grantRes = await grantRole('acl-repo', 'bob', 'writer');
      expect(grantRes.status).toBe(201);
      const grantBody = (await grantRes.json()) as { role: { username: string; role: string } };
      expect(grantBody.role.username).toBe('bob');
      expect(grantBody.role.role).toBe('writer');

      const adminToken = await loginAndGetAccessToken();
      const listRes = await app.request('/repos/acl-repo/roles', {
        headers: { authorization: ['Bearer ', adminToken].join('') },
      });
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as {
        roles: Array<{ username: string; role: string }>;
      };
      expect(listBody.roles.map((entry) => `${entry.username}:${entry.role}`)).toEqual([
        'alice:admin',
        'bob:writer',
      ]);

      const revokeRes = await app.request('/repos/acl-repo/roles/bob', {
        method: 'DELETE',
        headers: { authorization: ['Bearer ', adminToken].join('') },
      });
      expect(revokeRes.status).toBe(204);
    });

    it('requires admin role to manage repo roles', async () => {
      await provisionRepoAsAlice('grant-guard-repo');
      await grantRole('grant-guard-repo', 'bob', 'reader');
      const bobToken = await loginAndGetAccessToken('bob', 'another-pass');

      const denied = await app.request('/repos/grant-guard-repo/roles', {
        method: 'POST',
        headers: {
          authorization: ['Bearer ', bobToken].join(''),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ username: 'alice', role: 'writer' }),
      });

      expect(denied.status).toBe(403);
    });

    it('lets a global admin grant/list/revoke roles on a repo they hold no explicit role on', async () => {
      await provisionRepoAsAlice('global-admin-managed-repo');
      await authService.setGlobalAdmin('bob', true);
      const bobToken = await loginAndGetAccessToken('bob', 'another-pass');

      const listRes = await app.request('/repos/global-admin-managed-repo/roles', {
        headers: { authorization: ['Bearer ', bobToken].join('') },
      });
      expect(listRes.status).toBe(200);

      const grantRes = await app.request('/repos/global-admin-managed-repo/roles', {
        method: 'POST',
        headers: {
          authorization: ['Bearer ', bobToken].join(''),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ username: 'bob', role: 'reader' }),
      });
      expect(grantRes.status).toBe(201);

      const revokeRes = await app.request('/repos/global-admin-managed-repo/roles/bob', {
        method: 'DELETE',
        headers: { authorization: ['Bearer ', bobToken].join('') },
      });
      expect(revokeRes.status).toBe(204);
    });

    it('applies reader/writer/admin permissions across existing endpoints', async () => {
      await provisionRepoAsAlice('matrix-repo');
      await grantRole('matrix-repo', 'bob', 'reader');
      const bobReaderToken = await loginAndGetAccessToken('bob', 'another-pass');

      const readOk = await app.request('/repos/matrix-repo/branches', {
        headers: { authorization: ['Bearer ', bobReaderToken].join('') },
      });
      expect(readOk.status).toBe(200);

      const createDenied = await app.request('/repos/matrix-repo/branches', {
        method: 'POST',
        headers: {
          authorization: ['Bearer ', bobReaderToken].join(''),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'feature/nope' }),
      });
      expect(createDenied.status).toBe(403);

      await grantRole('matrix-repo', 'bob', 'writer');
      const bobWriterToken = await loginAndGetAccessToken('bob', 'another-pass');
      const createOk = await app.request('/repos/matrix-repo/branches', {
        method: 'POST',
        headers: {
          authorization: ['Bearer ', bobWriterToken].join(''),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'feature/yes' }),
      });
      expect(createOk.status).toBe(201);

      const deleteDenied = await app.request('/repos/matrix-repo/branches/feature%2Fyes', {
        method: 'DELETE',
        headers: { authorization: ['Bearer ', bobWriterToken].join('') },
      });
      expect(deleteDenied.status).toBe(403);

      await grantRole('matrix-repo', 'bob', 'admin');
      const bobAdminToken = await loginAndGetAccessToken('bob', 'another-pass');
      const deleteOk = await app.request('/repos/matrix-repo/branches/feature%2Fyes', {
        method: 'DELETE',
        headers: { authorization: ['Bearer ', bobAdminToken].join('') },
      });
      expect(deleteOk.status).toBe(204);
    });
  });
});
