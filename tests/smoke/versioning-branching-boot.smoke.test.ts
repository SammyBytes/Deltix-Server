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
  const repoPath = await mkdtemp(join(tmpdir(), 'deltix-dolt-repo-versioning-branch-smoke-'));
  await $`dolt config --global --add user.name deltix-test`.quiet().nothrow();
  await $`dolt config --global --add user.email deltix-test@example.com`.quiet().nothrow();
  await $`dolt --data-dir ${repoPath} init`.quiet();
  return repoPath;
}

describe('versioning branching boot smoke test', () => {
  let licenseRepoPath: string;
  let doltReposRootPath: string;
  let proc: ReturnType<typeof Bun.spawn>;
  let httpPort: number;
  let accessToken: string;

  beforeAll(async () => {
    licenseRepoPath = await initTempDoltRepo();
    doltReposRootPath = await mkdtemp(join(tmpdir(), 'deltix-versioning-branch-smoke-repos-'));
    const sessionDbPath = join(
      await mkdtemp(join(tmpdir(), 'deltix-branch-sessions-')),
      'sessions.db',
    );
    const userDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-branch-users-')), 'users.db');
    const ticketDbPath = join(
      await mkdtemp(join(tmpdir(), 'deltix-branch-tickets-')),
      'tickets.db',
    );
    const jobDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-branch-jobs-')), 'jobs.db');
    const repoDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-branch-repos-')), 'repos.db');
    const nasSimPath = await mkdtemp(join(tmpdir(), 'deltix-branch-nas-sim-'));
    const stagingRootPath = await mkdtemp(join(tmpdir(), 'deltix-branch-staging-'));
    httpPort = 25000 + Math.floor(Math.random() * 5000);

    const certDir = await mkdtemp(join(tmpdir(), 'deltix-grpc-certs-versioning-branch-'));
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

  it('provisions a repo and performs branch lifecycle operations over real HTTP against a real Dolt repo', async () => {
    const provisionRes = await fetch(`http://127.0.0.1:${httpPort}/api/v1/versioning/repos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: ['Bearer ', accessToken].join(''),
      },
      body: JSON.stringify({ repoId: 'branch-smoke-repo' }),
    });
    expect(provisionRes.status).toBe(201);
    const { repo } = (await provisionRes.json()) as { repo: { doltPath: string } };

    const createRes = await fetch(
      `http://127.0.0.1:${httpPort}/api/v1/versioning/repos/branch-smoke-repo/branches`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: ['Bearer ', accessToken].join(''),
        },
        body: JSON.stringify({ name: 'feature/smoke' }),
      },
    );
    expect(createRes.status).toBe(201);

    const listRes = await fetch(
      `http://127.0.0.1:${httpPort}/api/v1/versioning/repos/branch-smoke-repo/branches`,
      {
        headers: { authorization: ['Bearer ', accessToken].join('') },
      },
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { branches: Array<{ name: string }> };
    expect(listBody.branches.map((branch) => branch.name)).toContain('feature/smoke');

    const checkoutRes = await fetch(
      `http://127.0.0.1:${httpPort}/api/v1/versioning/repos/branch-smoke-repo/branches/feature%2Fsmoke/checkout`,
      {
        method: 'POST',
        headers: { authorization: ['Bearer ', accessToken].join('') },
      },
    );
    expect(checkoutRes.status).toBe(200);

    const currentRes = await fetch(
      `http://127.0.0.1:${httpPort}/api/v1/versioning/repos/branch-smoke-repo/branches/current`,
      {
        headers: { authorization: ['Bearer ', accessToken].join('') },
      },
    );
    expect(currentRes.status).toBe(200);
    const currentBody = (await currentRes.json()) as { branch: { name: string } };
    expect(currentBody.branch.name).toBe('feature/smoke');

    const deleteCurrentRes = await fetch(
      `http://127.0.0.1:${httpPort}/api/v1/versioning/repos/branch-smoke-repo/branches/feature%2Fsmoke`,
      {
        method: 'DELETE',
        headers: { authorization: ['Bearer ', accessToken].join('') },
      },
    );
    expect(deleteCurrentRes.status).toBe(409);

    const backToMainRes = await fetch(
      `http://127.0.0.1:${httpPort}/api/v1/versioning/repos/branch-smoke-repo/branches/main/checkout`,
      {
        method: 'POST',
        headers: { authorization: ['Bearer ', accessToken].join('') },
      },
    );
    expect(backToMainRes.status).toBe(200);

    const deleteRes = await fetch(
      `http://127.0.0.1:${httpPort}/api/v1/versioning/repos/branch-smoke-repo/branches/feature%2Fsmoke`,
      {
        method: 'DELETE',
        headers: { authorization: ['Bearer ', accessToken].join('') },
      },
    );
    expect(deleteRes.status).toBe(204);

    const finalBranches = await $`dolt --data-dir ${repo.doltPath} branch`.quiet();
    expect(finalBranches.stdout.toString()).toContain('* main');
    expect(finalBranches.stdout.toString()).not.toContain('feature/smoke');
  }, 20000);
});
