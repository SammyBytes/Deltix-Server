import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibsqlUserStore } from '../../../src/contexts/auth/libsql-user-store';

describe('auth/libsql-user-store (integration, real libSQL file)', () => {
  let dbPath: string;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deltix-user-store-'));
    dbPath = join(dir, 'auth-users-store.db');
  });

  afterEach(async () => {
    await rm(dbPath, { force: true });
    await rm(`${dbPath}-wal`, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
  });

  it('creates, lists and updates users with analytics fields', async () => {
    const store = new LibsqlUserStore(dbPath);
    await store.init();

    await store.create({
      username: 'alice',
      passwordHash: 'hash',
      createdAt: 1000,
      createdBy: 'setup',
      active: true,
      lastLoginAt: null,
      isGlobalAdmin: false,
    });
    await store.updateLastLogin('alice', 2000);
    await store.setActive('alice', false);

    const user = await store.getByUsername('alice');
    expect(user?.createdBy).toBe('setup');
    expect(user?.active).toBe(false);
    expect(user?.lastLoginAt).toBe(2000);
  });

  it('tryCreateFirstUser is race-safe and only creates once', async () => {
    const store = new LibsqlUserStore(dbPath);
    await store.init();

    const attempts = await Promise.all([
      store.tryCreateFirstUser({
        username: 'alice',
        passwordHash: 'hash',
        createdAt: 1000,
        createdBy: 'setup',
        active: true,
        lastLoginAt: null,
        isGlobalAdmin: false,
      }),
      store.tryCreateFirstUser({
        username: 'bob',
        passwordHash: 'hash',
        createdAt: 1001,
        createdBy: 'setup',
        active: true,
        lastLoginAt: null,
        isGlobalAdmin: false,
      }),
    ]);

    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await store.count()).toBe(1);
  });
});
