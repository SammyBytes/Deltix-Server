/**
 * Public types for the "transfer" bounded context (Fase 3: Ephemeral
 * Tickets & gRPC Engine). A ticket is a short-lived, single-use credential
 * that authorizes exactly one (operation, repo) pair for a gRPC data
 * transfer — distinct from the longer-lived JWT session (Fase 2) used to
 * request it. See README.md for the full rationale.
 */

export type TransferOperation = 'push' | 'pull';

export type TicketStatus = 'issued' | 'active' | 'closed' | 'expired';

export interface Ticket {
  id: string;
  username: string;
  operation: TransferOperation;
  repo: string;
  status: TicketStatus;
  issuedAt: number;
  expiresAt: number;
}
