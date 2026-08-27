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
  const repoPath = await mkdtemp(join(tmpdir(), 'deltix-dolt-repo-grpc-smoke-'));
  await $`dolt config --global --add user.name deltix-test`.quiet().nothrow();
  await $`dolt config --global --add user.email deltix-test@example.com`.quiet().nothrow();
  const init = await $`dolt --data-dir ${repoPath} init`.quiet().nothrow();
  if (init.exitCode !== 0) {
    throw new Error(`Failed to init test Dolt repo: ${init.stderr.toString()}`);
  }
  return repoPath;
}

/**
 * Full real-subprocess smoke test for the gRPC Transfer Engine: boots the
 * actual server binary (not an in-process test double), issues a real
 * ephemeral ticket over REST, pushes a real file over a real TLS gRPC
 * connection, waits for the real NAS sync worker to promote it, then pulls
 * it back over gRPC and verifies the bytes match byte-for-byte. This is the
 * one test that proves the whole Fase 3 pipeline works end-to-end wired
 * together exactly as it will run in production (REST ticket issuance ->
 * gRPC Push -> SSD staging -> NAS sync worker -> gRPC Pull).
 */
describe('gRPC transfer engine boot smoke test (real subprocess, real TLS, real Push -> NAS sync -> Pull)', () => {
  let repoPath: string;
  let proc: ReturnType<typeof Bun.spawn>;
  let httpPort: number;
  let grpcPort: number;
  let accessToken: string;
  let caCertPath: string;
  let client: grpc.Client & {
    push: (
      callback: (err: grpc.ServiceError | null, res: unknown) => void,
    ) => grpc.ClientWritableStream<unknown>;
    pull: (request: {
      ticketId: string;
      repo: string;
    }) => grpc.ClientReadableStream<{ data: Uint8Array }>;
  };

  beforeAll(async () => {
    repoPath = await initTempDoltRepo();
    const sessionDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-sessions-')), 'sessions.db');
    const ticketDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-tickets-')), 'tickets.db');
    const jobDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-jobs-')), 'jobs.db');
    const nasSimPath = await mkdtemp(join(tmpdir(), 'deltix-nas-sim-'));
    const stagingRootPath = await mkdtemp(join(tmpdir(), 'deltix-staging-'));
    httpPort = 45000 + Math.floor(Math.random() * 5000);
    grpcPort = 50000 + Math.floor(Math.random() * 5000);

    const certDir = await mkdtemp(join(tmpdir(), 'deltix-grpc-certs-e2e-'));
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
        DELTIX_DOLT_REPO_PATH: repoPath,
        DELTIX_CLOCK_TOLERANCE_MS: '5000',
        DELTIX_JWT_PRIVATE_KEY: jwtPrivateKeyPem,
        DELTIX_JWT_PUBLIC_KEY: jwtPublicKeyPem,
        DELTIX_LOCAL_USERS: localUsers,
        DELTIX_SESSION_DB_PATH: sessionDbPath,
        DELTIX_TICKET_DB_PATH: ticketDbPath,
        DELTIX_TICKET_TTL_SECONDS: '120',
        DELTIX_TRANSFER_JOB_DB_PATH: jobDbPath,
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

    // gRPC bind (TLS cert load + server.start()) adds meaningfully more
    // boot latency than the REST-only boot path — give it more headroom
    // than the plain HTTP smoke tests to avoid a boot-time race.
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
    await rm(repoPath, { recursive: true, force: true });
  });

  it('pushes a file over real TLS gRPC, syncs it to NAS, and pulls it back byte-for-byte', async () => {
    const repo = 'org/e2e-smoke-repo';
    const content = 'deltix end-to-end smoke test payload — push then pull';
    const expectedChecksum = createHash('sha256').update(content).digest('hex');

    // 1. Issue a real Push ticket over REST.
    const pushTicketRes = await fetch(`http://127.0.0.1:${httpPort}/api/v1/push/ticket`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ operation: 'push', repo }),
    });
    expect(pushTicketRes.status).toBe(201);
    const { ticketId: pushTicketId } = (await pushTicketRes.json()) as { ticketId: string };

    // 2. Push the file over the real gRPC TLS connection.
    const pushResult = await new Promise<{
      jobId: string;
      checksum: string;
      bytesReceived: string;
    }>((resolve, reject) => {
      const call = client.push((err, res) => {
        if (err) reject(err);
        else resolve(res as { jobId: string; checksum: string; bytesReceived: string });
      });
      call.write({ header: { ticketId: pushTicketId, operation: 'push', repo } });
      call.write({ chunk: { data: Buffer.from(content) } });
      call.end();
    });
    expect(pushResult.checksum).toBe(expectedChecksum);
    expect(Number(pushResult.bytesReceived)).toBe(Buffer.byteLength(content));

    // 3. Give the real background NAS sync worker (polling every 150ms in
    // this test's env) a few ticks to promote the job from 'staged' to
    // 'synced' before we attempt the Pull below.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // 4. Issue a real Pull ticket over REST for the same repo.
    const pullTicketRes = await fetch(`http://127.0.0.1:${httpPort}/api/v1/push/ticket`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ operation: 'pull', repo }),
    });
    expect(pullTicketRes.status).toBe(201);
    const { ticketId: pullTicketId } = (await pullTicketRes.json()) as { ticketId: string };

    // 5. Pull the file back over gRPC and verify it matches byte-for-byte.
    const receivedChunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const call = client.pull({ ticketId: pullTicketId, repo });
      call.on('data', (chunk: { data: Uint8Array }) => {
        receivedChunks.push(Buffer.from(chunk.data));
      });
      call.on('end', () => resolve());
      call.on('error', (err: Error) => reject(err));
    });
    const received = Buffer.concat(receivedChunks).toString('utf8');
    expect(received).toBe(content);
  }, 20000);
});
