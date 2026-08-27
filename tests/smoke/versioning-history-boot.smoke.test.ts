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

const ENTRYPOINT = join(import.meta.dir, '..', '..', 'src', 'index.ts');

async function initTempDoltRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'deltix-dolt-repo-versioning-history-smoke-'));
  await $`dolt config --global --add user.name deltix-test`.quiet().nothrow();
  await $`dolt config --global --add user.email deltix-test@example.com`.quiet().nothrow();
  await $`dolt --data-dir ${repoPath} init`.quiet();
  return repoPath;
}

describe('versioning history boot smoke test', () => {
  let licenseRepoPath: string;
  let doltReposRootPath: string;
  let proc: ReturnType<typeof Bun.spawn>;
  let httpPort: number;
  let accessToken: string;

  beforeAll(async () => {
    licenseRepoPath = await initTempDoltRepo();
    doltReposRootPath = await mkdtemp(join(tmpdir(), 'deltix-versioning-history-smoke-repos-'));
    const sessionDbPath = join(
      await mkdtemp(join(tmpdir(), 'deltix-history-sessions-')),
      'sessions.db',
    );
    const userDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-history-users-')), 'users.db');
    const ticketDbPath = join(
      await mkdtemp(join(tmpdir(), 'deltix-history-tickets-')),
      'tickets.db',
    );
    const jobDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-history-jobs-')), 'jobs.db');
    const repoDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-history-repos-')), 'repos.db');
    const nasSimPath = await mkdtemp(join(tmpdir(), 'deltix-history-nas-sim-'));
    const stagingRootPath = await mkdtemp(join(tmpdir(), 'deltix-history-staging-'));
    httpPort = 26000 + Math.floor(Math.random() * 5000);

    const certDir = await mkdtemp(join(tmpdir(), 'deltix-grpc-certs-versioning-history-'));
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
        DELTIX_GRPC_PORT: '55051',
        HTTP_PORT: String(httpPort),
        LOG_PRETTY: 'false',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    await new Promise((resolve) => setTimeout(resolve, 1500));

    try {
      const loginRes = await fetch(`http://127.0.0.1:${httpPort}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 's3cret-pass' }),
      });
      const loginBody = (await loginRes.json()) as { accessToken: string };
      accessToken = loginBody.accessToken;
    } catch {
      const stderr = await new Response(proc.stderr).text();
      const stdout = await new Response(proc.stdout).text();
      throw new Error(`boot failed before login\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
    }
  });

  afterAll(async () => {
    proc.kill();
    await rm(licenseRepoPath, { recursive: true, force: true });
    await rm(doltReposRootPath, { recursive: true, force: true });
  });

  it('exposes log and diff endpoints backed by real dolt history tables', async () => {
    const repoId = 'history-smoke-repo';
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
      body: JSON.stringify({ name: 'feature/history' }),
    });
    await fetch(
      `http://127.0.0.1:${httpPort}/api/v1/versioning/repos/${repoId}/branches/feature%2Fhistory/checkout`,
      {
        method: 'POST',
        headers: { authorization: authHeader },
      },
    );
    await $`dolt --data-dir ${repo.doltPath} sql -q ${"update items set value='changed' where id=1; insert into items values (2,'added');"}`.quiet();
    await $`dolt --data-dir ${repo.doltPath} add -A`.quiet();
    await $`dolt --data-dir ${repo.doltPath} commit -m feature-change`.quiet();

    const logRes = await fetch(
      `http://127.0.0.1:${httpPort}/api/v1/versioning/repos/${repoId}/log?branch=feature%2Fhistory&limit=5`,
      {
        headers: { authorization: authHeader },
      },
    );
    expect(logRes.status).toBe(200);
    const logBody = (await logRes.json()) as {
      log: { commits: Array<{ message: string; parents: string[] }> };
    };
    expect(logBody.log.commits[0]?.message).toBe('feature-change');
    expect(logBody.log.commits[0]?.parents.length).toBeGreaterThanOrEqual(1);

    const diffRes = await fetch(
      `http://127.0.0.1:${httpPort}/api/v1/versioning/repos/${repoId}/diff?from=main&to=feature%2Fhistory`,
      {
        headers: { authorization: authHeader },
      },
    );
    expect(diffRes.status).toBe(200);
    const diffBody = (await diffRes.json()) as {
      diff: { tables: Array<{ table: string; changes: Array<{ diffType: string }> }> };
    };
    expect(diffBody.diff.tables[0]?.table).toBe('items');
    expect(diffBody.diff.tables[0]?.changes.map((change) => change.diffType)).toEqual([
      'modified',
      'added',
    ]);
  }, 30000);
});
