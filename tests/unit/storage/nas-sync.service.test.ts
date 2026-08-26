import { beforeEach, describe, expect, it } from 'bun:test';
import type { NasAdapter } from '../../../src/contexts/storage/nas-adapter';
import { NasSyncService } from '../../../src/contexts/storage/nas-sync.service';
import type { TransferJobStore } from '../../../src/contexts/storage/transfer-job-store';
import type { TransferJob } from '../../../src/contexts/storage/types';

/**
 * In-memory double implementing the same atomicity contract the real
 * libSQL store must honor. Good enough for unit-level behavioral tests;
 * real concurrency guarantees are re-verified in the integration suite.
 */
class InMemoryTransferJobStore implements TransferJobStore {
  private jobs = new Map<string, TransferJob>();

  async create(job: TransferJob): Promise<void> {
    this.jobs.set(job.id, { ...job });
  }

  async get(jobId: string): Promise<TransferJob | null> {
    const j = this.jobs.get(jobId);
    return j ? { ...j } : null;
  }

  async claimNextEligible(now: number): Promise<TransferJob | null> {
    for (const job of this.jobs.values()) {
      const eligible =
        job.status === 'staged' || (job.status === 'sync_failed' && job.nextRetryAt <= now);
      if (eligible) {
        job.status = 'syncing';
        job.updatedAt = now;
        return { ...job };
      }
    }
    return null;
  }

  async markSynced(jobId: string): Promise<boolean> {
    const j = this.jobs.get(jobId);
    if (j?.status !== 'syncing') return false;
    j.status = 'synced';
    return true;
  }

  async markFailed(jobId: string, error: string, nextRetryAt: number): Promise<boolean> {
    const j = this.jobs.get(jobId);
    if (j?.status !== 'syncing') return false;
    j.retryCount += 1;
    j.lastError = error;
    j.nextRetryAt = nextRetryAt;
    j.status = j.retryCount >= j.maxRetries ? 'dead_letter' : 'sync_failed';
    return true;
  }

  async requeueDeadLetter(jobId: string): Promise<boolean> {
    const j = this.jobs.get(jobId);
    if (j?.status !== 'dead_letter') return false;
    j.status = 'staged';
    j.retryCount = 0;
    j.lastError = null;
    return true;
  }

  async listDeadLetter(): Promise<TransferJob[]> {
    return [...this.jobs.values()].filter((j) => j.status === 'dead_letter').map((j) => ({ ...j }));
  }
}

function makeJob(overrides: Partial<TransferJob> = {}): TransferJob {
  return {
    id: 'job-1',
    repo: 'my-repo',
    stagingPath: '/ssd/staging/my-repo/repo.dolt',
    checksum: 'abc123',
    status: 'staged',
    retryCount: 0,
    maxRetries: 3,
    nextRetryAt: 0,
    createdAt: 1000,
    updatedAt: 1000,
    lastError: null,
    ...overrides,
  };
}

describe('NasSyncService', () => {
  let store: InMemoryTransferJobStore;

  beforeEach(() => {
    store = new InMemoryTransferJobStore();
  });

  it('returns false when there is nothing eligible to sync', async () => {
    const nas: NasAdapter = { copyToNas: async () => ({ checksum: 'x' }) };
    const service = new NasSyncService(store, nas);
    expect(await service.processNext()).toBe(false);
  });

  it('marks a staged job as synced when the NAS copy checksum matches', async () => {
    await store.create(makeJob());
    const nas: NasAdapter = { copyToNas: async () => ({ checksum: 'abc123' }) };
    const service = new NasSyncService(store, nas);

    expect(await service.processNext()).toBe(true);
    const job = await store.get('job-1');
    expect(job?.status).toBe('synced');
  });

  it('marks the job sync_failed with a backoff when the NAS copy throws', async () => {
    await store.create(makeJob());
    const nas: NasAdapter = {
      copyToNas: async () => {
        throw new Error('NAS unreachable');
      },
    };
    const now = 5000;
    const service = new NasSyncService(
      store,
      nas,
      { backoffBaseMs: 1000, backoffMaxMs: 60_000 },
      () => now,
    );

    await service.processNext();
    const job = await store.get('job-1');
    expect(job?.status).toBe('sync_failed');
    expect(job?.retryCount).toBe(1);
    expect(job?.lastError).toContain('NAS unreachable');
    // backoffBaseMs * 2^0 = 1000ms after `now`
    expect(job?.nextRetryAt).toBe(now + 1000);
  });

  it('marks the job sync_failed on checksum mismatch, not synced', async () => {
    await store.create(makeJob({ checksum: 'expected' }));
    const nas: NasAdapter = { copyToNas: async () => ({ checksum: 'different' }) };
    const service = new NasSyncService(store, nas);

    await service.processNext();
    const job = await store.get('job-1');
    expect(job?.status).toBe('sync_failed');
    expect(job?.lastError).toContain('Checksum mismatch');
  });

  it('escalates to dead_letter once retryCount reaches maxRetries', async () => {
    await store.create(
      makeJob({ retryCount: 2, maxRetries: 3, status: 'sync_failed', nextRetryAt: 0 }),
    );
    const nas: NasAdapter = {
      copyToNas: async () => {
        throw new Error('still down');
      },
    };
    const service = new NasSyncService(store, nas);

    await service.processNext();
    const job = await store.get('job-1');
    expect(job?.status).toBe('dead_letter');
    expect(job?.retryCount).toBe(3);
  });

  it('applies exponential backoff capped at backoffMaxMs', async () => {
    await store.create(
      makeJob({ retryCount: 10, maxRetries: 20, status: 'sync_failed', nextRetryAt: 0 }),
    );
    const nas: NasAdapter = {
      copyToNas: async () => {
        throw new Error('down');
      },
    };
    const now = 0;
    const service = new NasSyncService(
      store,
      nas,
      { backoffBaseMs: 1000, backoffMaxMs: 30_000 },
      () => now,
    );

    await service.processNext();
    const job = await store.get('job-1');
    expect(job?.nextRetryAt).toBe(now + 30_000); // capped, not 1000 * 2^10
  });

  it('does not pick up a sync_failed job before its backoff window elapses', async () => {
    await store.create(makeJob({ status: 'sync_failed', nextRetryAt: 10_000, retryCount: 1 }));
    const nas: NasAdapter = { copyToNas: async () => ({ checksum: 'abc123' }) };
    let now = 5_000; // before nextRetryAt
    const service = new NasSyncService(store, nas, {}, () => now);

    expect(await service.processNext()).toBe(false);

    now = 10_001; // past nextRetryAt
    expect(await service.processNext()).toBe(true);
  });

  it('retryDeadLetter re-enters a dead_letter job into the pipeline', async () => {
    await store.create(makeJob({ status: 'dead_letter', retryCount: 3 }));
    const nas: NasAdapter = { copyToNas: async () => ({ checksum: 'abc123' }) };
    const service = new NasSyncService(store, nas);

    expect(await service.retryDeadLetter('job-1')).toBe(true);
    const job = await store.get('job-1');
    expect(job?.status).toBe('staged');
    expect(job?.retryCount).toBe(0);
  });

  it('listDeadLetter returns only dead_letter jobs', async () => {
    await store.create(makeJob({ id: 'a', status: 'dead_letter' }));
    await store.create(makeJob({ id: 'b', status: 'staged' }));
    const nas: NasAdapter = { copyToNas: async () => ({ checksum: 'x' }) };
    const service = new NasSyncService(store, nas);

    const deadLetter = await service.listDeadLetter();
    expect(deadLetter.map((j) => j.id)).toEqual(['a']);
  });
});
