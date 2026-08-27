import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import type { LegacyUserRecord, UserRecord, UserStore } from './user-store';

function rowToUser(row: Record<string, unknown>): UserRecord {
  return {
    username: row.username as string,
    passwordHash: row.password_hash as string,
    createdAt: Number(row.created_at),
    createdBy: row.created_by as string,
    active: Number(row.active) === 1,
    lastLoginAt:
      row.last_login_at === null || row.last_login_at === undefined
        ? null
        : Number(row.last_login_at),
  };
}

export class LibsqlUserStore implements UserStore {
  private readonly client: Client;

  constructor(
    dbPath: string,
    private readonly legacySeedUsers: LegacyUserRecord[] = [],
  ) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.client = createClient({ url: `file:${dbPath}` });
  }

  async init(): Promise<void> {
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        active INTEGER NOT NULL,
        last_login_at INTEGER
      )
    `);
  }

  async count(): Promise<number> {
    const result = await this.client.execute('SELECT COUNT(*) AS count FROM users');
    return Number(result.rows[0]?.count ?? 0);
  }

  async list(): Promise<UserRecord[]> {
    const result = await this.client.execute(
      `SELECT username, password_hash, created_at, created_by, active, last_login_at
       FROM users
       ORDER BY created_at ASC, username ASC`,
    );
    return result.rows.map((row) => rowToUser(row as unknown as Record<string, unknown>));
  }

  async getByUsername(username: string): Promise<UserRecord | null> {
    const result = await this.client.execute({
      sql: `SELECT username, password_hash, created_at, created_by, active, last_login_at
            FROM users WHERE username = ?`,
      args: [username],
    });
    const row = result.rows[0];
    return row ? rowToUser(row as unknown as Record<string, unknown>) : null;
  }

  async create(user: UserRecord): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO users (username, password_hash, created_at, created_by, active, last_login_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        user.username,
        user.passwordHash,
        user.createdAt,
        user.createdBy,
        user.active ? 1 : 0,
        user.lastLoginAt,
      ],
    });
  }

  async setActive(username: string, active: boolean): Promise<boolean> {
    const result = await this.client.execute({
      sql: 'UPDATE users SET active = ? WHERE username = ?',
      args: [active ? 1 : 0, username],
    });
    return result.rowsAffected === 1;
  }

  async delete(username: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: 'DELETE FROM users WHERE username = ?',
      args: [username],
    });
    return result.rowsAffected === 1;
  }

  async updateLastLogin(username: string, lastLoginAt: number): Promise<boolean> {
    const result = await this.client.execute({
      sql: 'UPDATE users SET last_login_at = ? WHERE username = ?',
      args: [lastLoginAt, username],
    });
    return result.rowsAffected === 1;
  }

  async tryCreateFirstUser(user: UserRecord): Promise<boolean> {
    const result = await this.client.execute({
      sql: `INSERT INTO users (username, password_hash, created_at, created_by, active, last_login_at)
            SELECT ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM users LIMIT 1)`,
      args: [
        user.username,
        user.passwordHash,
        user.createdAt,
        user.createdBy,
        user.active ? 1 : 0,
        user.lastLoginAt,
      ],
    });
    return result.rowsAffected === 1;
  }

  async legacyUsers(): Promise<LegacyUserRecord[]> {
    return this.legacySeedUsers;
  }
}
