import type { Ticket, TransferOperation } from './types';

/**
 * Persistence port for ephemeral transfer tickets. Every state transition
 * method here MUST be implemented as a single atomic conditional write
 * (e.g. `UPDATE ... WHERE status = 'issued'` in SQL) — never a
 * read-then-write pair — to eliminate TOCTOU races when multiple gRPC
 * connections race to consume/renew/close the same ticket concurrently.
 *
 * `activate()` in particular is the single-use enforcement boundary: only
 * the caller whose atomic UPDATE actually matched a row (returned true) may
 * proceed with the transfer. All other concurrent callers must receive
 * `false` and treat the ticket as already consumed.
 */
export interface TicketStore {
  /** Inserts a brand-new ticket in the `issued` state. */
  create(ticket: Ticket): Promise<void>;

  get(ticketId: string): Promise<Ticket | null>;

  /**
   * Atomically transitions `issued` -> `active` for the given operation/repo,
   * ONLY if the ticket is not expired. Returns `true` iff this call won the
   * transition (i.e. the caller may proceed); `false` if the ticket was
   * already active/closed/expired, or the operation/repo didn't match.
   */
  activate(
    ticketId: string,
    operation: TransferOperation,
    repo: string,
    now: number,
  ): Promise<boolean>;

  /**
   * Atomically renews the expiry (heartbeat), ONLY if the ticket is
   * currently `active` and not yet expired. Returns `true` iff renewed.
   */
  renew(ticketId: string, newExpiresAt: number, now: number): Promise<boolean>;

  /** Atomically transitions `active` -> `closed`. Returns `true` iff closed. */
  close(ticketId: string): Promise<boolean>;

  /**
   * Reaper hook: marks all tickets whose `expiresAt` has passed and whose
   * status is still `issued` or `active` as `expired`, so staging cleanup
   * can react to a stable, queryable status instead of re-deriving
   * expiry from `expiresAt` everywhere. Returns the number of tickets reaped.
   */
  reapExpired(now: number): Promise<number>;
}
