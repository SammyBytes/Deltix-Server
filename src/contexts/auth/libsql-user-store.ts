import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import type { RepoRole, RepoRoleAssignment } from './types';
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
    // Older rows created before this column existed default to non-admin —
    // see the ALTER TABLE migration below and `ensureBootstrapAdmin()`
    // in AuthService, which promotes an existing sole user rather than
    // leaving every pre-existing installation locked out of its own panel.
    isGlobalAdmin: Number(row.is_global_admin ?? 0) === 1,
  };
}

function rowToRepoRoleAssignment(row: Record<string, unknown>): RepoRoleAssignment {
  return {
    username: row.username as string,
    repoId: row.repo_id as string,
    role: row.role as RepoRole,
    grantedAt: Number(row.granted_at),
    grantedBy: row.granted_by as string,
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
        last_login_at INTEGER,
        is_global_admin INTEGER NOT NULL DEFAULT 0
      )
    `);
    // Migration for databases created before `is_global_admin` existed.
    await this.client
      .execute(`ALTER TABLE users ADD COLUMN is_global_admin INTEGER NOT NULL DEFAULT 0`.trim())
      .catch(() => {});
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS repo_roles (
        username TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        role TEXT NOT NULL,
        granted_at INTEGER NOT NULL,
        granted_by TEXT NOT NULL,
        PRIMARY KEY (username, repo_id),
        FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
      )
    `);
  }

  async count(): Promise<number> {
    const result = await this.client.execute('SELECT COUNT(*) AS count FROM users');
    return Number(result.rows[0]?.count ?? 0);
  }

  async list(): Promise<UserRecord[]> {
    const result = await this.client.execute(
      `SELECT username, password_hash, created_at, created_by, active, last_login_at, is_global_admin
       FROM users
       ORDER BY created_at ASC, username ASC`,
    );
    return result.rows.map((row) => rowToUser(row as unknown as Record<string, unknown>));
  }

  async getByUsername(username: string): Promise<UserRecord | null> {
    const result = await this.client.execute({
      sql: `SELECT username, password_hash, created_at, created_by, active, last_login_at, is_global_admin
            FROM users WHERE username = ?`,
      args: [username],
    });
    const row = result.rows[0];
    return row ? rowToUser(row as unknown as Record<string, unknown>) : null;
  }

  async create(user: UserRecord): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO users (username, password_hash, created_at, created_by, active, last_login_at, is_global_admin)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        user.username,
        user.passwordHash,
        user.createdAt,
        user.createdBy,
        user.active ? 1 : 0,
        user.lastLoginAt,
        user.isGlobalAdmin ? 1 : 0,
      ],
    });
  }

  async setGlobalAdmin(username: string, isGlobalAdmin: boolean): Promise<boolean> {
    const result = await this.client.execute({
      sql: 'UPDATE users SET is_global_admin = ? WHERE username = ?',
      args: [isGlobalAdmin ? 1 : 0, username],
    });
    return result.rowsAffected === 1;
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
      sql: `INSERT INTO users (username, password_hash, created_at, created_by, active, last_login_at, is_global_admin)
            SELECT ?, ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM users LIMIT 1)`,
      args: [
        user.username,
        user.passwordHash,
        user.createdAt,
        user.createdBy,
        user.active ? 1 : 0,
        user.lastLoginAt,
        user.isGlobalAdmin ? 1 : 0,
      ],
    });
    return result.rowsAffected === 1;
  }

  async legacyUsers(): Promise<LegacyUserRecord[]> {
    return this.legacySeedUsers;
  }

  async getRepoRole(username: string, repoId: string): Promise<RepoRole | null> {
    const result = await this.client.execute({
      sql: 'SELECT role FROM repo_roles WHERE username = ? AND repo_id = ?',
      args: [username, repoId],
    });
    const row = result.rows[0];
    return row ? (row.role as RepoRole) : null;
  }

  async listRepoRoles(repoId: string): Promise<RepoRoleAssignment[]> {
    const result = await this.client.execute({
      sql: `SELECT username, repo_id, role, granted_at, granted_by
            FROM repo_roles
            WHERE repo_id = ?
            ORDER BY username ASC`,
      args: [repoId],
    });
    return result.rows.map((row) => rowToRepoRoleAssignment(row as Record<string, unknown>));
  }

  async upsertRepoRole(assignment: RepoRoleAssignment): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO repo_roles (username, repo_id, role, granted_at, granted_by)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(username, repo_id) DO UPDATE SET
              role = excluded.role,
              granted_at = excluded.granted_at,
              granted_by = excluded.granted_by`,
      args: [
        assignment.username,
        assignment.repoId,
        assignment.role,
        assignment.grantedAt,
        assignment.grantedBy,
      ],
    });
  }

  async deleteRepoRole(username: string, repoId: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: 'DELETE FROM repo_roles WHERE username = ? AND repo_id = ?',
      args: [username, repoId],
    });
    return result.rowsAffected === 1;
  }
}
