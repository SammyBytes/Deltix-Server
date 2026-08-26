import { beforeEach, describe, expect, it } from 'bun:test';
import {
  TicketAlreadyConsumedError,
  TicketExpiredError,
  TicketNotFoundError,
  TicketOperationMismatchError,
} from '../../../src/contexts/transfer/errors';
import { TicketService } from '../../../src/contexts/transfer/ticket.service';
import type { TicketStore } from '../../../src/contexts/transfer/ticket-store';
import type { Ticket, TransferOperation } from '../../../src/contexts/transfer/types';

/**
 * In-memory double implementing the exact atomicity contract the real
 * libSQL store must honor (conditional transitions, not read-then-write).
 * Good enough for unit-level behavioral tests; the real concurrency
 * guarantees are re-verified against a real libSQL file in the
 * integration/concurrency test suite.
 */
class InMemoryTicketStore implements TicketStore {
  private tickets = new Map<string, Ticket>();

  async create(ticket: Ticket): Promise<void> {
    this.tickets.set(ticket.id, { ...ticket });
  }

  async get(ticketId: string): Promise<Ticket | null> {
    const t = this.tickets.get(ticketId);
    return t ? { ...t } : null;
  }

  async activate(
    ticketId: string,
    operation: TransferOperation,
    repo: string,
    now: number,
  ): Promise<boolean> {
    const t = this.tickets.get(ticketId);
    if (t?.status !== 'issued' || t.expiresAt <= now) {
      return false;
    }
    if (t.operation !== operation || t.repo !== repo) {
      return false;
    }
    t.status = 'active';
    return true;
  }

  async renew(ticketId: string, newExpiresAt: number, now: number): Promise<boolean> {
    const t = this.tickets.get(ticketId);
    if (t?.status !== 'active' || t.expiresAt <= now) {
      return false;
    }
    t.expiresAt = newExpiresAt;
    return true;
  }

  async close(ticketId: string): Promise<boolean> {
    const t = this.tickets.get(ticketId);
    if (t?.status !== 'active') {
      return false;
    }
    t.status = 'closed';
    return true;
  }

  async reapExpired(now: number): Promise<number> {
    let count = 0;
    for (const t of this.tickets.values()) {
      if ((t.status === 'issued' || t.status === 'active') && t.expiresAt <= now) {
        t.status = 'expired';
        count++;
      }
    }
    return count;
  }
}

