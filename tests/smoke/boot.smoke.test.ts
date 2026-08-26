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
  const repoPath = await mkdtemp(join(tmpdir(), 'deltix-dolt-repo-smoke-'));
  await $`dolt config --global --add user.name deltix-test`.quiet().nothrow();
  await $`dolt config --global --add user.email deltix-test@example.com`.quiet().nothrow();
  const init = await $`dolt --data-dir ${repoPath} init`.quiet().nothrow();
  if (init.exitCode !== 0) {
    throw new Error(`Failed to init test Dolt repo: ${init.stderr.toString()}`);
  }
  return repoPath;
}

describe('boot smoke test (real subprocess, real dolt repo)', () => {
  let repoPath: string;

  beforeAll(async () => {
    repoPath = await initTempDoltRepo();
  });

  afterAll(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it('boots successfully (exit code 0) with a valid license and a clock in sync with dolt_log', async () => {
    const { publicKeyBase64, privateKeyPem } = generateTestKeypair();
    const licenseKey = signLicensePayload(buildDefaultPayload(), privateKeyPem);
    const { privateKeyPem: jwtPrivateKeyPem, publicKeyPem: jwtPublicKeyPem } =
      generateTestJwtKeypairPem();
    const sessionDbPath = join(
      await mkdtemp(join(tmpdir(), 'deltix-sessions-boot-smoke-')),
      'sessions.db',
    );
    const localUsers = JSON.stringify([
      { username: 'alice', passwordHash: await hashPassword('s3cret-pass') },
    ]);

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
        HTTP_PORT: '0',
        LOG_PRETTY: 'false',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // The server boots and stays alive (Bun.serve blocks the process), so we
    // give it a moment to pass validation, then confirm it is still running
    // instead of waiting for a natural exit that will never come.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const stillRunning = proc.exitCode === null;
    proc.kill();
    await proc.exited;

    expect(stillRunning).toBe(true);
  });

  it('blocks boot (non-zero exit code) when the latest Dolt commit is dated in the future relative to the system clock', async () => {
    // Simulate clock rollback WITHOUT touching the real OS clock: record a
    // commit whose date is far in the future, so "now" (the real system time)
    // is behind it by construction.
    await $`dolt --data-dir ${repoPath} sql -q ${'create table rollback_marker (id int primary key)'}`
      .quiet()
      .nothrow();
    await $`dolt --data-dir ${repoPath} add .`.quiet().nothrow();
    const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const commit =
      await $`dolt --data-dir ${repoPath} commit -m ${'future commit'} --date=${futureDate}`
        .quiet()
        .nothrow();
    expect(commit.exitCode).toBe(0);

    const { publicKeyBase64, privateKeyPem } = generateTestKeypair();
    const licenseKey = signLicensePayload(buildDefaultPayload(), privateKeyPem);

    const proc = Bun.spawn(['bun', 'run', ENTRYPOINT], {
      env: {
        ...process.env,
        DELTIX_LICENSE_PUBLIC_KEY: publicKeyBase64,
        DELTIX_LICENSE_KEY: licenseKey,
        DELTIX_DOLT_REPO_PATH: repoPath,
        DELTIX_CLOCK_TOLERANCE_MS: '5000',
        LOG_PRETTY: 'false',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
  });
});
