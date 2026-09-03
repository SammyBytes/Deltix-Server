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
    // A later commit creates `orders`, then a subsequent one drops it --
    // reproduces the real-world history shape that broke full re-sync:
    // `dolt schema export` (current schema) can't see a table that no
    // longer exists, so exporting the "add orders" commit used to throw and
    // abort the NDJSON stream mid-response (surfacing client-side as a raw
    // closed-socket error instead of a clean failure).
    await $`${DOLT} --data-dir ${doltRepoPath} sql -q ${'CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT);'}`
      .quiet()
      .nothrow();
    await $`${DOLT} --data-dir ${doltRepoPath} add orders`.quiet().nothrow();
    await $`${DOLT} --data-dir ${doltRepoPath} commit -m ${'add orders'} ${authorArg}`
      .quiet()
      .nothrow();
    await $`${DOLT} --data-dir ${doltRepoPath} sql -q ${'DROP TABLE orders;'}`.quiet().nothrow();
    await $`${DOLT} --data-dir ${doltRepoPath} add -A`.quiet().nothrow();
    await $`${DOLT} --data-dir ${doltRepoPath} commit -m ${'drop orders'} ${authorArg}`
      .quiet()
      .nothrow();
    // A rename commit reproduces a second, related history shape: `dolt diff
    // --name-only` reports a renamed table under its OLD name, but that old
    // name doesn't exist `AS OF` the rename commit either (only the new name
    // does) -- so a naive "AS OF <old-name>" lookup fails just like the
    // dropped-table case above, even though the table itself wasn't dropped.
    await $`${DOLT} --data-dir ${doltRepoPath} sql -q ${'CREATE TABLE invoices (id INT PRIMARY KEY, total INT);'}`
      .quiet()
      .nothrow();
    await $`${DOLT} --data-dir ${doltRepoPath} add invoices`.quiet().nothrow();
    await $`${DOLT} --data-dir ${doltRepoPath} commit -m ${'add invoices'} ${authorArg}`
      .quiet()
      .nothrow();
    await $`${DOLT} --data-dir ${doltRepoPath} sql -q ${'RENAME TABLE invoices TO bills;'}`
      .quiet()
      .nothrow();
    await $`${DOLT} --data-dir ${doltRepoPath} add -A`.quiet().nothrow();
    await $`${DOLT} --data-dir ${doltRepoPath} commit -m ${'rename invoices to bills'} ${authorArg}`
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
    // the init commit (empty diff) is not exported; the five real ones are:
    // add customers, add orders, drop orders, add invoices, rename invoices to bills.
    expect(commits.length).toBe(5);
    const first = commits[0] as { tables: { name: string; schema: string; data: string }[] };
    expect(first.tables[0]?.schema).toMatch(/CREATE TABLE/i);
    expect(first.tables[0]?.data).toContain('Ana');
  }, 15000);

  it("exports a commit's schema even for a table dropped in a later commit", async () => {
    // Regression test: `dolt schema export` only sees the CURRENT schema, so
    // exporting the "add orders" commit used to throw "table not found" once
    // a later commit dropped `orders` -- aborting the whole NDJSON stream
    // mid-response instead of returning a clean result. The schema must be
    // resolved AS OF the commit's own hash, not HEAD's.
    const res2 = await app.request('/repos/export-repo/pull-commits?branch=main', {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(res2.status).toBe(200);
    const text2 = await res2.text();
    const lines2 = text2.split('\n').filter((l) => l.trim());
    const commits2 = lines2.map(
      (l) => JSON.parse(l) as { message: string; tables: { name: string; schema: string }[] },
    );
    const addOrders = commits2.find((c) => c.message === 'add orders');
    expect(addOrders?.tables.some((t) => t.name === 'orders')).toBe(true);
    expect(addOrders?.tables.find((t) => t.name === 'orders')?.schema).toMatch(
      /CREATE TABLE `orders`/i,
    );
    // The drop itself is also exported cleanly (no crash), even though
    // `orders` no longer exists in the current/HEAD schema.
    expect(commits2.some((c) => c.message === 'drop orders')).toBe(true);
  }, 15000);

  it("exports a renamed table's schema under its new name for the commit that renamed it", async () => {
    // Regression test: `dolt diff --name-only` reports a renamed table under
    // its OLD name for the rename commit, but `AS OF <rename-hash>` can only
    // resolve the table by its NEW name -- the old name is already gone at
    // that revision. A naive lookup by the diff-reported name used to throw
    // "table not found" and get silently skipped (or worse, abort the
    // stream), even though the table itself was never dropped.
    const res = await app.request('/repos/export-repo/pull-commits?branch=main', {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text.split('\n').filter((l) => l.trim());
    const commits = lines.map(
      (l) => JSON.parse(l) as { message: string; tables: { name: string; schema: string }[] },
    );
    const rename = commits.find((c) => c.message === 'rename invoices to bills');
    expect(rename?.tables.some((t) => t.name === 'bills')).toBe(true);
    expect(rename?.tables.find((t) => t.name === 'bills')?.schema).toMatch(/CREATE TABLE `bills`/i);
    // The old name is not exported under the rename commit (it doesn't exist
    // AS OF that hash) -- only the new name is.
    expect(rename?.tables.some((t) => t.name === 'invoices')).toBe(false);
  }, 15000);

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

  it('degrades a stale/unreachable from hash to a full re-sync instead of failing', async () => {
    // Simulate a client whose negotiated `from` hash is no longer reachable on
    // the branch (e.g. the branch was rewritten server-side). Dolt rejects that
    // hash ("target commit not found") — the server must not fail the pull;
    // it should export the full history so the client reconciles from scratch.
    const bogusFrom = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const res = await app.request(`/repos/export-repo/pull-commits?branch=main&from=${bogusFrom}`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text.split('\n').filter((l) => l.trim());
    const commits = lines.map((l) => JSON.parse(l) as { message: string; tables: unknown[] });
    // Full history exported (all three real, non-empty commits).
    expect(commits.some((c) => c.message === 'add customers')).toBe(true);
    expect(commits.length).toBe(5);
  }, 15000);

  it('rejects an unauthenticated pull request', async () => {
    const res = await app.request('/repos/export-repo/pull-commits?branch=main');
    expect(res.status).toBe(401);
  });
});
