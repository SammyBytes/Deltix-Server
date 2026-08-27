/**
 * Full real-subprocess smoke test for Fase 5.2: boots the actual server
 * binary, provisions a real Dolt repo via the REST versioning API (Fase
 * 5.1), pushes a file over a real TLS gRPC connection, and verifies a
 * real, additional `dolt commit` was recorded in that repo's own Dolt
 * history — attributed to the authenticated pusher and containing the
 * push's checksum. This is the one test that proves the whole "push now
 * produces a real, versioned Dolt commit" promise works end-to-end, wired
 * together exactly as it runs in production.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
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
const PROTO_PATH = join(import.meta.dir, '..', '..', 'proto', 'transfer.proto');

async function initTempDoltRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'deltix-dolt-repo-versioning-push-smoke-'));
  await $`dolt config --global --add user.name deltix-test`.quiet().nothrow();
  await $`dolt config --global --add user.email deltix-test@example.com`.quiet().nothrow();
  const init = await $`dolt --data-dir ${repoPath} init`.quiet().nothrow();
  if (init.exitCode !== 0) {
    throw new Error(`Failed to init test Dolt repo: ${init.stderr.toString()}`);
  }
  return repoPath;
}

describe('versioning push-commit boot smoke test (real subprocess, real TLS gRPC push, real Dolt commit)', () => {
  let licenseRepoPath: string;
  let doltReposRootPath: string;
  let proc: ReturnType<typeof Bun.spawn>;
  let httpPort: number;
  let grpcPort: number;
  let accessToken: string;
  let caCertPath: string;
  let client: grpc.Client & {
    push: (
      callback: (err: grpc.ServiceError | null, res: unknown) => void,
    ) => grpc.ClientWritableStream<unknown>;
  };

  beforeAll(async () => {
    licenseRepoPath = await initTempDoltRepo();
    doltReposRootPath = await mkdtemp(join(tmpdir(), 'deltix-versioning-push-smoke-repos-'));
    const sessionDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-sessions-')), 'sessions.db');
    const ticketDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-tickets-')), 'tickets.db');
    const jobDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-jobs-')), 'jobs.db');
    const repoDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-repos-')), 'repos.db');
    const nasSimPath = await mkdtemp(join(tmpdir(), 'deltix-nas-sim-'));
    const stagingRootPath = await mkdtemp(join(tmpdir(), 'deltix-staging-'));
    httpPort = 24000 + Math.floor(Math.random() * 5000);
    grpcPort = 43000 + Math.floor(Math.random() * 10000);

    const certDir = await mkdtemp(join(tmpdir(), 'deltix-grpc-certs-versioning-push-'));
    const { certPath, keyPath } = await generateSelfSignedCert(certDir);
    caCertPath = certPath;

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
        DELTIX_SESSION_DB_PATH: sessionDbPath,
        DELTIX_TICKET_DB_PATH: ticketDbPath,
        DELTIX_TICKET_TTL_SECONDS: '120',
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
        DELTIX_GRPC_PORT: String(grpcPort),
        HTTP_PORT: String(httpPort),
        LOG_PRETTY: 'false',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const loginRes = await fetch(`http://127.0.0.1:${httpPort}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 's3cret-pass' }),
    });
    const loginBody = (await loginRes.json()) as { accessToken: string };
    accessToken = loginBody.accessToken;

    const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
      deltix: { transfer: { v1: { TransferEngine: grpc.ServiceClientConstructor } } };
    };
    const caCert = await readFile(caCertPath);
    const credentials = grpc.ChannelCredentials.createSsl(caCert);
    const TransferEngine = proto.deltix.transfer.v1.TransferEngine;
    client = new TransferEngine(`localhost:${grpcPort}`, credentials, {
      'grpc.ssl_target_name_override': 'localhost',
    }) as unknown as typeof client;
  });

  afterAll(async () => {
    client?.close();
    proc.kill();
    await rm(licenseRepoPath, { recursive: true, force: true });
    await rm(doltReposRootPath, { recursive: true, force: true });
  });

  it('provisions a real Dolt repo, pushes over gRPC, and records a real additional Dolt commit authored by the pusher', async () => {
    const repoId = 'versioning-push-smoke-repo';
    const content = 'deltix Fase 5.2 smoke test payload — push must produce a real Dolt commit';
    const expectedChecksum = createHash('sha256').update(content).digest('hex');

    const provisionRes = await fetch(`http://127.0.0.1:${httpPort}/api/v1/versioning/repos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: ['Bearer ', accessToken].join(''),
      },
      body: JSON.stringify({ repoId }),
    });
    expect(provisionRes.status).toBe(201);
    const { repo } = (await provisionRes.json()) as { repo: { doltPath: string } };

    const before = await $`dolt --data-dir ${repo.doltPath} log --oneline`.quiet();
    const commitsBefore = before.stdout.toString().trim().split('\n').length;

    const pushTicketRes = await fetch(`http://127.0.0.1:${httpPort}/api/v1/push/ticket`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: ['Bearer ', accessToken].join(''),
      },
      body: JSON.stringify({ operation: 'push', repo: repoId }),
    });
    expect(pushTicketRes.status).toBe(201);
    const { ticketId: pushTicketId } = (await pushTicketRes.json()) as { ticketId: string };

    const pushResult = await new Promise<{ jobId: string; checksum: string }>((resolve, reject) => {
      const call = client.push((err, res) => {
        if (err) reject(err);
        else resolve(res as { jobId: string; checksum: string });
      });
      call.write({ header: { ticketId: pushTicketId, operation: 'push', repo: repoId } });
      call.write({ chunk: { data: Buffer.from(content) } });
      call.end();
    });
    expect(pushResult.checksum).toBe(expectedChecksum);

    // The Dolt commit happens as a best-effort side effect right after
    // `finish()` on the server — give it a brief moment to run before
    // asserting on the repo's commit log.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const after = await $`dolt --data-dir ${repo.doltPath} log --oneline`.quiet();
    const commitsAfter = after.stdout.toString().trim().split('\n').length;
    expect(commitsAfter).toBe(commitsBefore + 1);

    const authorLog = await $`dolt --data-dir ${repo.doltPath} log -n 1`.quiet();
    expect(authorLog.stdout.toString()).toContain('alice');

    const rows =
      await $`dolt --data-dir ${repo.doltPath} sql -q ${'SELECT author, checksum FROM deltix_push_log'} -r csv`.quiet();
    expect(rows.stdout.toString()).toContain('alice');
    expect(rows.stdout.toString()).toContain(expectedChecksum);
  }, 20000);
});
