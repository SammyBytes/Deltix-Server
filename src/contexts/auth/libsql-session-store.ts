/**
 * Real libSQL-backed implementation of `SessionStore`. Uses parameterized
 * queries exclusively (never string-concatenated SQL — OWASP A03) via
 * `@libsql/client`. This is genuinely swappable persistence (see
 * `session-store.ts` for why an interface is justified here), but Fase 2
 * ships only this implementation.
 */
import { type Client, createClient } from '@libsql/client';
import type { SessionStore, StoredSession } from './session-store';

export class LibsqlSessionStore implements SessionStore {
  private readonly client: Client;

  constructor(dbPath: string) {
    this.client = createClient({ url: `file:${dbPath}` });
  }

  /** Creates the sessions table if it doesn't exist yet. Call once at boot. */
  async init(): Promise<void> {
    // WAL + busy_timeout keep a second connection readable during a write
    // (see libsql-transfer-job-store.ts).
    await this.client.execute('PRAGMA journal_mode = WAL');
    await this.client.execute('PRAGMA busy_timeout = 5000');
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS sessions (
        refresh_token TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
  }

  async create(refreshToken: string, username: string, expiresAt: number): Promise<void> {
    await this.client.execute({
      sql: 'INSERT INTO sessions (refresh_token, username, created_at, expires_at) VALUES (?, ?, ?, ?)',
      args: [refreshToken, username, Date.now(), expiresAt],
    });
  }

  async get(refreshToken: string): Promise<StoredSession | null> {
    const result = await this.client.execute({
      sql: 'SELECT username, created_at, expires_at FROM sessions WHERE refresh_token = ?',
      args: [refreshToken],
    });
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      username: row.username as string,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    };
  }

  async touch(refreshToken: string, newExpiresAt: number): Promise<void> {
    await this.client.execute({
      sql: 'UPDATE sessions SET expires_at = ? WHERE refresh_token = ?',
      args: [newExpiresAt, refreshToken],
    });
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.client.execute({
      sql: 'DELETE FROM sessions WHERE refresh_token = ?',
      args: [refreshToken],
    });
  }
  async countActiveSessionsForUser(username: string, now: number): Promise<number> {
    const result = await this.client.execute({
      sql: 'SELECT COUNT(*) AS count FROM sessions WHERE username = ? AND expires_at >= ?',
      args: [username, now],
    });
    return Number(result.rows[0]?.count ?? 0);
  }
}
