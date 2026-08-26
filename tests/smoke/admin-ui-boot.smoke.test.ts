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

const ENTRYPOINT = join(import.meta.dir, '..', '..', 'src', 'index.ts');

async function initTempDoltRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'deltix-dolt-repo-admin-smoke-'));
  await $`dolt config --global --add user.name deltix-test`.quiet().nothrow();
  await $`dolt config --global --add user.email deltix-test@example.com`.quiet().nothrow();
  await $`dolt --data-dir ${repoPath} init`.quiet().nothrow();
  return repoPath;
}

async function spawnServer(
  repoPath: string,
  httpPort: number,
  extraEnv: Record<string, string>,
): Promise<ReturnType<typeof Bun.spawn>> {
  const { publicKeyBase64, privateKeyPem } = generateTestKeypair();
  const licenseKey = signLicensePayload(buildDefaultPayload(), privateKeyPem);
  const { privateKeyPem: jwtPrivateKeyPem, publicKeyPem: jwtPublicKeyPem } =
    generateTestJwtKeypairPem();
  const localUsers = JSON.stringify([
    { username: 'alice', passwordHash: await hashPassword('s3cret-pass') },
  ]);
  const sessionDbPath = join(
    await mkdtemp(join(tmpdir(), 'deltix-admin-sessions-')),
    'sessions.db',
  );

  const proc = Bun.spawn(['bun', 'run', ENTRYPOINT], {
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
      HTTP_PORT: String(httpPort),
      LOG_PRETTY: 'false',
      ...extraEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  await new Promise((resolve) => setTimeout(resolve, 800));
  return proc;
}

describe('admin-ui boot smoke test (real subprocess, real HTTP server)', () => {
  let repoPath: string;

  beforeAll(async () => {
    repoPath = await initTempDoltRepo();
  });

  afterAll(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it('is NOT mounted by default (DELTIX_ADMIN_UI_ENABLED unset -> 404)', async () => {
    const httpPort = 22000 + Math.floor(Math.random() * 5000);
    const proc = await spawnServer(repoPath, httpPort, {});

    try {
      const res = await fetch(`http://127.0.0.1:${httpPort}/admin`);
      expect(res.status).toBe(404);
    } finally {
      proc.kill();
    }
  });

  it('serves the real login page over HTTP when DELTIX_ADMIN_UI_ENABLED=true', async () => {
    const httpPort = 27000 + Math.floor(Math.random() * 3000);
    const proc = await spawnServer(repoPath, httpPort, { DELTIX_ADMIN_UI_ENABLED: 'true' });

    try {
      const res = await fetch(`http://127.0.0.1:${httpPort}/admin`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const body = await res.text();
      expect(body).toContain('Deltix Admin');
    } finally {
      proc.kill();
    }
  });

  it('serves /admin/app.js as real JavaScript and the login API works end-to-end', async () => {
    const httpPort = 30000 + Math.floor(Math.random() * 3000);
    const proc = await spawnServer(repoPath, httpPort, { DELTIX_ADMIN_UI_ENABLED: 'true' });

    try {
      const scriptRes = await fetch(`http://127.0.0.1:${httpPort}/admin/app.js`);
      expect(scriptRes.status).toBe(200);
      expect(scriptRes.headers.get('content-type')).toContain('javascript');

      // Regression guard: the login page must NOT ship an inline <script>
      // body, since the strict CSP (no 'unsafe-inline' for scripts) would
      // silently block it and the form would fall back to a native GET
      // submit that leaks the password into the URL query string.
      const pageRes = await fetch(`http://127.0.0.1:${httpPort}/admin`);
      const pageBody = await pageRes.text();
      const scriptTagPattern = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
      for (const match of pageBody.matchAll(scriptTagPattern)) {
        expect(match[1].trim()).toBe('');
      }

      // Prove the actual API the page's script calls works end-to-end.
      const loginRes = await fetch(`http://127.0.0.1:${httpPort}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 's3cret-pass' }),
      });
      expect(loginRes.status).toBe(200);
      const loginBody = await loginRes.json();
      expect(loginBody.accessToken).toBeString();
    } finally {
      proc.kill();
    }
  });
});
