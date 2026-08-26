/**
 * Sliding-window session lifecycle: a refresh-token session expires after
 * `ttlSeconds` of INACTIVITY, not a fixed absolute deadline. Every
 * `keepAlive()` call (the CLI's heartbeat, later phases) pushes the
 * expiration forward — this mirrors the exact guardrail mandated for the
 * gRPC transfer sessions in Fase 3, applied here to REST auth sessions.
 *
 * `now` is injectable so tests can simulate the passage of time without
 * real timers (see `contexts/licensing/license-validator.service.ts` for
 * the same pattern).
 */
import { randomBytes } from 'node:crypto';
import { SessionExpiredError, SessionNotFoundError } from './errors';
import type { SessionStore } from './session-store';

export class SlidingWindowSessionManager {
  constructor(
    private readonly store: SessionStore,
    private readonly ttlSeconds: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async createSession(username: string): Promise<string> {
    const refreshToken = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.ttlSeconds * 1000;
    await this.store.create(refreshToken, username, expiresAt);
    return refreshToken;
  }

  async assertActive(refreshToken: string): Promise<void> {
    const session = await this.store.get(refreshToken);
    if (!session) {
      throw new SessionNotFoundError();
    }
    if (this.now() > session.expiresAt) {
      throw new SessionExpiredError();
    }
  }

  /** Returns the username bound to an active session, or throws. */
  async usernameFor(refreshToken: string): Promise<string> {
    const session = await this.store.get(refreshToken);
    if (!session) {
      throw new SessionNotFoundError();
    }
    if (this.now() > session.expiresAt) {
      throw new SessionExpiredError();
    }
    return session.username;
  }

  /** Extends the inactivity window — called by the client's heartbeat loop. */
  async keepAlive(refreshToken: string): Promise<void> {
    await this.assertActive(refreshToken);
    const newExpiresAt = this.now() + this.ttlSeconds * 1000;
    await this.store.touch(refreshToken, newExpiresAt);
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.store.revoke(refreshToken);
  }
}
