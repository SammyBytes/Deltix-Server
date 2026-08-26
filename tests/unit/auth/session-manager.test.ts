import { describe, expect, it } from 'bun:test';
import { SessionExpiredError, SessionNotFoundError } from '../../../src/contexts/auth/errors';
import { SlidingWindowSessionManager } from '../../../src/contexts/auth/session-manager';
import type { SessionStore } from '../../../src/contexts/auth/session-store';

function inMemoryStore(): SessionStore {
  const rows = new Map<string, { username: string; createdAt: number; expiresAt: number }>();
  return {
    async create(refreshToken, username, expiresAt) {
      rows.set(refreshToken, { username, createdAt: Date.now(), expiresAt });
    },
    async get(refreshToken) {
      return rows.get(refreshToken) ?? null;
    },
    async touch(refreshToken, newExpiresAt) {
      const row = rows.get(refreshToken);
      if (!row) return;
      row.expiresAt = newExpiresAt;
    },
    async revoke(refreshToken) {
      rows.delete(refreshToken);
    },
  };
}

describe('auth/session-manager (sliding window, not absolute TTL)', () => {
  it('creates a session that is valid immediately after creation', async () => {
    const now = 1_000_000;
    const manager = new SlidingWindowSessionManager(inMemoryStore(), 120, () => now);

    const token = await manager.createSession('alice');
    await expect(manager.assertActive(token)).resolves.toBeUndefined();
    void now;
  });

  it('extends the expiration window on keep-alive (sliding), not a fixed absolute deadline', async () => {
    let now = 1_000_000;
    const manager = new SlidingWindowSessionManager(inMemoryStore(), 120, () => now);
    const token = await manager.createSession('alice');

    now += 100_000; // 100s later, within the 120s window
    await expect(manager.assertActive(token)).resolves.toBeUndefined();

    await manager.keepAlive(token);
    now += 100_000; // another 100s — would have expired under a fixed TTL, but not sliding
    await expect(manager.assertActive(token)).resolves.toBeUndefined();
  });

  it('rejects a session that has expired due to inactivity', async () => {
    let now = 1_000_000;
    const manager = new SlidingWindowSessionManager(inMemoryStore(), 120, () => now);
    const token = await manager.createSession('alice');

    now += 121_000; // past the 120s inactivity window, no keep-alive sent
    await expect(manager.assertActive(token)).rejects.toThrow(SessionExpiredError);
  });

  it('rejects an unknown/revoked session token', async () => {
    const manager = new SlidingWindowSessionManager(inMemoryStore(), 120, () => 0);
    await expect(manager.assertActive('nonexistent-token')).rejects.toThrow(SessionNotFoundError);
  });

  it('revokes a session so it can no longer be used (logout)', async () => {
    const now = 1_000_000;
    const manager = new SlidingWindowSessionManager(inMemoryStore(), 120, () => now);
    const token = await manager.createSession('alice');

    await manager.revoke(token);
    await expect(manager.assertActive(token)).rejects.toThrow(SessionNotFoundError);
  });

  it('usernameFor returns the bound username for an active session', async () => {
    const now = 1_000_000;
    const manager = new SlidingWindowSessionManager(inMemoryStore(), 120, () => now);
    const token = await manager.createSession('alice');

    await expect(manager.usernameFor(token)).resolves.toBe('alice');
  });

  it('usernameFor rejects an expired session', async () => {
    let now = 1_000_000;
    const manager = new SlidingWindowSessionManager(inMemoryStore(), 120, () => now);
    const token = await manager.createSession('alice');

    now += 121_000;
    await expect(manager.usernameFor(token)).rejects.toThrow(SessionExpiredError);
  });
});
