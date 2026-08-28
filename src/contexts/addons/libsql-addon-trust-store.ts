/**
 * Real libSQL-backed implementation of `AddonTrustStore`. Uses
 * parameterized queries exclusively (never string-concatenated SQL — OWASP
 * A03), mirroring `contexts/transfer/libsql-ticket-store.ts`'s pattern.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import type { AddonTrustStore } from './addon-trust-store';
import type { AddonTrustRecord } from './types';

export class LibsqlAddonTrustStore implements AddonTrustStore {
  private readonly client: Client;

  constructor(dbPath: string) {
    // libSQL does not create missing parent directories itself — ensure it
    // exists up front so a fresh deployment/test environment doesn't need
    // to pre-create it manually.
    mkdirSync(dirname(dbPath), { recursive: true });
    this.client = createClient({ url: `file:${dbPath}` });
  }

  /** Creates the trust store table if it doesn't exist yet. Call once at boot. */
  async init(): Promise<void> {
    // WAL + busy_timeout keep a second connection readable during a write
    // (see libsql-transfer-job-store.ts).
    await this.client.execute('PRAGMA journal_mode = WAL');
    await this.client.execute('PRAGMA busy_timeout = 5000');
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS addon_trust_store (
        addon_name TEXT PRIMARY KEY,
        author_public_key TEXT NOT NULL,
        trusted_at INTEGER NOT NULL,
        trusted_by TEXT NOT NULL
      )
    `);
  }

  async trust(record: AddonTrustRecord): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO addon_trust_store (addon_name, author_public_key, trusted_at, trusted_by)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(addon_name) DO UPDATE SET
              author_public_key = excluded.author_public_key,
              trusted_at = excluded.trusted_at,
              trusted_by = excluded.trusted_by`,
      args: [record.addonName, record.authorPublicKey, record.trustedAt, record.trustedBy],
    });
  }

  async getTrustedKey(addonName: string): Promise<AddonTrustRecord | null> {
    const result = await this.client.execute({
      sql: `SELECT addon_name, author_public_key, trusted_at, trusted_by
            FROM addon_trust_store WHERE addon_name = ?`,
      args: [addonName],
    });
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return rowToRecord(row);
  }

  async revokeTrust(addonName: string): Promise<void> {
    await this.client.execute({
      sql: `DELETE FROM addon_trust_store WHERE addon_name = ?`,
      args: [addonName],
    });
  }

  async listTrusted(): Promise<AddonTrustRecord[]> {
    const result = await this.client.execute(
      `SELECT addon_name, author_public_key, trusted_at, trusted_by FROM addon_trust_store`,
    );
    return result.rows.map(rowToRecord);
  }
}

function rowToRecord(row: Record<string, unknown>): AddonTrustRecord {
  return {
    addonName: row.addon_name as string,
    authorPublicKey: row.author_public_key as string,
    trustedAt: Number(row.trusted_at),
    trustedBy: row.trusted_by as string,
  };
}
