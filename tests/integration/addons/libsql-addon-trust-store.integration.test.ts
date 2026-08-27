import { afterEach, describe, expect, it } from 'bun:test';
import { rm } from 'node:fs/promises';
import { LibsqlAddonTrustStore } from '../../../src/contexts/addons/libsql-addon-trust-store';
import type { AddonTrustRecord } from '../../../src/contexts/addons/types';

function makeRecord(overrides: Partial<AddonTrustRecord> = {}): AddonTrustRecord {
  return {
    addonName: 'demo-addon',
    authorPublicKey: 'base64-fake-key',
    trustedAt: 1_000,
    trustedBy: 'admin@acme.test',
    ...overrides,
  };
}

describe('addons/libsql-addon-trust-store (integration, real libSQL file)', () => {
  const dbPath = `/tmp/deltix-addon-trust-test-${Date.now()}.db`;

  afterEach(async () => {
    await rm(dbPath, { force: true });
    await rm(`${dbPath}-wal`, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
  });

  it('trusts a new addon key and reads it back', async () => {
    const store = new LibsqlAddonTrustStore(dbPath);
    await store.init();

    const record = makeRecord();
    await store.trust(record);

    const stored = await store.getTrustedKey(record.addonName);
    expect(stored).toEqual(record);
  });

  it('returns null for an addon that was never trusted', async () => {
    const store = new LibsqlAddonTrustStore(dbPath);
    await store.init();

    expect(await store.getTrustedKey('unknown-addon')).toBeNull();
  });

  it('re-trusting the same addon name replaces the stored key (key rotation)', async () => {
    const store = new LibsqlAddonTrustStore(dbPath);
    await store.init();

    await store.trust(makeRecord({ authorPublicKey: 'old-key' }));
    await store.trust(makeRecord({ authorPublicKey: 'new-key', trustedAt: 2_000 }));

    const stored = await store.getTrustedKey('demo-addon');
    expect(stored?.authorPublicKey).toBe('new-key');
    expect(stored?.trustedAt).toBe(2_000);
  });

  it('revokeTrust() removes the trust record', async () => {
    const store = new LibsqlAddonTrustStore(dbPath);
    await store.init();

    await store.trust(makeRecord());
    await store.revokeTrust('demo-addon');

    expect(await store.getTrustedKey('demo-addon')).toBeNull();
  });

  it('revokeTrust() on an unknown addon is a safe no-op', async () => {
    const store = new LibsqlAddonTrustStore(dbPath);
    await store.init();

    await expect(store.revokeTrust('never-trusted')).resolves.toBeUndefined();
  });

  it('listTrusted() returns every currently-trusted addon', async () => {
    const store = new LibsqlAddonTrustStore(dbPath);
    await store.init();

    await store.trust(makeRecord({ addonName: 'addon-a' }));
    await store.trust(makeRecord({ addonName: 'addon-b' }));

    const trusted = await store.listTrusted();
    expect(trusted.map((r) => r.addonName).sort()).toEqual(['addon-a', 'addon-b']);
  });

  it('listTrusted() reflects revocation', async () => {
    const store = new LibsqlAddonTrustStore(dbPath);
    await store.init();

    await store.trust(makeRecord({ addonName: 'addon-a' }));
    await store.trust(makeRecord({ addonName: 'addon-b' }));
    await store.revokeTrust('addon-a');

    const trusted = await store.listTrusted();
    expect(trusted.map((r) => r.addonName)).toEqual(['addon-b']);
  });
});
