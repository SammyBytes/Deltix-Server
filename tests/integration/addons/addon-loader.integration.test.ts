/**
 * Integration tests for the fail-closed addon loader: exercises the real
 * pipeline (manifest -> capabilities -> signature -> license -> import())
 * against real temp-directory addon packages and a real in-memory trust
 * store, per this project's "test the real thing" convention.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { rm } from 'node:fs/promises';
import {
  type AddonLoadDeps,
  assertWithinCommunityAddonLimit,
  loadAddon,
} from '../../../src/contexts/addons/addon-loader';
import type { AddonTrustStore } from '../../../src/contexts/addons/addon-trust-store';
import {
  AddonLicenseDeniedError,
  AddonLimitExceededError,
  AddonManifestInvalidError,
  AddonNotTrustedError,
  AddonSignatureInvalidError,
} from '../../../src/contexts/addons/errors';
import type { AddonTrustRecord } from '../../../src/contexts/addons/types';
import { buildSignedAddonPackage } from '../../fixtures/addon-fixtures';
import { generateTestKeypair } from '../../fixtures/license-fixtures';

function fakeTrustStore(initial: AddonTrustRecord[] = []): AddonTrustStore {
  const records = new Map(initial.map((r) => [r.addonName, r]));
  return {
    async trust(record) {
      records.set(record.addonName, record);
    },
    async getTrustedKey(addonName) {
      return records.get(addonName) ?? null;
    },
    async revokeTrust(addonName) {
      records.delete(addonName);
    },
    async listTrusted() {
      return [...records.values()];
    },
  };
}

function baseDeps(overrides: Partial<AddonLoadDeps> = {}): AddonLoadDeps {
  const officialKeypair = generateTestKeypair();
  return {
    officialPublicKey: officialKeypair.publicKeyBase64,
    trustStore: fakeTrustStore(),
    addonsConfig: { official: [], communityAddonsEnabled: true, maxCommunityAddons: 10 },
    freeOfficialAddons: [],
    buildContext: (addonName, grantedCapabilities) => ({ addonName, grantedCapabilities }),
    ...overrides,
  };
}

const cleanupDirs: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('addon-loader loadAddon (integration, real files)', () => {
  it('loads a valid official addon signed with the Deltix key', async () => {
    const officialKeypair = generateTestKeypair();
    const { addonDir, manifest } = await buildSignedAddonPackage({
      name: 'metrics-addon',
      tier: 'official',
      signWithKeypair: officialKeypair,
    });
    cleanupDirs.push(addonDir);

    const deps = baseDeps({
      officialPublicKey: officialKeypair.publicKeyBase64,
      freeOfficialAddons: ['metrics-addon'],
    });

    const result = await loadAddon(addonDir, deps);
    expect(result.manifest.name).toBe(manifest.name);
    expect(typeof result.module.activate).toBe('function');
  });

  it('loads a valid community addon trusted via TOFU', async () => {
    const { addonDir, manifest, keypair } = await buildSignedAddonPackage({
      name: 'community-tool',
      tier: 'community',
    });
    cleanupDirs.push(addonDir);

    const deps = baseDeps({
      trustStore: fakeTrustStore([
        {
          addonName: 'community-tool',
          authorPublicKey: keypair.publicKeyBase64,
          trustedAt: Date.now(),
          trustedBy: 'admin',
        },
      ]),
    });

    const result = await loadAddon(addonDir, deps);
    expect(result.manifest.name).toBe(manifest.name);
  });

  it('rejects a malformed manifest', async () => {
    const { addonDir } = await buildSignedAddonPackage({ name: 'broken' });
    cleanupDirs.push(addonDir);
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await writeFile(join(addonDir, 'addon.manifest.json'), 'not json', 'utf8');

    await expect(loadAddon(addonDir, baseDeps())).rejects.toThrow(AddonManifestInvalidError);
  });

  it('rejects an unrecognized capability (caught by manifest schema validation)', async () => {
    const { addonDir } = await buildSignedAddonPackage({ name: 'sneaky' });
    cleanupDirs.push(addonDir);
    const { writeFile, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const manifestPath = join(addonDir, 'addon.manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.capabilities = ['fs:write'];
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    await expect(loadAddon(addonDir, baseDeps())).rejects.toThrow(AddonManifestInvalidError);
  });

  it('rejects an official addon with a missing signature file', async () => {
    const { addonDir } = await buildSignedAddonPackage({
      name: 'no-sig',
      tier: 'official',
      omitSignature: true,
    });
    cleanupDirs.push(addonDir);

    await expect(loadAddon(addonDir, baseDeps())).rejects.toThrow(AddonSignatureInvalidError);
  });

  it('rejects an official addon signed with the wrong key', async () => {
    const wrongKeypair = generateTestKeypair();
    const { addonDir } = await buildSignedAddonPackage({
      name: 'forged',
      tier: 'official',
      signWithKeypair: wrongKeypair,
    });
    cleanupDirs.push(addonDir);

    await expect(loadAddon(addonDir, baseDeps())).rejects.toThrow(AddonSignatureInvalidError);
  });

  it('rejects a community addon with no TOFU trust record', async () => {
    const { addonDir } = await buildSignedAddonPackage({ name: 'untrusted', tier: 'community' });
    cleanupDirs.push(addonDir);

    await expect(loadAddon(addonDir, baseDeps())).rejects.toThrow(AddonNotTrustedError);
  });

  it('rejects a community addon whose signature does not match the trusted key (rotation without re-trust)', async () => {
    const { addonDir } = await buildSignedAddonPackage({ name: 'rotated', tier: 'community' });
    cleanupDirs.push(addonDir);
    const otherKeypair = generateTestKeypair();

    const deps = baseDeps({
      trustStore: fakeTrustStore([
        {
          addonName: 'rotated',
          authorPublicKey: otherKeypair.publicKeyBase64,
          trustedAt: Date.now(),
          trustedBy: 'admin',
        },
      ]),
    });

    await expect(loadAddon(addonDir, deps)).rejects.toThrow(AddonSignatureInvalidError);
  });

  it('rejects an official addon not authorized by the license', async () => {
    const officialKeypair = generateTestKeypair();
    const { addonDir } = await buildSignedAddonPackage({
      name: 'enterprise-only',
      tier: 'official',
      signWithKeypair: officialKeypair,
    });
    cleanupDirs.push(addonDir);

    const deps = baseDeps({
      officialPublicKey: officialKeypair.publicKeyBase64,
      freeOfficialAddons: [],
    });

    await expect(loadAddon(addonDir, deps)).rejects.toThrow(AddonLicenseDeniedError);
  });

  it('rejects a community addon when the license disables community addons', async () => {
    const { addonDir, keypair } = await buildSignedAddonPackage({
      name: 'blocked',
      tier: 'community',
    });
    cleanupDirs.push(addonDir);

    const deps = baseDeps({
      addonsConfig: { official: [], communityAddonsEnabled: false, maxCommunityAddons: 10 },
      trustStore: fakeTrustStore([
        {
          addonName: 'blocked',
          authorPublicKey: keypair.publicKeyBase64,
          trustedAt: Date.now(),
          trustedBy: 'admin',
        },
      ]),
    });

    await expect(loadAddon(addonDir, deps)).rejects.toThrow(AddonLicenseDeniedError);
  });

  it('rejects an entrypoint that does not default-export an activate() function', async () => {
    const officialKeypair = generateTestKeypair();
    const { addonDir } = await buildSignedAddonPackage({
      name: 'no-activate',
      tier: 'official',
      signWithKeypair: officialKeypair,
      entrypointSource: 'export default { notActivate() {} };\n',
    });
    cleanupDirs.push(addonDir);

    const deps = baseDeps({
      officialPublicKey: officialKeypair.publicKeyBase64,
      freeOfficialAddons: ['no-activate'],
    });

    await expect(loadAddon(addonDir, deps)).rejects.toThrow(AddonManifestInvalidError);
  });
});

describe('assertWithinCommunityAddonLimit', () => {
  it('allows a count at or below the limit', () => {
    expect(() =>
      assertWithinCommunityAddonLimit(10, {
        official: [],
        communityAddonsEnabled: true,
        maxCommunityAddons: 10,
      }),
    ).not.toThrow();
  });

  it('rejects a count above the limit', () => {
    expect(() =>
      assertWithinCommunityAddonLimit(11, {
        official: [],
        communityAddonsEnabled: true,
        maxCommunityAddons: 10,
      }),
    ).toThrow(AddonLimitExceededError);
  });

  it('allows any count when the limit is null (unlimited, enterprise tier)', () => {
    expect(() =>
      assertWithinCommunityAddonLimit(999, {
        official: [],
        communityAddonsEnabled: true,
        maxCommunityAddons: null,
      }),
    ).not.toThrow();
  });
});
