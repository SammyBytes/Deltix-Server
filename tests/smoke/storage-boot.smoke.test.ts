import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { hashPassword } from '../../src/contexts/auth/password-authenticator';
import { LibsqlTransferJobStore } from '../../src/contexts/storage/libsql-transfer-job-store';
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
  const repoPath = await mkdtemp(join(tmpdir(), 'deltix-dolt-repo-storage-smoke-'));
  await $`dolt config --global --add user.name deltix-test`.quiet().nothrow();
  await $`dolt config --global --add user.email deltix-test@example.com`.quiet().nothrow();
  const init = await $`dolt --data-dir ${repoPath} init`.quiet().nothrow();
  if (init.exitCode !== 0) {
    throw new Error(`Failed to init test Dolt repo: ${init.stderr.toString()}`);
  }
  return repoPath;
}

describe('storage boot smoke test (real subprocess, real HTTP server, real staging->NAS sync)', () => {
  let repoPath: string;
  let httpPort: number;
  let proc: ReturnType<typeof Bun.spawn>;
  let accessToken: string;
  let jobDbPath: string;
  let nasSimPath: string;
  let stagingDir: string;

  beforeAll(async () => {
    repoPath = await initTempDoltRepo();
    const sessionDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-sessions-')), 'sessions.db');
    const ticketDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-tickets-')), 'tickets.db');
    jobDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-jobs-')), 'jobs.db');
    nasSimPath = await mkdtemp(join(tmpdir(), 'deltix-nas-sim-'));
    stagingDir = await mkdtemp(join(tmpdir(), 'deltix-staging-'));
    httpPort = 29000 + Math.floor(Math.random() * 5000);
    const certDir = await mkdtemp(join(tmpdir(), 'deltix-grpc-certs-storage-'));
    const { certPath, keyPath } = await generateSelfSignedCert(certDir);

    const { publicKeyBase64, privateKeyPem } = generateTestKeypair();
    const licenseKey = signLicensePayload(buildDefaultPayload(), privateKeyPem);
    const { privateKeyPem: jwtPrivateKeyPem, publicKeyPem: jwtPublicKeyPem } =
      generateTestJwtKeypairPem();
    const localUsers = JSON.stringify([
      { username: 'alice', passwordHash: await hashPassword('s3cret-pass') },
    ]);

    const seedStore = new LibsqlTransferJobStore(jobDbPath);
    await seedStore.init();
    const stagingFile = join(stagingDir, 'repo.dolt');
    await writeFile(stagingFile, 'smoke-test-payload');
    const { createHash } = await import('node:crypto');
    const checksum = createHash('sha256').update('smoke-test-payload').digest('hex');
    await seedStore.create({
      id: 'smoke-job-1',
      repo: 'org/smoke-repo',
      stagingPath: stagingFile,
      checksum,
      status: 'staged',
      retryCount: 0,
      maxRetries: 3,
      nextRetryAt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastError: null,
    });
    await seedStore.create({
      id: 'smoke-job-doomed',
      repo: 'org/doomed-repo',
      stagingPath: join(stagingDir, 'does-not-exist.dolt'),
      checksum: 'irrelevant',
      status: 'staged',
      retryCount: 0,
      maxRetries: 2,
      nextRetryAt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastError: null,
    });

    proc = Bun.spawn(['bun', 'run', ENTRYPOINT], {
      env: {
        ...process.env,
        DELTIX_LICENSE_PUBLIC_KEY: publicKeyBase64,
        DELTIX_LICENSE_KEY: licenseKey,
        DELTIX_DOLT_REPO_PATH: repoPath,
        DELTIX_CLOCK_TOLERANCE_MS: '5000',
        DELTIX_JWT_PRIVATE_KEY: jwtPrivateKeyPem,
        DELTIX_JWT_PUBLIC_KEY: jwtPublicKeyPem,
        DELTIX_LOCAL_USERS: localUsers,
        DELTIX_SESSION_DB_PATH: sessionDbPath,
        DELTIX_TICKET_DB_PATH: ticketDbPath,
        DELTIX_TICKET_TTL_SECONDS: '120',
        DELTIX_TRANSFER_JOB_DB_PATH: jobDbPath,
        DELTIX_REPO_DB_PATH: join(
          await mkdtemp(join(tmpdir(), 'deltix-storage-repos-')),
          'repos.db',
        ),
        DELTIX_DOLT_REPOS_ROOT_PATH: await mkdtemp(join(tmpdir(), 'deltix-storage-dolt-repos-')),
        DELTIX_NAS_SIM_PATH: nasSimPath,
        DELTIX_NAS_SYNC_POLL_INTERVAL_MS: '200',
        DELTIX_NAS_SYNC_BACKOFF_BASE_MS: '100',
        DELTIX_NAS_SYNC_BACKOFF_MAX_MS: '500',
        DELTIX_GRPC_TLS_CERT_PATH: certPath,
        DELTIX_GRPC_TLS_KEY_PATH: keyPath,
        DELTIX_GRPC_PORT: String(42000 + Math.floor(Math.random() * 10000)),
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
    const body = (await loginRes.json()) as { accessToken: string };
    accessToken = body.accessToken;
  });

  afterAll(async () => {
    proc.kill();
    await rm(repoPath, { recursive: true, force: true });
    await rm(nasSimPath, { recursive: true, force: true });
    await rm(stagingDir, { recursive: true, force: true });
  });

  it('the background worker actually syncs a real staged job to the simulated NAS', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const store = new LibsqlTransferJobStore(jobDbPath);
    const job = await store.get('smoke-job-1');
    expect(job?.status).toBe('synced');

    const { readFile } = await import('node:fs/promises');
    const written = await readFile(join(nasSimPath, 'org/smoke-repo', 'repo.dolt'), 'utf8');
    expect(written).toBe('smoke-test-payload');
  });

  it('a job whose staging file is missing exhausts retries and lands in dead_letter, visible via the API', async () => {
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const res = await fetch(
      `http://127.0.0.1:${httpPort}/api/v1/storage/transfer-jobs/dead-letter`,
      {
        headers: { authorization: ['Bearer ', accessToken].join('') },
      },
    );
    expect(res.status).toBe(200);
    const { jobs } = (await res.json()) as { jobs: Array<{ id: string; status: string }> };
    expect(jobs.some((j) => j.id === 'smoke-job-doomed')).toBe(true);
  });

  it('rejects the dead-letter listing endpoint without a valid access token', async () => {
    const res = await fetch(
      `http://127.0.0.1:${httpPort}/api/v1/storage/transfer-jobs/dead-letter`,
    );
    expect(res.status).toBe(401);
  });

  it('allows an operator to manually requeue a dead_letter job via the API', async () => {
    const retryRes = await fetch(
      `http://127.0.0.1:${httpPort}/api/v1/storage/transfer-jobs/dead-letter/retry`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: ['Bearer ', accessToken].join(''),
        },
        body: JSON.stringify({ jobId: 'smoke-job-doomed' }),
      },
    );
    expect(retryRes.status).toBe(200);

    const store = new LibsqlTransferJobStore(jobDbPath);
    const job = await store.get('smoke-job-doomed');
    expect(job?.status).toBe('staged');
    expect(job?.retryCount).toBe(0);
  });
});
