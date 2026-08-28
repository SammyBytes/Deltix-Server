/**
 * End-to-end smoke test for Fase 5.1: boots the real server binary as a
 * subprocess (no mocks), authenticates over real HTTP, provisions a repo
 * via the real REST API, and confirms a real, independent Dolt repository
 * was created on disk (verifiable with the `dolt` CLI directly) — closing
 * the loop between the HTTP control plane and the real Dolt binary.
 */
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
  const repoPath = await mkdtemp(join(tmpdir(), 'deltix-dolt-repo-versioning-smoke-'));
  await $`dolt config --global --add user.name deltix-test`.quiet().nothrow();
  await $`dolt config --global --add user.email deltix-test@example.com`.quiet().nothrow();
  const init = await $`dolt --data-dir ${repoPath} init`.quiet().nothrow();
  if (init.exitCode !== 0) {
    throw new Error(`Failed to init test Dolt repo: ${init.stderr.toString()}`);
  }
  return repoPath;
}

describe('versioning boot smoke test (real subprocess, real HTTP server, real Dolt repo provisioning)', () => {
  let licenseRepoPath: string;
  let doltReposRootPath: string;
  let httpPort: number;
  let proc: ReturnType<typeof Bun.spawn>;
  let accessToken: string;

  beforeAll(async () => {
    licenseRepoPath = await initTempDoltRepo();
    doltReposRootPath = await mkdtemp(join(tmpdir(), 'deltix-versioning-smoke-repos-'));
    const sessionDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-sessions-')), 'sessions.db');
    const repoDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-repos-db-')), 'repos.db');
    httpPort = 24000 + Math.floor(Math.random() * 5000);
    const certDir = await mkdtemp(join(tmpdir(), 'deltix-grpc-certs-versioning-'));
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
        DELTIX_SESSION_DB_PATH: sessionDbPath,
        DELTIX_REPO_DB_PATH: repoDbPath,
        DELTIX_DOLT_REPOS_ROOT_PATH: doltReposRootPath,
        DELTIX_GRPC_TLS_CERT_PATH: certPath,
        DELTIX_GRPC_TLS_KEY_PATH: keyPath,
        DELTIX_GRPC_PORT: String(43000 + Math.floor(Math.random() * 10000)),
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
    await rm(licenseRepoPath, { recursive: true, force: true });
    await rm(doltReposRootPath, { recursive: true, force: true });
  });

  it('provisions a repo over real HTTP and creates a real Dolt repository on disk', async () => {
    const res = await fetch(`http://127.0.0.1:${httpPort}/api/v1/versioning/repos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ repoId: 'smoke-repo' }),
    });

    expect(res.status).toBe(201);
    const { repo } = (await res.json()) as { repo: { repoId: string; doltPath: string } };
    expect(repo.repoId).toBe('smoke-repo');

    // The proof this is a REAL Dolt repo, not just a DB row: query its
    // commit graph directly with the CLI, outside the running server.
    const log = await $`dolt --data-dir ${repo.doltPath} log`.quiet();
    expect(log.exitCode).toBe(0);
    expect(log.stdout.toString()).toContain('Initialize data repository');
  });

  it('rejects repo provisioning without a valid access token', async () => {
    const res = await fetch(`http://127.0.0.1:${httpPort}/api/v1/versioning/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoId: 'unauthorized-repo' }),
    });
    expect(res.status).toBe(401);
  });

  it('lists provisioned repos over real HTTP', async () => {
    await fetch(`http://127.0.0.1:${httpPort}/api/v1/versioning/repos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ repoId: 'listed-repo' }),
    });

    const res = await fetch(`http://127.0.0.1:${httpPort}/api/v1/versioning/repos`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.status).toBe(200);
    const { repos } = (await res.json()) as { repos: Array<{ repoId: string }> };
    expect(repos.some((r) => r.repoId === 'listed-repo')).toBe(true);
  });
});
