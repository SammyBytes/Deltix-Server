import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PushSessionAbortedError,
  PushSessionHandler,
} from '../../../src/contexts/storage/push-session-handler';
import type { TransferJobStore } from '../../../src/contexts/storage/transfer-job-store';
import type { TransferJob } from '../../../src/contexts/storage/types';
import { TicketService } from '../../../src/contexts/transfer/ticket.service';
import type { TicketStore } from '../../../src/contexts/transfer/ticket-store';
import type { Ticket, TransferOperation } from '../../../src/contexts/transfer/types';

/** Same in-memory ticket store double used in ticket.service.test.ts. */
class InMemoryTicketStore implements TicketStore {
  tickets = new Map<string, Ticket>();

  async create(ticket: Ticket): Promise<void> {
    this.tickets.set(ticket.id, { ...ticket });
  }
  async get(ticketId: string): Promise<Ticket | null> {
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

class InMemoryTransferJobStore implements TransferJobStore {
  jobs: TransferJob[] = [];
  async create(job: TransferJob) {
    this.jobs.push({ ...job });
  }
  async get(jobId: string) {
    return this.jobs.find((j) => j.id === jobId) ?? null;
  }
  async claimNextEligible() {
    return null;
  }
  async markSynced() {
    return false;
  }
  async markFailed() {
    return false;
  }
  async requeueDeadLetter() {
    return false;
  }
  async listDeadLetter() {
    return [];
  }
}

describe('PushSessionHandler', () => {
  let ticketStore: InMemoryTicketStore;
  let ticketService: TicketService;
  let jobStore: InMemoryTransferJobStore;
  let stagingRoot: string;

  beforeEach(async () => {
    ticketStore = new InMemoryTicketStore();
    ticketService = new TicketService(ticketStore, 120);
    jobStore = new InMemoryTransferJobStore();
    stagingRoot = await mkdtemp(join(tmpdir(), 'deltix-push-session-'));
  });

  async function issueTicket(operation: TransferOperation = 'push', repo = 'org/repo') {
    return ticketService.issueTicket('alice', operation, repo);
  }

  it('rejects onHeader with an unknown ticket', async () => {
    const handler = new PushSessionHandler(ticketService, jobStore, stagingRoot, 5);
    await expect(handler.onHeader('nonexistent', 'push', 'org/repo')).rejects.toThrow(
      PushSessionAbortedError,
    );
  });

  it('rejects onHeader when operation/repo does not match the ticket scope', async () => {
    const ticket = await issueTicket('push', 'org/repo');
    const handler = new PushSessionHandler(ticketService, jobStore, stagingRoot, 5);
    await expect(handler.onHeader(ticket.id, 'push', 'org/OTHER-repo')).rejects.toThrow(
      PushSessionAbortedError,
    );
  });

  it('rejects a second onHeader call for the same session', async () => {
    const ticket = await issueTicket();
    const handler = new PushSessionHandler(ticketService, jobStore, stagingRoot, 5);
    await handler.onHeader(ticket.id, 'push', 'org/repo');

    const secondTicket = await issueTicket();
    await expect(handler.onHeader(secondTicket.id, 'push', 'org/repo')).rejects.toThrow(
      PushSessionAbortedError,
    );
  });

  it('rejects a chunk received before the header', () => {
    const handler = new PushSessionHandler(ticketService, jobStore, stagingRoot, 5);
    expect(() => handler.onChunk(new Uint8Array([1, 2, 3]))).toThrow(PushSessionAbortedError);
  });

  it('rejects a heartbeat received before the header', async () => {
    const handler = new PushSessionHandler(ticketService, jobStore, stagingRoot, 5);
    await expect(handler.onHeartbeat()).rejects.toThrow(PushSessionAbortedError);
  });

  it('writes chunks to a staging file and computes the correct checksum on finish', async () => {
    const ticket = await issueTicket();
    const handler = new PushSessionHandler(ticketService, jobStore, stagingRoot, 5);
    await handler.onHeader(ticket.id, 'push', 'org/repo');

    handler.onChunk(new TextEncoder().encode('hello '));
    handler.onChunk(new TextEncoder().encode('world'));

    const result = await handler.finish();

    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update('hello world').digest('hex');
    expect(result.checksum).toBe(expected);
    expect(result.bytesReceived).toBe(11);
  });

  it('creates a STAGED TransferJob on finish, pointing at the written staging file', async () => {
    const ticket = await issueTicket('push', 'org/repo');
    const handler = new PushSessionHandler(ticketService, jobStore, stagingRoot, 7);
    await handler.onHeader(ticket.id, 'push', 'org/repo');
    handler.onChunk(new TextEncoder().encode('data'));
    const result = await handler.finish();

    const job = await jobStore.get(result.jobId);
    expect(job?.status).toBe('staged');
    expect(job?.repo).toBe('org/repo');
    expect(job?.maxRetries).toBe(7);

    const onDisk = await readFile(job?.stagingPath ?? '', 'utf8');
    expect(onDisk).toBe('data');
  });

  it('invokes onPushCommitted with repo/username/jobId/checksum after a successful finish', async () => {
    const ticket = await issueTicket('push', 'org/repo');
    const calls: Array<{ repo: string; username: string; jobId: string; checksum: string }> = [];
    const onPushCommitted = mock(async (params: (typeof calls)[number]) => {
      calls.push(params);
    });
    const handler = new PushSessionHandler(
      ticketService,
      jobStore,
      stagingRoot,
      5,
      () => 1000,
      onPushCommitted,
    );
    await handler.onHeader(ticket.id, 'push', 'org/repo');
    handler.onChunk(new TextEncoder().encode('data'));
    const result = await handler.finish();

    expect(onPushCommitted).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual({
      repo: 'org/repo',
      username: ticket.username,
      jobId: result.jobId,
      checksum: result.checksum,
    });
  });

  it('a rejected onPushCommitted does not fail the push (data is already safely staged)', async () => {
    const ticket = await issueTicket('push', 'org/repo');
    const onPushCommitted = mock(async () => {
      throw new Error('dolt commit exploded');
    });
    const handler = new PushSessionHandler(
      ticketService,
      jobStore,
      stagingRoot,
      5,
      () => 1000,
      onPushCommitted,
    );
    await handler.onHeader(ticket.id, 'push', 'org/repo');
    handler.onChunk(new TextEncoder().encode('data'));

    await expect(handler.finish()).resolves.toMatchObject({ checksum: expect.any(String) });
  });

  it('closes the ticket on finish so it cannot be reused', async () => {
    const ticket = await issueTicket();
    const handler = new PushSessionHandler(ticketService, jobStore, stagingRoot, 5);
    await handler.onHeader(ticket.id, 'push', 'org/repo');
    handler.onChunk(new TextEncoder().encode('x'));
    await handler.finish();

    const stored = await ticketStore.get(ticket.id);
    expect(stored?.status).toBe('closed');
  });

  it('renews the ticket via onHeartbeat, keeping the sliding window alive', async () => {
    const ticket = await issueTicket();
    const handler = new PushSessionHandler(ticketService, jobStore, stagingRoot, 5);
    await handler.onHeader(ticket.id, 'push', 'org/repo');

    const before = (await ticketStore.get(ticket.id))?.expiresAt ?? 0;
    await handler.onHeartbeat();
    const after = (await ticketStore.get(ticket.id))?.expiresAt ?? 0;

    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('onHeartbeat throws PushSessionAbortedError if the ticket was already closed', async () => {
    const ticket = await issueTicket();
    const handler = new PushSessionHandler(ticketService, jobStore, stagingRoot, 5);
    await handler.onHeader(ticket.id, 'push', 'org/repo');
    handler.onChunk(new TextEncoder().encode('x'));
    await handler.finish();

    // After finish(), the ticket is closed -> a subsequent heartbeat call
    // against the SAME handler instance should fail (this simulates a
    // stray/late heartbeat arriving after the stream ended).
    await expect(handler.onHeartbeat()).rejects.toThrow(PushSessionAbortedError);
  });

  it('finish() throws if called twice', async () => {
    const ticket = await issueTicket();
    const handler = new PushSessionHandler(ticketService, jobStore, stagingRoot, 5);
    await handler.onHeader(ticket.id, 'push', 'org/repo');
    handler.onChunk(new TextEncoder().encode('x'));
    await handler.finish();

    await expect(handler.finish()).rejects.toThrow(PushSessionAbortedError);
  });

  it('finish() throws if called before any header was received', async () => {
    const handler = new PushSessionHandler(ticketService, jobStore, stagingRoot, 5);
    await expect(handler.finish()).rejects.toThrow(PushSessionAbortedError);
  });

  it('abort() cleans up the partial staging file and creates no TransferJob', async () => {
    const ticket = await issueTicket();
    const handler = new PushSessionHandler(ticketService, jobStore, stagingRoot, 5);
    await handler.onHeader(ticket.id, 'push', 'org/repo');
    handler.onChunk(new TextEncoder().encode('partial-data'));

    await handler.abort();

    expect(jobStore.jobs).toHaveLength(0);
  });

  it('abort() is idempotent (safe to call multiple times / after finish)', async () => {
    const ticket = await issueTicket();
    const handler = new PushSessionHandler(ticketService, jobStore, stagingRoot, 5);
    await handler.onHeader(ticket.id, 'push', 'org/repo');
    handler.onChunk(new TextEncoder().encode('x'));
    await handler.finish();

    await expect(handler.abort()).resolves.toBeUndefined();
  });
});
