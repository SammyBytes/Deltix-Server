import { randomBytes } from 'node:crypto';
import {
  TicketAlreadyConsumedError,
  TicketExpiredError,
  TicketNotFoundError,
  TicketOperationMismatchError,
} from './errors';
import type { TicketStore } from './ticket-store';
import type { PushTicketSyncOptions, Ticket, TransferOperation } from './types';

export class TicketService {
  constructor(
    private readonly store: TicketStore,
    private readonly ttlSeconds: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async issueTicket(
    username: string,
    operation: TransferOperation,
    repo: string,
    syncOptions?: PushTicketSyncOptions | null,
  ): Promise<Ticket> {
    const ticket: Ticket = {
      id: randomBytes(32).toString('base64url'),
      username,
      operation,
      repo,
      status: 'issued',
      issuedAt: this.now(),
      expiresAt: this.now() + this.ttlSeconds * 1000,
      syncOptions: operation === 'push' ? (syncOptions ?? null) : null,
    };
    await this.store.create(ticket);
    return ticket;
  }

  async consumeTicket(
    ticketId: string,
    operation: TransferOperation,
    repo: string,
  ): Promise<Ticket> {
    const now = this.now();
    const activated = await this.store.activate(ticketId, operation, repo, now);
    if (activated) {
      const ticket = await this.store.get(ticketId);
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
    throw new TicketAlreadyConsumedError();
  }

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
