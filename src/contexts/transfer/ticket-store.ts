import type { Ticket, TransferOperation } from './types';

export interface TicketStore {
  create(ticket: Ticket): Promise<void>;
  get(ticketId: string): Promise<Ticket | null>;
  activate(
    ticketId: string,
    operation: TransferOperation,
    repo: string,
    now: number,
  ): Promise<boolean>;
  renew(ticketId: string, newExpiresAt: number, now: number): Promise<boolean>;
  close(ticketId: string): Promise<boolean>;
  reapExpired(now: number): Promise<number>;
}
