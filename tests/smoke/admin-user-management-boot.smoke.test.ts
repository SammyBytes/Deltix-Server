import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import {
  buildDefaultPayload,
  generateTestJwtKeypairPem,
  generateTestKeypair,
  signLicensePayload,
} from '../fixtures/license-fixtures';
import { generateSelfSignedCert } from '../fixtures/tls-fixtures';

const ENTRYPOINT = join(import.meta.dir, '..', '..', 'src', 'index.ts');

async function initTempDoltRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'deltix-dolt-repo-users-smoke-'));
  await $`dolt config --global --add user.name deltix-test`.quiet().nothrow();
  await $`dolt config --global --add user.email deltix-test@example.com`.quiet().nothrow();
  await $`dolt --data-dir ${repoPath} init`.quiet().nothrow();
  return repoPath;
}

describe('admin user management smoke test', () => {
  let repoPath: string;
  let dataRoot: string;
  let httpPort: number;
  let proc: ReturnType<typeof Bun.spawn>;

  beforeAll(async () => {
    repoPath = await initTempDoltRepo();
    dataRoot = await mkdtemp(join(tmpdir(), 'deltix-users-smoke-data-'));
    mkdirSync(join(dataRoot, 'data'), { recursive: true });
    httpPort = 34000 + Math.floor(Math.random() * 3000);
    const certDir = await mkdtemp(join(tmpdir(), 'deltix-grpc-certs-users-'));
    const { certPath, keyPath } = await generateSelfSignedCert(certDir);
    const { publicKeyBase64, privateKeyPem } = generateTestKeypair();
    const licenseKey = signLicensePayload(buildDefaultPayload(), privateKeyPem);
    const { privateKeyPem: jwtPrivateKeyPem, publicKeyPem: jwtPublicKeyPem } =
      generateTestJwtKeypairPem();

    proc = Bun.spawn(['bun', 'run', ENTRYPOINT], {
      cwd: dataRoot,
      env: {
        ...process.env,
        DELTIX_LICENSE_PUBLIC_KEY: publicKeyBase64,
        DELTIX_LICENSE_KEY: licenseKey,
        DELTIX_DOLT_REPO_PATH: repoPath,
        DELTIX_CLOCK_TOLERANCE_MS: '5000',
        DELTIX_JWT_PRIVATE_KEY: jwtPrivateKeyPem,
        DELTIX_JWT_PUBLIC_KEY: jwtPublicKeyPem,
        DELTIX_SESSION_DB_PATH: './data/sessions.db',
        DELTIX_USER_DB_PATH: './data/users.db',
        DELTIX_REPO_DB_PATH: './data/repos.db',
        DELTIX_GRPC_TLS_CERT_PATH: certPath,
        DELTIX_GRPC_TLS_KEY_PATH: keyPath,
        DELTIX_GRPC_PORT: String(43000 + Math.floor(Math.random() * 10000)),
        DELTIX_ADMIN_UI_ENABLED: 'true',
        HTTP_PORT: String(httpPort),
        LOG_PRETTY: 'false',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    await new Promise((resolve) => setTimeout(resolve, 1500));
  });

  afterAll(async () => {
    proc.kill();
    await rm(repoPath, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  });

  it('allows first boot setup, then locks setup and permits authenticated user CRUD', async () => {
    const setupPage = await fetch(`http://127.0.0.1:${httpPort}/admin/setup`);
    if (setupPage.status !== 200) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(
        ['Unexpected setup status ', String(setupPage.status), '\n', stderr].join(''),
      );
    }

    const setupRes = await fetch(`http://127.0.0.1:${httpPort}/api/v1/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 's3cret-pass' }),
    });
    expect(setupRes.status).toBe(201);

    const setupAfter = await fetch(`http://127.0.0.1:${httpPort}/admin/setup`);
    expect(setupAfter.status).toBe(404);

    const loginRes = await fetch(`http://127.0.0.1:${httpPort}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 's3cret-pass' }),
    });
    expect(loginRes.status).toBe(200);
    const loginBody = (await loginRes.json()) as { accessToken: string };
    const accessToken = loginBody.accessToken;

    const createUserRes = await fetch(`http://127.0.0.1:${httpPort}/api/v1/auth/users`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: ['Bearer ', accessToken].join(''),
      },
      body: JSON.stringify({ username: 'bob', password: 'another-pass' }),
    });
    expect(createUserRes.status).toBe(201);

    const listRes = await fetch(`http://127.0.0.1:${httpPort}/api/v1/auth/users`, {
      headers: { authorization: ['Bearer ', accessToken].join('') },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { users: Array<{ username: string }> };
    expect(listBody.users.some((user) => user.username === 'bob')).toBe(true);

    const deactivateRes = await fetch(
      `http://127.0.0.1:${httpPort}/api/v1/auth/users/bob/deactivate`,
      {
        method: 'POST',
        headers: { authorization: ['Bearer ', accessToken].join('') },
      },
    );
    expect(deactivateRes.status).toBe(200);
  });
});
