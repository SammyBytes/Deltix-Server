/**
 * End-to-end smoke test for the orphaned-repo admin backfill: boots the
 * real server binary as a subprocess against a repos.db pre-seeded (outside
 * the API, simulating a repo that predates per-repo authorization) with a
 * repo that has a real Dolt directory on disk but ZERO rows in
 * `repo_roles`. Confirms that when a bootstrap admin is configured, boot
 * rescues the repo by granting it admin -- and that a repo which already
 * has an owner is left untouched (fail-closed access control preserved).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
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
  const repoPath = await mkdtemp(join(tmpdir(), 'deltix-dolt-repo-orphan-smoke-'));
  await $`dolt config --global --add user.name deltix-test`.quiet().nothrow();
  await $`dolt config --global --add user.email deltix-test@example.com`.quiet().nothrow();
  const init = await $`dolt --data-dir ${repoPath} init`.quiet().nothrow();
  if (init.exitCode !== 0) {
    throw new Error(`Failed to init test Dolt repo: ${init.stderr.toString()}`);
  }
  return repoPath;
}

describe('orphaned repo admin backfill boot smoke test (real subprocess, real HTTP server)', () => {
  let licenseRepoPath: string;
  let doltReposRootPath: string;
  let repoDbPath: string;
  let userDbPath: string;
  let httpPort: number;
  let proc: ReturnType<typeof Bun.spawn>;
  let accessToken: string;

  beforeAll(async () => {
    licenseRepoPath = await initTempDoltRepo();
    doltReposRootPath = await mkdtemp(join(tmpdir(), 'deltix-orphan-smoke-repos-'));
    repoDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-orphan-repos-db-')), 'repos.db');
    userDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-orphan-users-db-')), 'users.db');
    const sessionDbPath = join(
      await mkdtemp(join(tmpdir(), 'deltix-orphan-sessions-')),
      'sessions.db',
    );
    httpPort = 26000 + Math.floor(Math.random() * 5000);
    const certDir = await mkdtemp(join(tmpdir(), 'deltix-grpc-certs-orphan-'));
    const { certPath, keyPath } = await generateSelfSignedCert(certDir);

    // Pre-seed a real Dolt repo directory + a `repos` row directly, WITHOUT
    // going through POST /repos -- this reproduces "a repo that predates
    // per-repo authorization" with zero rows in `repo_roles`.
    const orphanRepoDoltPath = join(doltReposRootPath, 'legacy-analytics');
    await $`mkdir -p ${orphanRepoDoltPath}`.quiet();
    const orphanInit = await $`dolt --data-dir ${orphanRepoDoltPath} init`.quiet().nothrow();
    if (orphanInit.exitCode !== 0) {
      throw new Error(`Failed to init orphan test Dolt repo: ${orphanInit.stderr.toString()}`);
    }
    const repoDb = createClient({ url: `file:${repoDbPath}` });
    await repoDb.execute(`
      CREATE TABLE IF NOT EXISTS repos (
        repo_id TEXT PRIMARY KEY,
        dolt_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL
      )
    `);
    await repoDb.execute({
      sql: 'INSERT INTO repos (repo_id, dolt_path, created_at, created_by) VALUES (?, ?, ?, ?)',
      args: ['legacy-analytics', orphanRepoDoltPath, Date.now(), 'pre-fase-5.6-migration'],
    });

    // A second repo that already has an owner (a governed repo) -- backfill
    // must leave this completely untouched, proving it can never silently
    // override an already-assigned owner.
    const governedRepoDoltPath = join(doltReposRootPath, 'already-governed');
    await $`mkdir -p ${governedRepoDoltPath}`.quiet();
    const governedInit = await $`dolt --data-dir ${governedRepoDoltPath} init`.quiet().nothrow();
    if (governedInit.exitCode !== 0) {
      throw new Error(`Failed to init governed test Dolt repo: ${governedInit.stderr.toString()}`);
    }
    await repoDb.execute({
      sql: 'INSERT INTO repos (repo_id, dolt_path, created_at, created_by) VALUES (?, ?, ?, ?)',
      args: ['already-governed', governedRepoDoltPath, Date.now(), 'existing-owner'],
    });
    repoDb.close();

    const userDb = createClient({ url: `file:${userDbPath}` });
    await userDb.execute(`
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        active INTEGER NOT NULL,
        last_login_at INTEGER
      )
    `);
    await userDb.execute(`
      CREATE TABLE IF NOT EXISTS repo_roles (
        username TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        role TEXT NOT NULL,
        granted_at INTEGER NOT NULL,
        granted_by TEXT NOT NULL,
        PRIMARY KEY (username, repo_id),
        FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
      )
    `);
    const hemibladePasswordHash = await hashPassword('s3cret-pass');
    await userDb.execute({
      sql: 'INSERT INTO users (username, password_hash, created_at, created_by, active) VALUES (?, ?, ?, ?, 1)',
      args: ['hemiblade', hemibladePasswordHash, Date.now(), 'bootstrap-env'],
    });
    await userDb.execute({
      sql: 'INSERT INTO users (username, password_hash, created_at, created_by, active) VALUES (?, ?, ?, ?, 1)',
      args: ['existing-owner', 'not-a-real-hash', Date.now(), 'pre-fase-5.6-migration'],
    });
    await userDb.execute({
      sql: 'INSERT INTO repo_roles (username, repo_id, role, granted_at, granted_by) VALUES (?, ?, ?, ?, ?)',
      args: ['existing-owner', 'already-governed', 'writer', Date.now(), 'pre-fase-5.6-migration'],
    });
    userDb.close();

    const { publicKeyBase64, privateKeyPem } = generateTestKeypair();
    const licenseKey = signLicensePayload(buildDefaultPayload(), privateKeyPem);
    const { privateKeyPem: jwtPrivateKeyPem, publicKeyPem: jwtPublicKeyPem } =
      generateTestJwtKeypairPem();

    proc = Bun.spawn(['bun', 'run', ENTRYPOINT], {
      env: {
        ...process.env,
        DELTIX_LICENSE_PUBLIC_KEY: publicKeyBase64,
        DELTIX_LICENSE_KEY: licenseKey,
        DELTIX_DOLT_REPO_PATH: licenseRepoPath,
        DELTIX_CLOCK_TOLERANCE_MS: '5000',
        DELTIX_JWT_PRIVATE_KEY: jwtPrivateKeyPem,
        DELTIX_JWT_PUBLIC_KEY: jwtPublicKeyPem,
        DELTIX_BOOTSTRAP_ADMIN_USERNAME: 'hemiblade',
        DELTIX_BOOTSTRAP_ADMIN_PASSWORD: 's3cret-pass',
        DELTIX_USER_DB_PATH: userDbPath,
        DELTIX_SESSION_DB_PATH: sessionDbPath,
        DELTIX_REPO_DB_PATH: repoDbPath,
        DELTIX_DOLT_REPOS_ROOT_PATH: doltReposRootPath,
        DELTIX_GRPC_TLS_CERT_PATH: certPath,
        DELTIX_GRPC_TLS_KEY_PATH: keyPath,
        DELTIX_GRPC_PORT: String(45000 + Math.floor(Math.random() * 10000)),
        HTTP_PORT: String(httpPort),
        LOG_PRETTY: 'false',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const loginRes = await fetch(`http://127.0.0.1:${httpPort}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'hemiblade', password: 's3cret-pass' }),
    });
    const body = (await loginRes.json()) as { accessToken: string };
    accessToken = body.accessToken;
  }, 20000);

  afterAll(async () => {
    proc.kill();
    await rm(licenseRepoPath, { recursive: true, force: true });
    await rm(doltReposRootPath, { recursive: true, force: true });
  });

  it('rescues an orphaned pre-existing repo by granting admin to the bootstrap admin at boot', async () => {
    const res = await fetch(
      `http://127.0.0.1:${httpPort}/api/v1/versioning/repos/legacy-analytics/roles`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );

    expect(res.status).toBe(200);
    const { roles } = (await res.json()) as {
      roles: Array<{ username: string; role: string }>;
    };
    expect(roles).toEqual([expect.objectContaining({ username: 'hemiblade', role: 'admin' })]);
  });

  it('now allows the rescued admin to perform admin-gated operations (branch create)', async () => {
    const res = await fetch(
      `http://127.0.0.1:${httpPort}/api/v1/versioning/repos/legacy-analytics/branches`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ name: 'feature/rescued' }),
      },
    );

    expect(res.status).toBe(201);
  });

  it('leaves an already-governed repo completely untouched (fail-closed preserved)', async () => {
    const res = await fetch(
      `http://127.0.0.1:${httpPort}/api/v1/versioning/repos/already-governed/roles`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );

    // The bootstrap admin was never granted any role on this repo, so
    // reading its roles is itself an access-denied case (not just an
    // empty/different role list) -- this is the strongest proof that
    // backfill never touches a repo that already has an owner.
    expect(res.status).toBe(403);
  });
});
