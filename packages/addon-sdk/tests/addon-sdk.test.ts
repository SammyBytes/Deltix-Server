import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ADDON_CAPABILITIES, addonManifestSchema, isAddonCapability } from '../src/index';

describe('addon-sdk capabilities', () => {
  test('exposes exactly the 4 closed capabilities', () => {
    expect(ADDON_CAPABILITIES).toEqual(['http:route', 'db:read', 'db:write', 'nas:read']);
  });

  test('isAddonCapability accepts known capabilities', () => {
    expect(isAddonCapability('http:route')).toBe(true);
    expect(isAddonCapability('db:read')).toBe(true);
  });

  test('isAddonCapability rejects unknown capabilities', () => {
    expect(isAddonCapability('fs:write')).toBe(false);
    expect(isAddonCapability('')).toBe(false);
  });
});

describe('addonManifestSchema', () => {
  const base = {
    name: 'sample-addon',
    version: '1.0.0',
    tier: 'official' as const,
    entrypoint: 'index.js',
    capabilities: ['http:route'] as const,
  };

  test('accepts a valid manifest', () => {
    const result = addonManifestSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  test('accepts a community manifest with authorPublicKey', () => {
    const result = addonManifestSchema.safeParse({
      ...base,
      tier: 'community',
      authorPublicKey: 'base64key',
    });
    expect(result.success).toBe(true);
  });

  test('rejects an unknown capability', () => {
    const result = addonManifestSchema.safeParse({ ...base, capabilities: ['fs:write'] });
    expect(result.success).toBe(false);
  });

  test('rejects an unknown tier', () => {
    const result = addonManifestSchema.safeParse({ ...base, tier: 'premium' });
    expect(result.success).toBe(false);
  });

  test('rejects a missing entrypoint', () => {
    const { entrypoint: _entrypoint, ...withoutEntrypoint } = base;
    const result = addonManifestSchema.safeParse(withoutEntrypoint);
    expect(result.success).toBe(false);
  });
});

describe('BSL boundary', () => {
  test('no source file in packages/addon-sdk/src imports from the BSL core (../../src)', async () => {
    const srcDir = join(import.meta.dir, '..', 'src');
    const files = await readdir(srcDir);
    for (const file of files) {
      const contents = await readFile(join(srcDir, file), 'utf8');
      expect(contents).not.toMatch(/from\s+['"](\.\.\/){2,}src/);
      expect(contents).not.toMatch(/from\s+['"]@deltix-server/);
    }
  });
});
