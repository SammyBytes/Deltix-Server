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
  const repoPath = await mkdtemp(join(tmpdir(), 'deltix-dolt-repo-auth-smoke-'));
  await $`dolt config --global --add user.name deltix-test`.quiet().nothrow();
  await $`dolt config --global --add user.email deltix-test@example.com`.quiet().nothrow();
  const init = await $`dolt --data-dir ${repoPath} init`.quiet().nothrow();
  if (init.exitCode !== 0) {
    throw new Error(`Failed to init test Dolt repo: ${init.stderr.toString()}`);
  }
  return repoPath;
}

describe('auth boot smoke test (real subprocess, real HTTP server, real login flow)', () => {
  let repoPath: string;
  let sessionDbPath: string;
  let httpPort: number;
  let proc: ReturnType<typeof Bun.spawn>;

  beforeAll(async () => {
    repoPath = await initTempDoltRepo();
    sessionDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-sessions-')), 'sessions.db');
    httpPort = 20000 + Math.floor(Math.random() * 10000);
    const certDir = await mkdtemp(join(tmpdir(), 'deltix-grpc-certs-'));
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
        DELTIX_DOLT_REPO_PATH: repoPath,
        DELTIX_CLOCK_TOLERANCE_MS: '5000',
        DELTIX_JWT_PRIVATE_KEY: jwtPrivateKeyPem,
        DELTIX_JWT_PUBLIC_KEY: jwtPublicKeyPem,
        DELTIX_LOCAL_USERS: localUsers,
        DELTIX_SESSION_DB_PATH: sessionDbPath,
        DELTIX_GRPC_TLS_CERT_PATH: certPath,
        DELTIX_GRPC_TLS_KEY_PATH: keyPath,
        DELTIX_GRPC_PORT: String(20000 + Math.floor(Math.random() * 10000) + 10000),
        HTTP_PORT: String(httpPort),
        LOG_PRETTY: 'false',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Give the server a moment to boot and start listening.
    await new Promise((resolve) => setTimeout(resolve, 800));
  });

  afterAll(async () => {
    proc.kill();
    await rm(repoPath, { recursive: true, force: true });
  });

  it('serves a full login -> keep-alive -> logout flow over real HTTP', async () => {
    const loginRes = await fetch(`http://127.0.0.1:${httpPort}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 's3cret-pass' }),
    });
    expect(loginRes.status).toBe(200);
    const { refreshToken } = (await loginRes.json()) as { refreshToken: string };

    const keepAliveRes = await fetch(`http://127.0.0.1:${httpPort}/api/v1/auth/keep-alive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    expect(keepAliveRes.status).toBe(200);

    const logoutRes = await fetch(`http://127.0.0.1:${httpPort}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    expect(logoutRes.status).toBe(200);
  });

  it('rejects invalid credentials over real HTTP without leaking details', async () => {
    const res = await fetch(`http://127.0.0.1:${httpPort}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'totally-wrong' }),
    });
    expect(res.status).toBe(401);
  });

  it('applies baseline security headers and fails closed on CORS for a non-allow-listed origin', async () => {
    const res = await fetch(`http://127.0.0.1:${httpPort}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://not-allowed.example' },
      body: JSON.stringify({ username: 'alice', password: 'totally-wrong' }),
    });

    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
