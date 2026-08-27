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
  const repoPath = await mkdtemp(join(tmpdir(), 'deltix-dolt-repo-transfer-smoke-'));
  await $`dolt config --global --add user.name deltix-test`.quiet().nothrow();
  await $`dolt config --global --add user.email deltix-test@example.com`.quiet().nothrow();
  const init = await $`dolt --data-dir ${repoPath} init`.quiet().nothrow();
  if (init.exitCode !== 0) {
    throw new Error(`Failed to init test Dolt repo: ${init.stderr.toString()}`);
  }
  return repoPath;
}

describe('transfer boot smoke test (real subprocess, real HTTP server, real ticket flow)', () => {
  let repoPath: string;
  let httpPort: number;
  let proc: ReturnType<typeof Bun.spawn>;
  let accessToken: string;

  beforeAll(async () => {
    repoPath = await initTempDoltRepo();
    const sessionDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-sessions-')), 'sessions.db');
    const userDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-users-')), 'users.db');
    const ticketDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-tickets-')), 'tickets.db');
    httpPort = 24000 + Math.floor(Math.random() * 5000);
    const certDir = await mkdtemp(join(tmpdir(), 'deltix-grpc-certs-transfer-'));
    const { certPath, keyPath } = await generateSelfSignedCert(certDir);

    const { publicKeyBase64, privateKeyPem } = generateTestKeypair();
    const licenseKey = signLicensePayload(buildDefaultPayload(), privateKeyPem);
    const { privateKeyPem: jwtPrivateKeyPem, publicKeyPem: jwtPublicKeyPem } =
      generateTestJwtKeypairPem();
    const localUsers = JSON.stringify([
      { username: 'alice', passwordHash: await hashPassword('s3cret-pass') },
    ]);

    // Repo RBAC is now enforced at ticket-issuance time (transfer.router.ts):
    // a caller needs `writer` for push and `reader` for pull on the target
    // repo. Seed alice as a real user row (FK target for repo_roles) with
    // admin on both repos this test exercises before boot, since
    // DELTIX_LOCAL_USERS itself carries no repo roles.
    const { LibsqlUserStore } = await import('../../src/contexts/auth/libsql-user-store');
    const userStore = new LibsqlUserStore(userDbPath);
    await userStore.init();
    await userStore.create({
      username: 'alice',
      passwordHash: await hashPassword('s3cret-pass'),
      createdAt: Date.now(),
      createdBy: 'test-seed',
      active: true,
      lastLoginAt: null,
    });
    for (const repoId of ['org/repo', 'org/other-repo']) {
      await userStore.upsertRepoRole({
        username: 'alice',
        repoId,
        role: 'admin',
        grantedAt: Date.now(),
        grantedBy: 'test-seed',
      });
    }

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
        DELTIX_USER_DB_PATH: userDbPath,
        DELTIX_SESSION_DB_PATH: sessionDbPath,
        DELTIX_TICKET_DB_PATH: ticketDbPath,
        DELTIX_TICKET_TTL_SECONDS: '120',
        DELTIX_GRPC_TLS_CERT_PATH: certPath,
        DELTIX_GRPC_TLS_KEY_PATH: keyPath,
        DELTIX_GRPC_PORT: String(43000 + Math.floor(Math.random() * 10000)),
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
    const body = (await loginRes.json()) as { accessToken: string };
    accessToken = body.accessToken;
  });

  afterAll(async () => {
    proc.kill();
    await rm(repoPath, { recursive: true, force: true });
  });

  it('issues an ephemeral ticket over real HTTP for an authenticated caller', async () => {
    const res = await fetch(`http://127.0.0.1:${httpPort}/api/v1/push/ticket`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ operation: 'push', repo: 'org/repo' }),
    });

    expect(res.status).toBe(201);
    const ticket = (await res.json()) as { ticketId: string; expiresAt: number };
    expect(ticket.ticketId).toBeString();
    // TTL should be roughly 2 minutes out (allow generous jitter for CI).
    expect(ticket.expiresAt).toBeGreaterThan(Date.now());
    expect(ticket.expiresAt).toBeLessThan(Date.now() + 130_000);
  });

  it('rejects ticket issuance without a valid access token', async () => {
    const res = await fetch(`http://127.0.0.1:${httpPort}/api/v1/push/ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'push', repo: 'org/repo' }),
    });
    expect(res.status).toBe(401);
  });

  it('closing a ticket that was never activated returns 404 (not yet in the active state)', async () => {
    const issueRes = await fetch(`http://127.0.0.1:${httpPort}/api/v1/push/ticket`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ operation: 'pull', repo: 'org/other-repo' }),
    });
    const { ticketId } = (await issueRes.json()) as { ticketId: string };

    const closeRes = await fetch(`http://127.0.0.1:${httpPort}/api/v1/auth/session-close`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ ticketId }),
    });
    expect(closeRes.status).toBe(404);
  });
});
