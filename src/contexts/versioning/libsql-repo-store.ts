/**
 * Real libSQL-backed implementation of `RepoStore`. Uses parameterized
 * queries exclusively (never string-concatenated SQL — OWASP A03),
 * mirroring `contexts/addons/libsql-addon-trust-store.ts`'s pattern.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import type { RepoStore } from './repo-store';
import type { RepoRecord } from './types';

export class LibsqlRepoStore implements RepoStore {
  private readonly client: Client;

  constructor(dbPath: string) {
    // libSQL does not create missing parent directories itself — ensure it
    // exists up front so a fresh deployment/test environment doesn't need
    // to pre-create it manually.
    mkdirSync(dirname(dbPath), { recursive: true });
    this.client = createClient({ url: `file:${dbPath}` });
  }

  async init(): Promise<void> {
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS repos (
        repo_id TEXT PRIMARY KEY,
        dolt_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL
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
}

function rowToRecord(row: Record<string, unknown>): RepoRecord {
  return {
    repoId: row.repo_id as string,
    doltPath: row.dolt_path as string,
    createdAt: Number(row.created_at),
    createdBy: row.created_by as string,
  };
}
