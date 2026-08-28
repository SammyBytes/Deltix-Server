import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import type { TicketStore } from './ticket-store';
import type { Ticket, TransferOperation } from './types';

function rowToTicket(row: Record<string, unknown>): Ticket {
  return {
    id: row.id as string,
    username: row.username as string,
    operation: row.operation as TransferOperation,
    repo: row.repo as string,
    status: row.status as Ticket['status'],
    issuedAt: Number(row.issued_at),
    expiresAt: Number(row.expires_at),
    syncOptions:
      typeof row.sync_options_json === 'string'
        ? ((JSON.parse(row.sync_options_json) as Ticket['syncOptions']) ?? null)
        : null,
  };
}

export class LibsqlTicketStore implements TicketStore {
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
      CREATE TABLE IF NOT EXISTS transfer_tickets (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        operation TEXT NOT NULL,
        repo TEXT NOT NULL,
        status TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        sync_options_json TEXT
      )
    `);
    await this.client
      .execute(`ALTER TABLE transfer_tickets ADD COLUMN sync_options_json TEXT`.trim())
      .catch(() => {});
  }

  async create(ticket: Ticket): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO transfer_tickets
              (id, username, operation, repo, status, issued_at, expires_at, sync_options_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        ticket.id,
        ticket.username,
        ticket.operation,
        ticket.repo,
        ticket.status,
        ticket.issuedAt,
        ticket.expiresAt,
        ticket.syncOptions ? JSON.stringify(ticket.syncOptions) : null,
      ],
    });
  }

  async get(ticketId: string): Promise<Ticket | null> {
    const result = await this.client.execute({
      sql: 'SELECT * FROM transfer_tickets WHERE id = ?',
      args: [ticketId],
    });
    const row = result.rows[0];
    return row ? rowToTicket(row as unknown as Record<string, unknown>) : null;
  }

  async activate(
    ticketId: string,
    operation: TransferOperation,
    repo: string,
    now: number,
  ): Promise<boolean> {
    const result = await this.client.execute({
      sql: `UPDATE transfer_tickets SET status = 'active'
            WHERE id = ? AND operation = ? AND repo = ? AND status = 'issued' AND expires_at > ?`,
      args: [ticketId, operation, repo, now],
    });
    return result.rowsAffected === 1;
  }

  async renew(ticketId: string, newExpiresAt: number, now: number): Promise<boolean> {
    const result = await this.client.execute({
      sql: `UPDATE transfer_tickets SET expires_at = ?
            WHERE id = ? AND status = 'active' AND expires_at > ?`,
      args: [newExpiresAt, ticketId, now],
    });
    return result.rowsAffected === 1;
  }

  async close(ticketId: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: `UPDATE transfer_tickets SET status = 'closed' WHERE id = ? AND status = 'active'`,
      args: [ticketId],
    });
    return result.rowsAffected === 1;
  }

  async reapExpired(now: number): Promise<number> {
    const result = await this.client.execute({
      sql: `UPDATE transfer_tickets
            SET status = 'expired'
            WHERE status IN ('issued', 'active') AND expires_at <= ?`,
      args: [now],
    });
    return Number(result.rowsAffected);
  }
}
