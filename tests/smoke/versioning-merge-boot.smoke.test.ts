import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { hashPassword } from '../../src/contexts/auth/password-authenticator';
import {
  buildDefaultPayload,
  generateTestJwtKeypairPem,
  generateTestKeypair,
  signLicensePayload,
} from '../fixtures/license-fixtures';
import { generateSelfSignedCert } from '../fixtures/tls-fixtures';
import { waitForServerReady } from '../helpers/wait-for-server';

const ENTRYPOINT = join(import.meta.dir, '..', '..', 'src', 'index.ts');

async function initTempDoltRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'deltix-dolt-repo-versioning-merge-smoke-'));
  await $`dolt config --global --add user.name deltix-test`.quiet().nothrow();
  await $`dolt config --global --add user.email deltix-test@example.com`.quiet().nothrow();
  await $`dolt --data-dir ${repoPath} init`.quiet();
  return repoPath;
}

describe('versioning merge boot smoke test', () => {
  let licenseRepoPath: string;
  let doltReposRootPath: string;
  let proc: ReturnType<typeof Bun.spawn>;
  let httpPort: number;
  let accessToken: string;

  beforeAll(async () => {
    licenseRepoPath = await initTempDoltRepo();
    doltReposRootPath = await mkdtemp(join(tmpdir(), 'deltix-versioning-merge-smoke-repos-'));
    const sessionDbPath = join(
      await mkdtemp(join(tmpdir(), 'deltix-merge-sessions-')),
      'sessions.db',
    );
    const userDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-merge-users-')), 'users.db');
    const ticketDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-merge-tickets-')), 'tickets.db');
    const jobDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-merge-jobs-')), 'jobs.db');
    const repoDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-merge-repos-')), 'repos.db');
    const nasSimPath = await mkdtemp(join(tmpdir(), 'deltix-merge-nas-sim-'));
    const stagingRootPath = await mkdtemp(join(tmpdir(), 'deltix-merge-staging-'));
    httpPort = 26000 + Math.floor(Math.random() * 5000);

    const certDir = await mkdtemp(join(tmpdir(), 'deltix-grpc-certs-versioning-merge-'));
    const { certPath, keyPath } = await generateSelfSignedCert(certDir);

    const { publicKeyBase64, privateKeyPem } = generateTestKeypair();
    const licenseKey = signLicensePayload(buildDefaultPayload(), privateKeyPem);
    const { privateKeyPem: jwtPrivateKeyPem, publicKeyPem: jwtPublicKeyPem } =
      generateTestJwtKeypairPem();
    const localUsers = JSON.stringify([
      { username: 'alice', passwordHash: await hashPassword('s3cret-pass') },
    ]);

    proc = Bun.spawn(['bun', 'run', ENTRYPOINT], {
      env: {
        ...process.env,
        DELTIX_LICENSE_PUBLIC_KEY: publicKeyBase64,
        DELTIX_LICENSE_KEY: licenseKey,
        DELTIX_DOLT_REPO_PATH: licenseRepoPath,
        DELTIX_CLOCK_TOLERANCE_MS: '5000',
        DELTIX_JWT_PRIVATE_KEY: jwtPrivateKeyPem,
        DELTIX_JWT_PUBLIC_KEY: jwtPublicKeyPem,
        DELTIX_LOCAL_USERS: localUsers,
        DELTIX_BOOTSTRAP_ADMIN_USERNAME: 'alice',
        DELTIX_BOOTSTRAP_ADMIN_PASSWORD: 's3cret-pass',
        DELTIX_USER_DB_PATH: userDbPath,
        DELTIX_SESSION_DB_PATH: sessionDbPath,
        DELTIX_TICKET_DB_PATH: ticketDbPath,
        DELTIX_TRANSFER_JOB_DB_PATH: jobDbPath,
        DELTIX_REPO_DB_PATH: repoDbPath,
        DELTIX_DOLT_REPOS_ROOT_PATH: doltReposRootPath,
        DELTIX_NAS_SIM_PATH: nasSimPath,
        DELTIX_STAGING_ROOT_PATH: stagingRootPath,
        DELTIX_NAS_SYNC_POLL_INTERVAL_MS: '150',
        DELTIX_NAS_SYNC_BACKOFF_BASE_MS: '100',
        DELTIX_NAS_SYNC_BACKOFF_MAX_MS: '500',
        DELTIX_GRPC_TLS_CERT_PATH: certPath,
        DELTIX_GRPC_TLS_KEY_PATH: keyPath,
        DELTIX_GRPC_PORT: String(56000 + Math.floor(Math.random() * 2000)),
        HTTP_PORT: String(httpPort),
        LOG_PRETTY: 'false',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    await waitForServerReady(httpPort);

    const loginRes = await fetch(`http://127.0.0.1:${httpPort}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 's3cret-pass' }),
    });
    const loginBody = (await loginRes.json()) as { accessToken: string };
    accessToken = loginBody.accessToken;
  });

  afterAll(async () => {
    proc.kill();
    await rm(licenseRepoPath, { recursive: true, force: true });
    await rm(doltReposRootPath, { recursive: true, force: true });
  });

  it('merges clean branches and translates conflicts into structured JSON while auto-aborting conflicted merges', async () => {
    const repoId = 'merge-smoke-repo';
    const authHeader = ['Bearer ', accessToken].join('');
    const provisionRes = await fetch(`http://127.0.0.1:${httpPort}/api/v1/versioning/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: authHeader },
      body: JSON.stringify({ repoId }),
    });
    expect(provisionRes.status).toBe(201);
    const { repo } = (await provisionRes.json()) as { repo: { doltPath: string } };

    await $`dolt --data-dir ${repo.doltPath} sql -q ${"create table items (id int primary key, value varchar(50)); insert into items values (1,'base');"}`.quiet();
    await $`dolt --data-dir ${repo.doltPath} add -A`.quiet();
    await $`dolt --data-dir ${repo.doltPath} commit -m base`.quiet();

    await fetch(`http://127.0.0.1:${httpPort}/api/v1/versioning/repos/${repoId}/branches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: authHeader },
      body: JSON.stringify({ name: 'feature/clean' }),
    });
    await fetch(
      `http://127.0.0.1:${httpPort}/api/v1/versioning/repos/${repoId}/branches/feature%2Fclean/checkout`,
      {
        method: 'POST',
        headers: { authorization: authHeader },
      },
    );
    await $`dolt --data-dir ${repo.doltPath} sql -q ${"insert into items values (2,'clean');"}`.quiet();
    await $`dolt --data-dir ${repo.doltPath} add -A`.quiet();
    await $`dolt --data-dir ${repo.doltPath} commit -m clean`.quiet();
    await fetch(
      `http://127.0.0.1:${httpPort}/api/v1/versioning/repos/${repoId}/branches/main/checkout`,
      {
        method: 'POST',
        headers: { authorization: authHeader },
      },
    );

    const cleanMergeRes = await fetch(
      `http://127.0.0.1:${httpPort}/api/v1/versioning/repos/${repoId}/merge`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: authHeader },
        body: JSON.stringify({ sourceBranch: 'feature/clean' }),
      },
    );
    expect(cleanMergeRes.status).toBe(200);
    const cleanMergeBody = (await cleanMergeRes.json()) as {
      merge: { status: string; commitHash: string };
    };
    expect(cleanMergeBody.merge.status).toBe('merged');
    expect(cleanMergeBody.merge.commitHash).toBeString();

    await fetch(`http://127.0.0.1:${httpPort}/api/v1/versioning/repos/${repoId}/branches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: authHeader },
      body: JSON.stringify({ name: 'feature/conflict' }),
    });
    await fetch(
      `http://127.0.0.1:${httpPort}/api/v1/versioning/repos/${repoId}/branches/feature%2Fconflict/checkout`,
      {
        method: 'POST',
        headers: { authorization: authHeader },
      },
    );
    await $`dolt --data-dir ${repo.doltPath} sql -q ${"update items set value='theirs' where id=1;"}`.quiet();
    await $`dolt --data-dir ${repo.doltPath} add -A`.quiet();
    await $`dolt --data-dir ${repo.doltPath} commit -m theirs`.quiet();
    await fetch(
      `http://127.0.0.1:${httpPort}/api/v1/versioning/repos/${repoId}/branches/main/checkout`,
      {
        method: 'POST',
        headers: { authorization: authHeader },
      },
    );
    await $`dolt --data-dir ${repo.doltPath} sql -q ${"update items set value='ours' where id=1;"}`.quiet();
    await $`dolt --data-dir ${repo.doltPath} add -A`.quiet();
    await $`dolt --data-dir ${repo.doltPath} commit -m ours`.quiet();

    const conflictRes = await fetch(
      `http://127.0.0.1:${httpPort}/api/v1/versioning/repos/${repoId}/merge`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: authHeader },
        body: JSON.stringify({ sourceBranch: 'feature/conflict' }),
      },
    );
    expect(conflictRes.status).toBe(409);
    const conflictBody = (await conflictRes.json()) as {
      error: string;
      merge: {
        status: string;
        sourceBranch: string;
        targetBranch: string;
        conflicts: Array<{ table: string; count: number }>;
      };
    };
    expect(conflictBody.merge.status).toBe('conflicted');
    expect(conflictBody.merge.sourceBranch).toBe('feature/conflict');
    expect(conflictBody.merge.targetBranch).toBe('main');
    expect(conflictBody.merge.conflicts[0]?.table).toBe('items');

    const status = await $`dolt --data-dir ${repo.doltPath} status`.quiet();
    expect(status.stdout.toString()).toContain('working tree clean');
  }, 30000);
});
