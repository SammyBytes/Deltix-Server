/**
 * Public types for the "transfer" bounded context (Fase 3: Ephemeral
 * Tickets & gRPC Engine). A ticket is a short-lived, single-use credential
 * that authorizes exactly one (operation, repo) pair for a gRPC data
 * transfer — distinct from the longer-lived JWT session (Fase 2) used to
 * request it. See README.md for the full rationale.
 */

export type TransferOperation = 'push' | 'pull';
export type SyncMode = 'schema_only' | 'schema_and_data';

export type TicketStatus = 'issued' | 'active' | 'closed' | 'expired';

export interface PushTicketSyncOptions {
  mode?: SyncMode;
  tables?: string[] | null;
  dryRun?: boolean;
}

export interface Ticket {
  id: string;
  username: string;
  operation: TransferOperation;
  repo: string;
  status: TicketStatus;
  issuedAt: number;
  expiresAt: number;
  syncOptions?: PushTicketSyncOptions | null;
}
