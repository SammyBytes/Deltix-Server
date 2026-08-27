import { randomBytes } from 'node:crypto';
import type { RepoRole } from '../auth';
import {
  TicketAlreadyConsumedError,
  TicketExpiredError,
  TicketNotFoundError,
  TicketOperationMismatchError,
  TicketRoleRevokedError,
} from './errors';
import type { TicketStore } from './ticket-store';
import type { PushTicketSyncOptions, Ticket, TransferOperation } from './types';

const ROLE_RANK: Record<RepoRole, number> = { reader: 1, writer: 2, admin: 3 };
// Same policy as the HTTP ticket-issuance gate in transfer.router.ts — kept
// in sync deliberately, since this is the re-check applied at consumption
// (and renewal) time for the exact same (operation, repo) pair.
const MINIMUM_ROLE_FOR_OPERATION: Record<TransferOperation, RepoRole> = {
  push: 'writer',
  pull: 'reader',
};

/**
 * Re-verifies a caller's CURRENT repo role — must reflect a live read
 * against the authoritative role store (never a cached/stale value), so a
 * revoke made after a ticket was issued is honored immediately at the next
 * consumption or heartbeat, not only at the next issuance.
 */
export type RepoRoleVerifier = (username: string, repoId: string) => Promise<RepoRole | null>;

export class TicketService {
  constructor(
    private readonly store: TicketStore,
    private readonly ttlSeconds: number,
    private readonly now: () => number = () => Date.now(),
    private readonly verifyRepoRole?: RepoRoleVerifier,
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

  private async assertRoleStillSufficient(
    username: string,
    operation: TransferOperation,
    repo: string,
  ): Promise<void> {
    if (!this.verifyRepoRole) {
      return;
    }
    const minimumRole = MINIMUM_ROLE_FOR_OPERATION[operation];
    const role = await this.verifyRepoRole(username, repo);
    if (!role || ROLE_RANK[role] < ROLE_RANK[minimumRole]) {
      throw new TicketRoleRevokedError();
    }
  }

  async consumeTicket(
    ticketId: string,
    operation: TransferOperation,
    repo: string,
  ): Promise<Ticket> {
    const now = this.now();

    // Re-check the caller's CURRENT role BEFORE activating the ticket in
    // the store. The ticket only proved authorization at ISSUANCE time;
    // this is what closes the "revoke doesn't take effect until the
    // ticket expires" gap. Checked pre-activation so a failed re-check
    // never leaves the ticket transitioned to `active` in the store.
    const preCheck = await this.store.get(ticketId);
    if (preCheck && preCheck.operation === operation && preCheck.repo === repo) {
      await this.assertRoleStillSufficient(preCheck.username, operation, repo);
    }

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

    // Re-validate the role on every heartbeat too: a long-running transfer
    // must be cut off mid-stream if the role backing it is revoked while
    // it's in flight, not only refused on the NEXT ticket issuance.
    const existing = await this.store.get(ticketId);
    if (existing) {
      await this.assertRoleStillSufficient(existing.username, existing.operation, existing.repo);
    }

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
