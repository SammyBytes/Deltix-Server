import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PullNotFoundError,
  PullSessionAbortedError,
  PullSessionHandler,
} from '../../../src/contexts/storage/pull-session-handler';
import { TicketService } from '../../../src/contexts/transfer/ticket.service';
import type { TicketStore } from '../../../src/contexts/transfer/ticket-store';
import type { Ticket, TransferOperation } from '../../../src/contexts/transfer/types';

class InMemoryTicketStore implements TicketStore {
  tickets = new Map<string, Ticket>();
  async create(ticket: Ticket) {
    this.tickets.set(ticket.id, { ...ticket });
  }
  async get(ticketId: string) {
    const t = this.tickets.get(ticketId);
    return t ? { ...t } : null;
  }
  async activate(ticketId: string, operation: TransferOperation, repo: string, now: number) {
    const t = this.tickets.get(ticketId);
    if (t?.status !== 'issued' || t.expiresAt <= now) return false;
    if (t.operation !== operation || t.repo !== repo) return false;
    t.status = 'active';
    return true;
  }
  async renew(ticketId: string, newExpiresAt: number, now: number) {
    const t = this.tickets.get(ticketId);
    if (t?.status !== 'active' || t.expiresAt <= now) return false;
    t.expiresAt = newExpiresAt;
    return true;
  }
  async close(ticketId: string) {
    const t = this.tickets.get(ticketId);
    if (t?.status !== 'active') return false;
    t.status = 'closed';
    return true;
  }
  async reapExpired(now: number) {
    let n = 0;
    for (const t of this.tickets.values()) {
      if ((t.status === 'issued' || t.status === 'active') && t.expiresAt <= now) {
        t.status = 'expired';
        n++;
      }
    }
    return n;
  }
}

async function drain(gen: AsyncGenerator<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of gen) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('PullSessionHandler', () => {
  let ticketStore: InMemoryTicketStore;
  let ticketService: TicketService;
  let nasRoot: string;

  beforeEach(async () => {
    ticketStore = new InMemoryTicketStore();
    ticketService = new TicketService(ticketStore, 120);
    nasRoot = await mkdtemp(join(tmpdir(), 'deltix-pull-nas-'));
  });

  it('streams back the synced file content in order', async () => {
    await mkdir(join(nasRoot, 'org/repo'), { recursive: true });
    await writeFile(join(nasRoot, 'org/repo', 'repo.dolt'), 'hello-nas-content');

    const ticket = await ticketService.issueTicket('alice', 'pull', 'org/repo');
    const handler = new PullSessionHandler(ticketService, nasRoot);

    const content = await drain(handler.stream(ticket.id, 'org/repo'));
    expect(content.toString('utf8')).toBe('hello-nas-content');
  });

  it('throws PullSessionAbortedError for an unknown ticket', async () => {
    const handler = new PullSessionHandler(ticketService, nasRoot);
    await expect(drain(handler.stream('nonexistent', 'org/repo'))).rejects.toThrow(
      PullSessionAbortedError,
    );
  });

  it('throws PullSessionAbortedError when the ticket does not scope this repo', async () => {
    const ticket = await ticketService.issueTicket('alice', 'pull', 'org/repo');
    const handler = new PullSessionHandler(ticketService, nasRoot);
    await expect(drain(handler.stream(ticket.id, 'org/OTHER'))).rejects.toThrow(
      PullSessionAbortedError,
    );
  });

  it('throws PullNotFoundError when there is no synced NAS copy for the repo', async () => {
    const ticket = await ticketService.issueTicket('alice', 'pull', 'org/never-synced');
    const handler = new PullSessionHandler(ticketService, nasRoot);
    await expect(drain(handler.stream(ticket.id, 'org/never-synced'))).rejects.toThrow(
      PullNotFoundError,
    );
  });

  it('closes the ticket after a successful stream so it cannot be reused', async () => {
    await mkdir(join(nasRoot, 'org/repo'), { recursive: true });
    await writeFile(join(nasRoot, 'org/repo', 'repo.dolt'), 'x');

    const ticket = await ticketService.issueTicket('alice', 'pull', 'org/repo');
    const handler = new PullSessionHandler(ticketService, nasRoot);
    await drain(handler.stream(ticket.id, 'org/repo'));

    expect((await ticketStore.get(ticket.id))?.status).toBe('closed');
  });

  it('closes the ticket even when the repo has no synced copy (not-found path)', async () => {
    const ticket = await ticketService.issueTicket('alice', 'pull', 'org/missing');
    const handler = new PullSessionHandler(ticketService, nasRoot);
    await expect(drain(handler.stream(ticket.id, 'org/missing'))).rejects.toThrow(
      PullNotFoundError,
    );

    expect((await ticketStore.get(ticket.id))?.status).toBe('closed');
  });
});
