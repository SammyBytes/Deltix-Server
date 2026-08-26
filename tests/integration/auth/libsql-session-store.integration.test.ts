import { afterEach, describe, expect, it } from 'bun:test';
import { rm } from 'node:fs/promises';
import { LibsqlSessionStore } from '../../../src/contexts/auth/libsql-session-store';

describe('auth/libsql-session-store (integration, real libSQL file)', () => {
  const dbPath = `/tmp/deltix-auth-sessions-test-${Date.now()}.db`;

  afterEach(async () => {
    await rm(dbPath, { force: true });
    await rm(`${dbPath}-wal`, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
  });

  it('creates and reads back a session row', async () => {
    const store = new LibsqlSessionStore(dbPath);
    await store.init();

    await store.create('token-abc', 'alice', 1_700_000_000_000);
    const session = await store.get('token-abc');

    expect(session?.username).toBe('alice');
    expect(session?.expiresAt).toBe(1_700_000_000_000);
  });

  it('returns null for an unknown session token', async () => {
    const store = new LibsqlSessionStore(dbPath);
    await store.init();

    expect(await store.get('nonexistent')).toBeNull();
  });

  it('touch() updates the expiration of an existing session', async () => {
    const store = new LibsqlSessionStore(dbPath);
    await store.init();

    await store.create('token-abc', 'alice', 1_000);
    await store.touch('token-abc', 2_000);

    const session = await store.get('token-abc');
    expect(session?.expiresAt).toBe(2_000);
  });

  it('revoke() removes the session so it can no longer be read back', async () => {
    const store = new LibsqlSessionStore(dbPath);
    await store.init();

    await store.create('token-abc', 'alice', 1_000);
    await store.revoke('token-abc');

    expect(await store.get('token-abc')).toBeNull();
  });

  it('persists sessions across store instances backed by the same file (real durability)', async () => {
    const store1 = new LibsqlSessionStore(dbPath);
    await store1.init();
    await store1.create('token-xyz', 'bob', 5_000);

    const store2 = new LibsqlSessionStore(dbPath);
    await store2.init();
    const session = await store2.get('token-xyz');

    expect(session?.username).toBe('bob');
  });

  it('handles concurrent create() calls for distinct sessions without corrupting the file', async () => {
    const store = new LibsqlSessionStore(dbPath);
    await store.init();

    const creations = Array.from({ length: 25 }, (_, i) =>
      store.create(`token-concurrent-${i}`, `user-${i}`, 1_000 + i),
    );
    await Promise.all(creations);

    const reads = await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.get(`token-concurrent-${i}`)),
    );

    for (const [i, session] of reads.entries()) {
      expect(session?.username).toBe(`user-${i}`);
    }
  });

  it('handles concurrent touch() calls on distinct sessions without cross-contamination', async () => {
    const store = new LibsqlSessionStore(dbPath);
    await store.init();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.create(`token-touch-${i}`, 'user', 0)),
    );

    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.touch(`token-touch-${i}`, 9_000 + i)),
    );

    const reads = await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.get(`token-touch-${i}`)),
    );
    for (const [i, session] of reads.entries()) {
      expect(session?.expiresAt).toBe(9_000 + i);
    }
  });
});
