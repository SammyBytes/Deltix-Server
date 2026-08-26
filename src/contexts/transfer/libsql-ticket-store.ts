/**
 * Real libSQL-backed implementation of `TicketStore`. Uses parameterized
 * queries exclusively (never string-concatenated SQL — OWASP A03) via
 * `@libsql/client`.
 *
 * Every transition method below is a SINGLE conditional `UPDATE ... WHERE
 * status = '<expected>' AND ...` statement. SQLite (and libSQL) execute
 * each statement atomically with respect to concurrent writers on the same
 * database file — there is no read-then-decide-then-write gap here, which
 * is exactly the property `ticket-store.ts`'s interface contract demands.
 * `rowsAffected === 1` is the ONLY source of truth for "did I win the
 * transition" — never a prior SELECT.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import type { TicketStore } from './ticket-store';
import type { Ticket, TicketStatus, TransferOperation } from './types';

export class LibsqlTicketStore implements TicketStore {
  private readonly client: Client;

  constructor(dbPath: string) {
    // libSQL does not create missing parent directories itself — it fails
    // the connection outright (ConnectionFailed) instead. Ensure the
    // directory exists up front so a fresh deployment/test environment
    // doesn't need to pre-create it manually.
    mkdirSync(dirname(dbPath), { recursive: true });
    this.client = createClient({ url: `file:${dbPath}` });
  }

  /** Creates the tickets table if it doesn't exist yet. Call once at boot. */
  async init(): Promise<void> {
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS transfer_tickets (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        operation TEXT NOT NULL,
        repo TEXT NOT NULL,
        status TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
  }

  async create(ticket: Ticket): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO transfer_tickets
              (id, username, operation, repo, status, issued_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        ticket.id,
        ticket.username,
        ticket.operation,
        ticket.repo,
        ticket.status,
        ticket.issuedAt,
        ticket.expiresAt,
      ],
    });
  }

  async get(ticketId: string): Promise<Ticket | null> {
    const result = await this.client.execute({
      sql: `SELECT id, username, operation, repo, status, issued_at, expires_at
            FROM transfer_tickets WHERE id = ?`,
      args: [ticketId],
    });
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id as string,
      username: row.username as string,
      operation: row.operation as TransferOperation,
      repo: row.repo as string,
      status: row.status as TicketStatus,
      issuedAt: Number(row.issued_at),
      expiresAt: Number(row.expires_at),
    };
  }

  async activate(
    ticketId: string,
    operation: TransferOperation,
    repo: string,
    now: number,
  ): Promise<boolean> {
    const result = await this.client.execute({
      sql: `UPDATE transfer_tickets
            SET status = 'active'
            WHERE id = ? AND status = 'issued' AND operation = ? AND repo = ? AND expires_at > ?`,
      args: [ticketId, operation, repo, now],
    });
    return result.rowsAffected === 1;
  }

  async renew(ticketId: string, newExpiresAt: number, now: number): Promise<boolean> {
    const result = await this.client.execute({
      sql: `UPDATE transfer_tickets
            SET expires_at = ?
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
    return result.rowsAffected;
  }
}
