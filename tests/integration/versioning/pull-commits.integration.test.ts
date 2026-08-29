import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { AuthService } from '../../../src/contexts/auth/auth.service';
import { LibsqlSessionStore } from '../../../src/contexts/auth/libsql-session-store';
import { LibsqlUserStore } from '../../../src/contexts/auth/libsql-user-store';
import { hashPassword } from '../../../src/contexts/auth/password-authenticator';
import { CommitExportService } from '../../../src/contexts/versioning/commit-export.service';
import {
  runDoltBranchHead,
  runDoltCommitExport,
  runDoltListRefs,
} from '../../../src/contexts/versioning/dolt-commit-export-cli';
import { LibsqlRepoStore } from '../../../src/contexts/versioning/libsql-repo-store';
import { createVersioningRouter } from '../../../src/contexts/versioning/versioning.router';

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

const doltAvailable =
  (await $`which dolt`
    .quiet()
    .nothrow()
    .then((r) => r.exitCode === 0)) || Boolean(process.env.DELTIX_DOLT_BIN_PATH);
const DOLT = process.env.DELTIX_DOLT_BIN_PATH ?? 'dolt';

describe.if(doltAvailable)('pull-commits export (real dolt, in-process router)', () => {
  let tempDir: string;
  let doltRepoPath: string;
  let app: ReturnType<typeof createVersioningRouter>;
  let aliceToken: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'deltix-pullexp-'));
    doltRepoPath = join(tempDir, 'dolt-repos', 'export-repo');
    await mkdir(doltRepoPath, { recursive: true });
    await $`${DOLT} --data-dir ${doltRepoPath} init --name deltix --email deltix@deltix.local`
      .quiet()
      .nothrow();
    // Two real commits on main.
    await $`${DOLT} --data-dir ${doltRepoPath} sql -q ${"CREATE TABLE customers (id INT PRIMARY KEY, name VARCHAR(50)); INSERT INTO customers VALUES (1,'Ana'),(2,'Beto');"}`
      .quiet()
      .nothrow();
    await $`${DOLT} --data-dir ${doltRepoPath} add customers`.quiet().nothrow();
    const authorArg = '--author=alice <alice@x.com>';
    await $`${DOLT} --data-dir ${doltRepoPath} commit -m ${'add customers'} ${authorArg}`
      .quiet()
      .nothrow();

    const userStore = new LibsqlUserStore(join(tempDir, 'users.db'));
    await userStore.init();
    await userStore.create({
      username: 'alice',
      passwordHash: await hashPassword('s3cret-pass'),
      createdAt: Date.now(),
      createdBy: 'seed',
      active: true,
      lastLoginAt: null,
      isGlobalAdmin: false,
      canCreateRepos: true,
    });
    await userStore.create({
      username: 'bob',
      passwordHash: await hashPassword('s3cret-pass'),
      createdAt: Date.now(),
      createdBy: 'seed',
      active: true,
      lastLoginAt: null,
      isGlobalAdmin: false,
      canCreateRepos: true,
    });
    const sessionStore = new LibsqlSessionStore(join(tempDir, 'sessions.db'));
    await sessionStore.init();
    const { privateKeyPem, publicKeyPem } = keypair();
    const authService = new AuthService(
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

    const repoStore = new LibsqlRepoStore(join(tempDir, 'repos.db'));
    await repoStore.init();
    await repoStore.create({
      repoId: 'export-repo',
      doltPath: doltRepoPath,
      createdAt: Date.now(),
      createdBy: 'alice',
    });
    // alice is admin (creator); bob has no role (must be denied).
    await authService.grantRepoRole({
      username: 'alice',
      repoId: 'export-repo',
      role: 'admin',
      grantedBy: 'seed',
    });

    const exportService = new CommitExportService(
      repoStore,
      runDoltCommitExport,
      runDoltBranchHead,
      runDoltListRefs,
    );
    app = createVersioningRouter(
      authService,
      // provisioning service is unused by these two endpoints; pass a minimal one.
      {
        provision: async () => {
          throw new Error('unused');
        },
        get: (id: string) => repoStore.get(id),
        list: () => repoStore.list(),
        isProvisionable: () => true,
      } as unknown as Parameters<typeof createVersioningRouter>[1],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      exportService,
    );

    const login = await authService.login('alice', 's3cret-pass');
    aliceToken = login.accessToken;
  }, 60000);

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('lists refs for a reader', async () => {
    const res = await app.request('/repos/export-repo/refs', {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { refs: { branch: string; hash: string }[] };
    expect(body.refs.some((r) => r.branch === 'main' && r.hash.length > 0)).toBe(true);
  });

  it('streams pull-commits as NDJSON with the server head header', async () => {
    const res = await app.request('/repos/export-repo/pull-commits?branch=main', {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    expect(res.headers.get('x-deltix-server-head')).toBeTruthy();
    const text = await res.text();
    const lines = text.split('\n').filter((l) => l.trim());
    const commits = lines.map((l) => JSON.parse(l) as { message: string; tables: unknown[] });
    expect(commits.some((c) => c.message === 'add customers')).toBe(true);
    // the init commit (empty diff) is not exported; only the real one.
    expect(commits.length).toBe(1);
    const first = commits[0] as { tables: { name: string; schema: string; data: string }[] };
    expect(first.tables[0]?.schema).toMatch(/CREATE TABLE/i);
    expect(first.tables[0]?.data).toContain('Ana');
  });

  it('excludes commits already at the from hash', async () => {
    const headRes = await app.request('/repos/export-repo/refs', {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    const { refs } = (await headRes.json()) as { refs: { branch: string; hash: string }[] };
    const main = refs.find((r) => r.branch === 'main')!;
    // Pulling from the current head should yield no commits.
    const res = await app.request(`/repos/export-repo/pull-commits?branch=main&from=${main.hash}`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.trim()).toBe('');
  });

  it('rejects an unauthenticated pull request', async () => {
    const res = await app.request('/repos/export-repo/pull-commits?branch=main');
    expect(res.status).toBe(401);
  });
});