describe('TicketService', () => {
  let store: InMemoryTicketStore;
  let clock: number;
  let service: TicketService;
  const TTL_SECONDS = 120;

  beforeEach(() => {
    store = new InMemoryTicketStore();
    clock = 1_000_000;
    service = new TicketService(store, TTL_SECONDS, () => clock);
  });

  describe('issueTicket', () => {
    it('creates a ticket bound to username/operation/repo with the configured TTL', async () => {
      const ticket = await service.issueTicket('alice', 'push', 'org/repo');

      expect(ticket.username).toBe('alice');
      expect(ticket.operation).toBe('push');
      expect(ticket.repo).toBe('org/repo');
      expect(ticket.status).toBe('issued');
      expect(ticket.expiresAt).toBe(clock + TTL_SECONDS * 1000);
    });

    it('generates a cryptographically random, non-guessable, unique id', async () => {
      const a = await service.issueTicket('alice', 'push', 'org/repo');
      const b = await service.issueTicket('alice', 'push', 'org/repo');

      expect(a.id).not.toBe(b.id);
      // 256 bits base64url-encoded -> 43 chars (no padding).
      expect(a.id.length).toBeGreaterThanOrEqual(40);
    });
  });

  describe('consumeTicket (activation)', () => {
    it('activates a matching, unexpired, unconsumed ticket', async () => {
      const ticket = await service.issueTicket('alice', 'push', 'org/repo');

      await expect(service.consumeTicket(ticket.id, 'push', 'org/repo')).resolves.toBeUndefined();

      const stored = await store.get(ticket.id);
      expect(stored?.status).toBe('active');
    });

    it('throws TicketNotFoundError for an unknown ticket id', async () => {
      await expect(service.consumeTicket('nonexistent', 'push', 'org/repo')).rejects.toThrow(
        TicketNotFoundError,
      );
    });

    it('throws TicketOperationMismatchError when the operation does not match', async () => {
      const ticket = await service.issueTicket('alice', 'push', 'org/repo');

      await expect(service.consumeTicket(ticket.id, 'pull', 'org/repo')).rejects.toThrow(
        TicketOperationMismatchError,
      );
    });

    it('throws TicketOperationMismatchError when the repo does not match', async () => {
      const ticket = await service.issueTicket('alice', 'push', 'org/repo');

      await expect(service.consumeTicket(ticket.id, 'push', 'other/repo')).rejects.toThrow(
        TicketOperationMismatchError,
      );
    });

    it('throws TicketAlreadyConsumedError on a second activation attempt (single-use)', async () => {
      const ticket = await service.issueTicket('alice', 'push', 'org/repo');
      await service.consumeTicket(ticket.id, 'push', 'org/repo');

      await expect(service.consumeTicket(ticket.id, 'push', 'org/repo')).rejects.toThrow(
        TicketAlreadyConsumedError,
      );
    });

    it('throws TicketExpiredError when the ticket TTL has elapsed before activation', async () => {
      const ticket = await service.issueTicket('alice', 'push', 'org/repo');
      clock += (TTL_SECONDS + 1) * 1000;

      await expect(service.consumeTicket(ticket.id, 'push', 'org/repo')).rejects.toThrow(
        TicketExpiredError,
      );
    });

    it('does not let a second concurrent activation attempt win (simulated race)', async () => {
      const ticket = await service.issueTicket('alice', 'push', 'org/repo');

      const results = await Promise.allSettled([
        service.consumeTicket(ticket.id, 'push', 'org/repo'),
        service.consumeTicket(ticket.id, 'push', 'org/repo'),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
    });
  });

  describe('renewTicket (heartbeat)', () => {
    it('extends the expiry of an active ticket (sliding window)', async () => {
      const ticket = await service.issueTicket('alice', 'push', 'org/repo');
      await service.consumeTicket(ticket.id, 'push', 'org/repo');

      clock += 30_000;
      const newExpiresAt = await service.renewTicket(ticket.id);

      const stored = await store.get(ticket.id);
      expect(stored?.expiresAt).toBe(clock + TTL_SECONDS * 1000);
      expect(newExpiresAt).toBe(clock + TTL_SECONDS * 1000);
    });

    it('throws TicketNotFoundError when renewing a ticket that never went active', async () => {
      const ticket = await service.issueTicket('alice', 'push', 'org/repo');

      await expect(service.renewTicket(ticket.id)).rejects.toThrow(TicketNotFoundError);
    });

    it('throws TicketExpiredError when the heartbeat arrives too late (no more renewals)', async () => {
      const ticket = await service.issueTicket('alice', 'push', 'org/repo');
      await service.consumeTicket(ticket.id, 'push', 'org/repo');

      clock += (TTL_SECONDS + 1) * 1000;
      await expect(service.renewTicket(ticket.id)).rejects.toThrow(TicketExpiredError);
    });
  });

  describe('closeTicket', () => {
    it('closes an active ticket', async () => {
      const ticket = await service.issueTicket('alice', 'push', 'org/repo');
      await service.consumeTicket(ticket.id, 'push', 'org/repo');

      await expect(service.closeTicket(ticket.id)).resolves.toBeUndefined();

      const stored = await store.get(ticket.id);
      expect(stored?.status).toBe('closed');
    });

    it('throws TicketNotFoundError when closing a ticket that is not active', async () => {
      const ticket = await service.issueTicket('alice', 'push', 'org/repo');

      await expect(service.closeTicket(ticket.id)).rejects.toThrow(TicketNotFoundError);
    });
  });
});
