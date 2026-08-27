/**
 * Test-only helper to build a real signed addon package on disk (manifest +
 * entrypoint + signature file), for integration tests of `loadAddon()`.
 * Mirrors `tests/fixtures/license-fixtures.ts`'s keypair generation.
 */

import { sign } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddonManifest } from '@deltix/addon-sdk';
import { buildSignedPayload } from '../../src/contexts/addons/addon-signature';
import { generateTestKeypair, type TestKeypair } from './license-fixtures';

export interface BuiltAddonPackage {
  addonDir: string;
  manifest: AddonManifest;
  keypair: TestKeypair;
}

export interface BuildSignedAddonOptions {
  name?: string;
  tier?: 'official' | 'community';
  capabilities?: AddonManifest['capabilities'];
  entrypointSource?: string;
  /** Sign with a different keypair than the one returned (to simulate a bad/foreign signature). */
  signWithKeypair?: TestKeypair;
  /** Skip writing the signature file entirely. */
  omitSignature?: boolean;
}

export async function buildSignedAddonPackage(
  options: BuildSignedAddonOptions = {},
): Promise<BuiltAddonPackage> {
  const addonDir = await mkdtemp(join(tmpdir(), 'deltix-addon-'));
  const keypair = generateTestKeypair();

  const manifest: AddonManifest = {
    name: options.name ?? 'sample-addon',
    version: '1.0.0',
    tier: options.tier ?? 'official',
    entrypoint: 'index.js',
    capabilities: options.capabilities ?? ['http:route'],
    ...(options.tier === 'community' ? { authorPublicKey: keypair.publicKeyBase64 } : {}),
  };

  const manifestJson = JSON.stringify(manifest, null, 2);
  const entrypointSource =
    options.entrypointSource ?? 'export default { activate() { /* no-op test addon */ } };\n';

  await writeFile(join(addonDir, 'addon.manifest.json'), manifestJson, 'utf8');
  await writeFile(join(addonDir, 'index.js'), entrypointSource, 'utf8');

  if (!options.omitSignature) {
    const manifestBytes = new TextEncoder().encode(manifestJson);
    const entrypointBytes = new TextEncoder().encode(entrypointSource);
    const payload = buildSignedPayload(manifestBytes, entrypointBytes);
    const signWith = options.signWithKeypair ?? keypair;
    const signature = sign(null, payload, signWith.privateKeyPem);
    await writeFile(join(addonDir, 'addon.sig'), signature);
  }

  return { addonDir, manifest, keypair };
}
