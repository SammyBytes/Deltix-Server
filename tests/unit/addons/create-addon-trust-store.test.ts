import { afterEach, describe, expect, it } from 'bun:test';
import { rm } from 'node:fs/promises';
import { createAddonTrustStore } from '../../../src/contexts/addons';
import type { Env } from '../../../src/shared/env';

function makeEnv(dbPath: string): Env {
  return { DELTIX_ADDON_TRUST_DB_PATH: dbPath } as Env;
}

describe('addons/createAddonTrustStore (unit, real libSQL file via factory)', () => {
  const dbPath = `/tmp/deltix-addon-trust-factory-test-${Date.now()}.db`;

  afterEach(async () => {
    await rm(dbPath, { force: true });
    await rm(`${dbPath}-wal`, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
  });

  it('wires a ready-to-use trust store from env (table already initialized)', async () => {
    const store = await createAddonTrustStore(makeEnv(dbPath));

    await store.trust({
      addonName: 'demo-addon',
      authorPublicKey: 'fake-key',
      trustedAt: 1,
      trustedBy: 'admin',
    });

    expect(await store.getTrustedKey('demo-addon')).not.toBeNull();
  });
});
