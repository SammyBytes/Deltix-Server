/**
 * Real libSQL-backed implementation of `TransferJobStore`. Same discipline
 * as `LibsqlTicketStore`: parameterized queries only, every transition a
 * single atomic conditional `UPDATE ... WHERE status = '<expected>'`.
 *
 * `claimNextEligible` is the one method that looks like read-then-write,
 * but it is race-safe: the SELECT only picks a *candidate* id, and the
 * subsequent UPDATE re-checks `status IN ('staged','sync_failed')` (and
 * `next_retry_at <= now` for the failed case) as part of the same
 * conditional WHERE clause. If a concurrent worker already claimed that
 * row, `rowsAffected` will be 0 and this call simply tries the next
 * candidate (bounded loop) instead of ever assuming success from the SELECT.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import type { TransferJobStore } from './transfer-job-store';
import type { TransferJob, TransferJobStatus } from './types';

function rowToJob(row: Record<string, unknown>): TransferJob {
  return {
    id: row.id as string,
    repo: row.repo as string,
    stagingPath: row.staging_path as string,
    checksum: row.checksum as string,
    status: row.status as TransferJobStatus,
    retryCount: Number(row.retry_count),
    maxRetries: Number(row.max_retries),
    nextRetryAt: Number(row.next_retry_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastError: (row.last_error as string | null) ?? null,
  };
}

export class LibsqlTransferJobStore implements TransferJobStore {
  private readonly client: Client;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.client = createClient({ url: `file:${dbPath}` });
  }

  async init(): Promise<void> {
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS transfer_jobs (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        staging_path TEXT NOT NULL,
        checksum TEXT NOT NULL,
        status TEXT NOT NULL,
        retry_count INTEGER NOT NULL,
        max_retries INTEGER NOT NULL,
        next_retry_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_error TEXT
      )
    `);
  }

  async create(job: TransferJob): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO transfer_jobs
              (id, repo, staging_path, checksum, status, retry_count, max_retries,
               next_retry_at, created_at, updated_at, last_error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        job.id,
        job.repo,
        job.stagingPath,
        job.checksum,
        job.status,
        job.retryCount,
        job.maxRetries,
        job.nextRetryAt,
        job.createdAt,
        job.updatedAt,
        job.lastError,
      ],
    });
  }

  async get(jobId: string): Promise<TransferJob | null> {
    const result = await this.client.execute({
      sql: 'SELECT * FROM transfer_jobs WHERE id = ?',
      args: [jobId],
    });
    const row = result.rows[0];
    return row ? rowToJob(row as unknown as Record<string, unknown>) : null;
  }

  async claimNextEligible(now: number): Promise<TransferJob | null> {
    // Bounded retry loop: try a handful of candidates in case of a claim
    // race with another worker, rather than looping forever.
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidates = await this.client.execute({
        sql: `SELECT id FROM transfer_jobs
              WHERE (status = 'staged')
                 OR (status = 'sync_failed' AND next_retry_at <= ?)
              ORDER BY created_at ASC
              LIMIT 5`,
        args: [now],
      });
      if (candidates.rows.length === 0) {
        return null;
      }

      for (const row of candidates.rows) {
        const id = row.id as string;
        const result = await this.client.execute({
          sql: `UPDATE transfer_jobs
                SET status = 'syncing', updated_at = ?
                WHERE id = ?
                  AND (status = 'staged' OR (status = 'sync_failed' AND next_retry_at <= ?))`,
          args: [now, id, now],
        });
        if (result.rowsAffected === 1) {
          return this.get(id);
        }
      }
    }
    return null;
  }

  async markSynced(jobId: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: `UPDATE transfer_jobs SET status = 'synced', updated_at = ?
            WHERE id = ? AND status = 'syncing'`,
      args: [Date.now(), jobId],
    });
    return result.rowsAffected === 1;
  }

  async markFailed(jobId: string, error: string, nextRetryAt: number): Promise<boolean> {
    // Single atomic UPDATE decides sync_failed vs dead_letter via CASE,
    // computed from the row's OWN current retry_count/max_retries — no
    // separate read-then-decide step in application code.
    const result = await this.client.execute({
      sql: `UPDATE transfer_jobs
            SET status = CASE WHEN retry_count + 1 >= max_retries THEN 'dead_letter' ELSE 'sync_failed' END,
                retry_count = retry_count + 1,
                next_retry_at = ?,
                last_error = ?,
                updated_at = ?
            WHERE id = ? AND status = 'syncing'`,
      args: [nextRetryAt, error, Date.now(), jobId],
    });
    return result.rowsAffected === 1;
  }

  async requeueDeadLetter(jobId: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: `UPDATE transfer_jobs
            SET status = 'staged', retry_count = 0, last_error = NULL, updated_at = ?
            WHERE id = ? AND status = 'dead_letter'`,
      args: [Date.now(), jobId],
    });
    return result.rowsAffected === 1;
  }

  async listDeadLetter(): Promise<TransferJob[]> {
    const result = await this.client.execute({
      sql: `SELECT * FROM transfer_jobs WHERE status = 'dead_letter' ORDER BY updated_at DESC`,
      args: [],
    });
    return result.rows.map((row) => rowToJob(row as unknown as Record<string, unknown>));
  }
}
