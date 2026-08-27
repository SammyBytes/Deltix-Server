/**
 * End-to-end smoke test for the Fase 4 addon pipeline: boots the real
 * server binary as a subprocess (no mocks) with a real signed community
 * addon on disk, a pre-registered TOFU trust record, and a real HTTP
 * `http:route` the addon registers on activation. Verifies:
 *   - a trusted, license-permitted community addon loads and its route
 *     answers over real HTTP.
 *   - an official addon (signed with Deltix's own key) loads too.
 *   - an UNTRUSTED community addon (no TOFU record) is refused — the
 *     control plane still boots, but that addon never activates.
 * This is the missing "real addon actually runs" proof that the unit +
 * integration tests (which exercise `loadAddon()`/`discoverAndLoadAddons()`
 * in isolation) don't cover.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { buildSignedPayload } from '../../src/contexts/addons/addon-signature';
import { LibsqlAddonTrustStore } from '../../src/contexts/addons/libsql-addon-trust-store';
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
  const repoPath = await mkdtemp(join(tmpdir(), 'deltix-dolt-repo-addons-smoke-'));
  await $`dolt config --global --add user.name deltix-test`.quiet().nothrow();
  await $`dolt config --global --add user.email deltix-test@example.com`.quiet().nothrow();
  await $`dolt --data-dir ${repoPath} init`.quiet().nothrow();
  return repoPath;
}

/** Writes a real addon package (manifest + entrypoint + detached signature) to disk. */
async function writeAddonPackage(options: {
  dir: string;
  name: string;
  tier: 'official' | 'community';
  capabilities: string[];
  signWithPrivateKeyPem: string;
  authorPublicKeyBase64?: string;
  routePath: string;
}): Promise<void> {
  const manifest = {
    name: options.name,
    version: '1.0.0',
    tier: options.tier,
    entrypoint: 'index.js',
    capabilities: options.capabilities,
    ...(options.tier === 'community' ? { authorPublicKey: options.authorPublicKeyBase64 } : {}),
  };
  const manifestJson = JSON.stringify(manifest, null, 2);
  const entrypointSource = `export default {
  activate(ctx) {
    if (ctx.http && ctx.grantedCapabilities.includes('http:route')) {
      ctx.http.register('${options.routePath}', async (request) => {
        return new Response(JSON.stringify({ addon: '${options.name}', ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
    }
  },
};
`;

  await writeFile(join(options.dir, 'addon.manifest.json'), manifestJson, 'utf8');
  await writeFile(join(options.dir, 'index.js'), entrypointSource, 'utf8');

  const manifestBytes = new TextEncoder().encode(manifestJson);
  const entrypointBytes = new TextEncoder().encode(entrypointSource);
  const payload = buildSignedPayload(manifestBytes, entrypointBytes);
  const signature = sign(null, payload, options.signWithPrivateKeyPem);
  await writeFile(join(options.dir, 'addon.sig'), signature);
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
    await mkdtemp(join(tmpdir(), 'deltix-addons-sessions-')),
    'sessions.db',
  );
  const certDir = await mkdtemp(join(tmpdir(), 'deltix-grpc-certs-addons-'));
  const { certPath, keyPath } = await generateSelfSignedCert(certDir);

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
      DELTIX_GRPC_TLS_CERT_PATH: certPath,
      DELTIX_GRPC_TLS_KEY_PATH: keyPath,
      DELTIX_GRPC_PORT: String(41000 + Math.floor(Math.random() * 5000)),
      HTTP_PORT: String(httpPort),
      LOG_PRETTY: 'false',
      ...extraEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  await new Promise((resolve) => setTimeout(resolve, 1200));
  return proc;
}

