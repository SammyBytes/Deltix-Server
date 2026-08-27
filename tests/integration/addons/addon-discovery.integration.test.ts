/**
 * Integration tests for the boot-time addon discovery orchestrator:
 * discovers addon dirs from a CSV path list, enforces the community limit
 * across the whole set, and loads each addon independently (one bad addon
 * must not abort the others).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { rm } from 'node:fs/promises';
import { discoverAndLoadAddons } from '../../../src/contexts/addons/addon-discovery';
import type { AddonLoadDeps } from '../../../src/contexts/addons/addon-loader';
import type { AddonTrustStore } from '../../../src/contexts/addons/addon-trust-store';
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

const cleanupDirs: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('discoverAndLoadAddons (integration, real files)', () => {
  it('loads all valid addons and reports no failures', async () => {
    const officialKeypair = generateTestKeypair();
    const a = await buildSignedAddonPackage({
      name: 'addon-a',
      tier: 'official',
      signWithKeypair: officialKeypair,
    });
    const b = await buildSignedAddonPackage({
      name: 'addon-b',
      tier: 'official',
      signWithKeypair: officialKeypair,
    });
    cleanupDirs.push(a.addonDir, b.addonDir);

    const deps: AddonLoadDeps = {
      officialPublicKey: officialKeypair.publicKeyBase64,
      trustStore: fakeTrustStore(),
      addonsConfig: { official: [], communityAddonsEnabled: true, maxCommunityAddons: 10 },
      freeOfficialAddons: ['addon-a', 'addon-b'],
      buildContext: (addonName, grantedCapabilities) => ({ addonName, grantedCapabilities }),
    };

    const result = await discoverAndLoadAddons(`${a.addonDir},${b.addonDir}`, deps);
    expect(result.loaded).toHaveLength(2);
    expect(result.failures).toHaveLength(0);
  });

  it('loads valid addons and collects failures for broken ones without aborting the batch', async () => {
    const officialKeypair = generateTestKeypair();
    const good = await buildSignedAddonPackage({
      name: 'good-addon',
      tier: 'official',
      signWithKeypair: officialKeypair,
    });
    const bad = await buildSignedAddonPackage({
      name: 'bad-addon',
      tier: 'official',
      omitSignature: true,
    });
    cleanupDirs.push(good.addonDir, bad.addonDir);

    const deps: AddonLoadDeps = {
      officialPublicKey: officialKeypair.publicKeyBase64,
      trustStore: fakeTrustStore(),
      addonsConfig: { official: [], communityAddonsEnabled: true, maxCommunityAddons: 10 },
      freeOfficialAddons: ['good-addon', 'bad-addon'],
      buildContext: (addonName, grantedCapabilities) => ({ addonName, grantedCapabilities }),
    };

    const result = await discoverAndLoadAddons(`${good.addonDir},${bad.addonDir}`, deps);
    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0]?.manifest.name).toBe('good-addon');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.addonDir).toBe(bad.addonDir);
  });

  it('rejects the whole batch when discovered community addons exceed the license limit', async () => {
    const c1 = await buildSignedAddonPackage({ name: 'c1', tier: 'community' });
    const c2 = await buildSignedAddonPackage({ name: 'c2', tier: 'community' });
    cleanupDirs.push(c1.addonDir, c2.addonDir);

    const deps: AddonLoadDeps = {
      officialPublicKey: generateTestKeypair().publicKeyBase64,
      trustStore: fakeTrustStore([
        {
          addonName: 'c1',
          authorPublicKey: c1.keypair.publicKeyBase64,
          trustedAt: Date.now(),
          trustedBy: 'admin',
        },
        {
          addonName: 'c2',
          authorPublicKey: c2.keypair.publicKeyBase64,
          trustedAt: Date.now(),
          trustedBy: 'admin',
        },
      ]),
      addonsConfig: { official: [], communityAddonsEnabled: true, maxCommunityAddons: 1 },
      freeOfficialAddons: [],
      buildContext: (addonName, grantedCapabilities) => ({ addonName, grantedCapabilities }),
    };

    await expect(discoverAndLoadAddons(`${c1.addonDir},${c2.addonDir}`, deps)).rejects.toThrow();
  });

  it('returns empty results for an empty path list', async () => {
    const deps: AddonLoadDeps = {
      officialPublicKey: generateTestKeypair().publicKeyBase64,
      trustStore: fakeTrustStore(),
      addonsConfig: { official: [], communityAddonsEnabled: true, maxCommunityAddons: 10 },
      freeOfficialAddons: [],
      buildContext: (addonName, grantedCapabilities) => ({ addonName, grantedCapabilities }),
    };

    const result = await discoverAndLoadAddons('', deps);
    expect(result.loaded).toHaveLength(0);
    expect(result.failures).toHaveLength(0);
  });
});
