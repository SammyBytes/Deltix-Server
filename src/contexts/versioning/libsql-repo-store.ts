/**
 * Real libSQL-backed implementation of `RepoStore`. Uses parameterized
 * queries exclusively (never string-concatenated SQL — OWASP A03),
 * mirroring `contexts/addons/libsql-addon-trust-store.ts`'s pattern.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import type { RepoStore } from './repo-store';
import type { RepoRecord, RepoSyncPreferenceSummary } from './types';

export class LibsqlRepoStore implements RepoStore {
  private readonly client: Client;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.client = createClient({ url: `file:${dbPath}` });
  }

  async init(): Promise<void> {
    // WAL + busy_timeout keep a second connection readable during a write
    // (see libsql-transfer-job-store.ts).
    await this.client.execute('PRAGMA journal_mode = WAL');
    await this.client.execute('PRAGMA busy_timeout = 5000');
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS repos (
        repo_id TEXT PRIMARY KEY,
        dolt_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL
      )
    `);
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS repo_sync_preferences (
        repo_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        requested_tables_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (repo_id) REFERENCES repos(repo_id) ON DELETE CASCADE
      )
    `);
  }

  async create(record: RepoRecord): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO repos (repo_id, dolt_path, created_at, created_by)
            VALUES (?, ?, ?, ?)`,
      args: [record.repoId, record.doltPath, record.createdAt, record.createdBy],
    });
  }

  async get(repoId: string): Promise<RepoRecord | null> {
    const result = await this.client.execute({
      sql: `SELECT repo_id, dolt_path, created_at, created_by FROM repos WHERE repo_id = ?`,
      args: [repoId],
    });
    const row = result.rows[0];
    return row ? rowToRecord(row) : null;
  }

  async list(): Promise<RepoRecord[]> {
    const result = await this.client.execute(
      `SELECT repo_id, dolt_path, created_at, created_by FROM repos`,
    );
    return result.rows.map(rowToRecord);
  }

  async getSyncPreference(repoId: string): Promise<RepoSyncPreferenceSummary | null> {
    const result = await this.client.execute({
      sql: `SELECT mode, requested_tables_json, created_at, updated_at FROM repo_sync_preferences WHERE repo_id = ?`,
      args: [repoId],
    });
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      mode: row.mode as RepoSyncPreferenceSummary['mode'],
      requestedTables:
        typeof row.requested_tables_json === 'string'
          ? ((JSON.parse(row.requested_tables_json) as string[] | null) ?? null)
          : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  async upsertSyncPreference(params: {
    repoId: string;
    mode: RepoSyncPreferenceSummary['mode'];
    requestedTables: string[] | null;
    createdAt: number;
    updatedAt: number;
  }): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO repo_sync_preferences (repo_id, mode, requested_tables_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(repo_id) DO UPDATE SET
              mode = excluded.mode,
              requested_tables_json = excluded.requested_tables_json,
              updated_at = excluded.updated_at`,
      args: [
        params.repoId,
        params.mode,
        params.requestedTables ? JSON.stringify(params.requestedTables) : null,
        params.createdAt,
        params.updatedAt,
      ],
    });
  }
}

function rowToRecord(row: Record<string, unknown>): RepoRecord {
  return {
    repoId: row.repo_id as string,
    doltPath: row.dolt_path as string,
    createdAt: Number(row.created_at),
    createdBy: row.created_by as string,
  };
}
