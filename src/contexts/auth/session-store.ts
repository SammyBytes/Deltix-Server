export interface StoredSession {
  username: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Persistence port for refresh-token sessions. `SlidingWindowSessionManager`
 * depends on this interface, not a concrete database — this is the one case
 * in this codebase where a swappable implementation is justified, since
 * Fase 2 uses libSQL but tests need an in-memory double and the storage
 * engine may change later without touching session semantics.
 */
export interface SessionStore {
  create(refreshToken: string, username: string, expiresAt: number): Promise<void>;
  get(refreshToken: string): Promise<StoredSession | null>;
  touch(refreshToken: string, newExpiresAt: number): Promise<void>;
  revoke(refreshToken: string): Promise<void>;
  countActiveSessionsForUser(username: string, now: number): Promise<number>;
}
