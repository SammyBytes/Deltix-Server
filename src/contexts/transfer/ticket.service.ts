/**
 * Ticket lifecycle: issue -> activate (single-use) -> renew (heartbeat,
 * sliding window) -> close. Mirrors the exact sliding-window discipline
 * used for REST auth sessions in Fase 2 (`SlidingWindowSessionManager`),
 * applied here to gRPC transfer tickets per the Fase 3 guardrail
 * ("EXPIRACIÓN POR INACTIVIDAD — no usar TTL absoluto").
 *
 * All state transitions are delegated to `TicketStore`, which MUST
 * implement them as atomic conditional writes — this service never reads
 * a ticket, decides in application code, then writes; that pattern would
 * reintroduce the exact TOCTOU race this design exists to prevent.
 *
 * `now` is injectable for deterministic tests (same pattern as
 * `SlidingWindowSessionManager` and `LicenseValidatorService`).
 */
import { randomBytes } from 'node:crypto';
import {
  TicketAlreadyConsumedError,
  TicketExpiredError,
  TicketNotFoundError,
  TicketOperationMismatchError,
} from './errors';
import type { TicketStore } from './ticket-store';
import type { Ticket, TransferOperation } from './types';

export class TicketService {
  constructor(
    private readonly store: TicketStore,
    private readonly ttlSeconds: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async issueTicket(username: string, operation: TransferOperation, repo: string): Promise<Ticket> {
    const ticket: Ticket = {
      id: randomBytes(32).toString('base64url'),
      username,
      operation,
      repo,
      status: 'issued',
      issuedAt: this.now(),
      expiresAt: this.now() + this.ttlSeconds * 1000,
    };
    await this.store.create(ticket);
    return ticket;
  }

  /**
   * Activates a ticket for the given (operation, repo) pair. Throws unless
   * exactly this call wins the atomic `issued` -> `active` transition.
   *
   * Distinguishes "not found" from "operation/repo mismatch" from "already
   * consumed"/"expired" by re-reading the ticket ONLY to build an accurate
   * error message after the atomic activate() attempt already failed —
   * this read never influences the transition decision itself, so it adds
   * no race window.
   *
   * Returns the consumed `Ticket` (carrying `username`) so callers (Fase
   * 5.2: `PushSessionHandler`) can attribute a resulting Dolt commit to
   * the authenticated user who requested the transfer, without a second
   * round-trip to the store.
   */
  async consumeTicket(
    ticketId: string,
    operation: TransferOperation,
    repo: string,
  ): Promise<Ticket> {
    const now = this.now();
    const activated = await this.store.activate(ticketId, operation, repo, now);
    if (activated) {
      const ticket = await this.store.get(ticketId);
      // Practically unreachable (we just activated it), but keeps the
      // return type honest without a non-null assertion.
      if (!ticket) {
        throw new TicketNotFoundError();
      }
      return ticket;
    }

    const ticket = await this.store.get(ticketId);
    if (!ticket) {
      throw new TicketNotFoundError();
    }
    if (ticket.expiresAt <= now) {
      throw new TicketExpiredError();
    }
    if (ticket.operation !== operation || ticket.repo !== repo) {
      throw new TicketOperationMismatchError();
    }
    // Correct operation/repo, not expired, but activation still failed ->
    // another caller already won the transition (or it was already
    // active/closed) — this is the single-use / race-loser path.
    throw new TicketAlreadyConsumedError();
  }

  /** Heartbeat: renews the sliding-window expiry of an active ticket. Returns the new expiry (epoch ms). */
  async renewTicket(ticketId: string): Promise<number> {
    const now = this.now();
    const newExpiresAt = now + this.ttlSeconds * 1000;
    const renewed = await this.store.renew(ticketId, newExpiresAt, now);
    if (renewed) {
      return newExpiresAt;
    }

    const ticket = await this.store.get(ticketId);
    if (ticket?.status !== 'active') {
      throw new TicketNotFoundError();
    }
    throw new TicketExpiredError();
  }

  async closeTicket(ticketId: string): Promise<void> {
    const closed = await this.store.close(ticketId);
    if (!closed) {
      throw new TicketNotFoundError();
    }
  }
}
