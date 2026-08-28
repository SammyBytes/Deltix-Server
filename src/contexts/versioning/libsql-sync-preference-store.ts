import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import type { SyncPreferenceStore } from './sync-preference-store';
import type { RepoSyncPreferenceRecord } from './sync-preference-types';

function rowToRecord(row: Record<string, unknown>): RepoSyncPreferenceRecord {
  return {
    repoId: row.repo_id as string,
    mode: row.mode as RepoSyncPreferenceRecord['mode'],
    requestedTables:
      typeof row.requested_tables_json === 'string'
        ? ((JSON.parse(row.requested_tables_json) as string[] | null) ?? null)
        : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class LibsqlSyncPreferenceStore implements SyncPreferenceStore {
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

  async get(repoId: string): Promise<RepoSyncPreferenceRecord | null> {
    const result = await this.client.execute({
      sql: `SELECT repo_id, mode, requested_tables_json, created_at, updated_at
            FROM repo_sync_preferences WHERE repo_id = ?`,
      args: [repoId],
    });
    const row = result.rows[0];
    return row ? rowToRecord(row as unknown as Record<string, unknown>) : null;
  }

  async upsert(record: RepoSyncPreferenceRecord): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO repo_sync_preferences (repo_id, mode, requested_tables_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(repo_id) DO UPDATE SET
              mode = excluded.mode,
              requested_tables_json = excluded.requested_tables_json,
              updated_at = excluded.updated_at`,
      args: [
        record.repoId,
        record.mode,
        record.requestedTables ? JSON.stringify(record.requestedTables) : null,
        record.createdAt,
        record.updatedAt,
      ],
    });
  }
}