describe('addons boot smoke test (real subprocess, real signed addon packages)', () => {
  let repoPath: string;
  const cleanupDirs: string[] = [];

  beforeAll(async () => {
    repoPath = await initTempDoltRepo();
  });

  afterAll(async () => {
    await rm(repoPath, { recursive: true, force: true });
    await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('loads a trusted community addon and an official addon; both serve real HTTP routes', async () => {
    const httpPort = 33000 + Math.floor(Math.random() * 3000);

    // Official addon (signed with Deltix's own license keypair).
    const officialKeypair = generateTestKeypair();
    const officialDir = await mkdtemp(join(tmpdir(), 'deltix-addon-official-'));
    cleanupDirs.push(officialDir);
    await writeAddonPackage({
      dir: officialDir,
      name: 'deltix-metrics',
      tier: 'official',
      capabilities: ['http:route'],
      signWithPrivateKeyPem: officialKeypair.privateKeyPem,
      routePath: '/addons/metrics',
    });

    // Trusted community addon (TOFU: its author key is pre-registered).
    const communityKeypair = generateTestKeypair();
    const communityDir = await mkdtemp(join(tmpdir(), 'deltix-addon-community-'));
    cleanupDirs.push(communityDir);
    await writeAddonPackage({
      dir: communityDir,
      name: 'community-widget',
      tier: 'community',
      capabilities: ['http:route'],
      signWithPrivateKeyPem: communityKeypair.privateKeyPem,
      authorPublicKeyBase64: communityKeypair.publicKeyBase64,
      routePath: '/addons/widget',
    });

    const trustDbPath = join(await mkdtemp(join(tmpdir(), 'deltix-addon-trust-')), 'trust.db');
    const trustStore = new LibsqlAddonTrustStore(trustDbPath);
    await trustStore.init();
    await trustStore.trust({
      addonName: 'community-widget',
      authorPublicKey: communityKeypair.publicKeyBase64,
      trustedAt: Date.now(),
      trustedBy: 'smoke-test-setup',
    });

    const proc = await spawnServer(repoPath, httpPort, {
      DELTIX_LICENSE_PUBLIC_KEY: officialKeypair.publicKeyBase64,
      DELTIX_LICENSE_KEY: signLicensePayload(
        {
          ...buildDefaultPayload(),
          addons: {
            official: ['deltix-metrics'],
            communityAddonsEnabled: true,
            maxCommunityAddons: 10,
          },
        },
        officialKeypair.privateKeyPem,
      ),
      DELTIX_ADDON_PATHS: `${officialDir},${communityDir}`,
      DELTIX_ADDON_TRUST_DB_PATH: trustDbPath,
    });

    try {
      const officialRes = await fetch(`http://127.0.0.1:${httpPort}/addons/metrics`);
      expect(officialRes.status).toBe(200);
      expect(await officialRes.json()).toEqual({ addon: 'deltix-metrics', ok: true });

      const communityRes = await fetch(`http://127.0.0.1:${httpPort}/addons/widget`);
      expect(communityRes.status).toBe(200);
      expect(await communityRes.json()).toEqual({ addon: 'community-widget', ok: true });
    } finally {
      proc.kill();
    }
  });

  it('refuses an UNTRUSTED community addon (no TOFU record) without crashing the control plane', async () => {
    const httpPort = 36000 + Math.floor(Math.random() * 3000);

    const officialKeypair = generateTestKeypair();
    const untrustedKeypair = generateTestKeypair();
    const untrustedDir = await mkdtemp(join(tmpdir(), 'deltix-addon-untrusted-'));
    cleanupDirs.push(untrustedDir);
    await writeAddonPackage({
      dir: untrustedDir,
      name: 'shady-widget',
      tier: 'community',
      capabilities: ['http:route'],
      signWithPrivateKeyPem: untrustedKeypair.privateKeyPem,
      authorPublicKeyBase64: untrustedKeypair.publicKeyBase64,
      routePath: '/addons/shady',
    });

    const trustDbPath = join(
      await mkdtemp(join(tmpdir(), 'deltix-addon-trust-empty-')),
      'trust.db',
    );
    // Deliberately never registering a trust record for this addon's key.
    const trustStore = new LibsqlAddonTrustStore(trustDbPath);
    await trustStore.init();

    const proc = await spawnServer(repoPath, httpPort, {
      DELTIX_LICENSE_PUBLIC_KEY: officialKeypair.publicKeyBase64,
      DELTIX_LICENSE_KEY: signLicensePayload(buildDefaultPayload(), officialKeypair.privateKeyPem),
      DELTIX_ADDON_PATHS: untrustedDir,
      DELTIX_ADDON_TRUST_DB_PATH: trustDbPath,
    });

    try {
      // The addon's route must never have been registered.
      const res = await fetch(`http://127.0.0.1:${httpPort}/addons/shady`).catch(() => null);
      expect(res === null || res.status === 404).toBe(true);

      // But the control plane itself must still be alive and answering.
      const healthRes = await fetch(`http://127.0.0.1:${httpPort}/`).catch(() => null);
      expect(healthRes).not.toBeNull();
    } finally {
      proc.kill();
    }
  });
});
