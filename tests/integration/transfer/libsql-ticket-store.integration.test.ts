import { afterEach, describe, expect, it } from 'bun:test';
import { rm } from 'node:fs/promises';
import { LibsqlTicketStore } from '../../../src/contexts/transfer/libsql-ticket-store';
import type { Ticket } from '../../../src/contexts/transfer/types';

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: `ticket-${Math.random().toString(36).slice(2)}`,
    username: 'alice',
    operation: 'push',
    repo: 'org/repo',
    status: 'issued',
    issuedAt: 1_000,
    expiresAt: 1_000_000,
    ...overrides,
  };
}

describe('transfer/libsql-ticket-store (integration, real libSQL file)', () => {
  const dbPath = `/tmp/deltix-transfer-tickets-test-${Date.now()}.db`;

  afterEach(async () => {
    await rm(dbPath, { force: true });
    await rm(`${dbPath}-wal`, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
  });

  it('creates and reads back a ticket row', async () => {
    const store = new LibsqlTicketStore(dbPath);
    await store.init();

    const ticket = makeTicket();
    await store.create(ticket);

    const stored = await store.get(ticket.id);
    expect(stored).toEqual({ ...ticket, syncOptions: null });
  });

  it('returns null for an unknown ticket id', async () => {
    const store = new LibsqlTicketStore(dbPath);
    await store.init();

    expect(await store.get('nonexistent')).toBeNull();
  });

  describe('activate()', () => {
    it('transitions issued -> active and returns true on a matching, unexpired ticket', async () => {
      const store = new LibsqlTicketStore(dbPath);
      await store.init();
      const ticket = makeTicket({ expiresAt: 2_000 });
      await store.create(ticket);

      const won = await store.activate(ticket.id, 'push', 'org/repo', 1_500);

      expect(won).toBe(true);
      expect((await store.get(ticket.id))?.status).toBe('active');
    });

    it('returns false and does not mutate status for a mismatched operation', async () => {
      const store = new LibsqlTicketStore(dbPath);
      await store.init();
      const ticket = makeTicket({ expiresAt: 2_000 });
      await store.create(ticket);

      const won = await store.activate(ticket.id, 'pull', 'org/repo', 1_500);

      expect(won).toBe(false);
      expect((await store.get(ticket.id))?.status).toBe('issued');
    });

    it('returns false for an already-active ticket (single-use)', async () => {
      const store = new LibsqlTicketStore(dbPath);
      await store.init();
      const ticket = makeTicket({ expiresAt: 2_000 });
      await store.create(ticket);
      await store.activate(ticket.id, 'push', 'org/repo', 1_500);

      const wonAgain = await store.activate(ticket.id, 'push', 'org/repo', 1_600);

      expect(wonAgain).toBe(false);
    });

    it('returns false for an expired ticket', async () => {
      const store = new LibsqlTicketStore(dbPath);
      await store.init();
      const ticket = makeTicket({ expiresAt: 1_000 });
      await store.create(ticket);

      const won = await store.activate(ticket.id, 'push', 'org/repo', 2_000);

      expect(won).toBe(false);
    });
  });

  describe('renew()', () => {
    it('extends expiresAt for an active, unexpired ticket', async () => {
      const store = new LibsqlTicketStore(dbPath);
      await store.init();
      const ticket = makeTicket({ status: 'active', expiresAt: 2_000 });
      await store.create(ticket);

      const renewed = await store.renew(ticket.id, 5_000, 1_800);

      expect(renewed).toBe(true);
      expect((await store.get(ticket.id))?.expiresAt).toBe(5_000);
    });

    it('returns false for a ticket that is not active', async () => {
      const store = new LibsqlTicketStore(dbPath);
      await store.init();
      const ticket = makeTicket({ status: 'issued', expiresAt: 2_000 });
      await store.create(ticket);

      expect(await store.renew(ticket.id, 5_000, 1_800)).toBe(false);
    });

    it('returns false for an already-expired active ticket', async () => {
      const store = new LibsqlTicketStore(dbPath);
      await store.init();
      const ticket = makeTicket({ status: 'active', expiresAt: 1_000 });
      await store.create(ticket);

      expect(await store.renew(ticket.id, 5_000, 2_000)).toBe(false);
    });
  });

  describe('close()', () => {
    it('transitions active -> closed', async () => {
      const store = new LibsqlTicketStore(dbPath);
      await store.init();
      const ticket = makeTicket({ status: 'active' });
      await store.create(ticket);

      expect(await store.close(ticket.id)).toBe(true);
      expect((await store.get(ticket.id))?.status).toBe('closed');
    });

    it('returns false for a ticket that is not active', async () => {
      const store = new LibsqlTicketStore(dbPath);
      await store.init();
      const ticket = makeTicket({ status: 'issued' });
      await store.create(ticket);

      expect(await store.close(ticket.id)).toBe(false);
    });
  });

  describe('reapExpired()', () => {
    it('marks expired issued/active tickets as expired and returns the count', async () => {
      const store = new LibsqlTicketStore(dbPath);
      await store.init();
      await store.create(makeTicket({ id: 't1', status: 'issued', expiresAt: 1_000 }));
      await store.create(makeTicket({ id: 't2', status: 'active', expiresAt: 1_000 }));
      await store.create(makeTicket({ id: 't3', status: 'closed', expiresAt: 1_000 }));
      await store.create(makeTicket({ id: 't4', status: 'issued', expiresAt: 5_000 }));

      const reaped = await store.reapExpired(2_000);

      expect(reaped).toBe(2);
      expect((await store.get('t1'))?.status).toBe('expired');
      expect((await store.get('t2'))?.status).toBe('expired');
      expect((await store.get('t3'))?.status).toBe('closed');
      expect((await store.get('t4'))?.status).toBe('issued');
    });
  });

  describe('concurrency: real parallel racing writers against the same libSQL file', () => {
    it('only one of many concurrent activate() calls on the same ticket wins', async () => {
      const store = new LibsqlTicketStore(dbPath);
      await store.init();
      const ticket = makeTicket({ expiresAt: 1_000_000 });
      await store.create(ticket);

      const results = await Promise.all(
        Array.from({ length: 20 }, () => store.activate(ticket.id, 'push', 'org/repo', 500)),
      );

      const winners = results.filter(Boolean);
      expect(winners.length).toBe(1);
      expect((await store.get(ticket.id))?.status).toBe('active');
    });

    it('handles concurrent activate() calls across distinct tickets without cross-contamination', async () => {
      const store = new LibsqlTicketStore(dbPath);
      await store.init();
      const tickets = Array.from({ length: 10 }, (_, i) =>
        makeTicket({ id: `concurrent-${i}`, expiresAt: 1_000_000 }),
      );
      await Promise.all(tickets.map((t) => store.create(t)));

      const results = await Promise.all(
        tickets.map((t) => store.activate(t.id, 'push', 'org/repo', 500)),
      );

      expect(results.every(Boolean)).toBe(true);
      for (const t of tickets) {
        expect((await store.get(t.id))?.status).toBe('active');
      }
    });

    it('only one of many concurrent renew() heartbeats on the same ticket succeeds per call, all valid ones apply', async () => {
      const store = new LibsqlTicketStore(dbPath);
      await store.init();
      const ticket = makeTicket({ status: 'active', expiresAt: 1_000_000 });
      await store.create(ticket);

      const results = await Promise.all(
        Array.from({ length: 15 }, (_, i) => store.renew(ticket.id, 2_000_000 + i, 500)),
      );

      // Every call independently satisfies the WHERE clause (still active,
      // not yet expired) since none of them changes status — so ALL should
      // succeed; this proves no writer starves/deadlocks under real
      // concurrent load against the same row.
      expect(results.every(Boolean)).toBe(true);
    });
  });
});
