import { afterEach, describe, expect, it } from 'bun:test';
import { rm } from 'node:fs/promises';
import { LibsqlTransferJobStore } from '../../../src/contexts/storage/libsql-transfer-job-store';
import type { TransferJob } from '../../../src/contexts/storage/types';

function makeJob(overrides: Partial<TransferJob> = {}): TransferJob {
  return {
    id: `job-${Math.random().toString(36).slice(2)}`,
    repo: 'org/repo',
    stagingPath: '/ssd/staging/org/repo/repo.dolt',
    checksum: 'deadbeef',
    status: 'staged',
    retryCount: 0,
    maxRetries: 3,
    nextRetryAt: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    lastError: null,
    ...overrides,
  };
}

describe('storage/libsql-transfer-job-store (integration, real libSQL file)', () => {
  const dbPath = `/tmp/deltix-transfer-jobs-test-${Date.now()}.db`;

  afterEach(async () => {
    await rm(dbPath, { force: true });
    await rm(`${dbPath}-wal`, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
  });

  it('creates and reads back a job row', async () => {
    const store = new LibsqlTransferJobStore(dbPath);
    await store.init();

    const job = makeJob();
    await store.create(job);

    expect(await store.get(job.id)).toEqual(job);
  });

  it('returns null for an unknown job id', async () => {
    const store = new LibsqlTransferJobStore(dbPath);
    await store.init();
    expect(await store.get('nonexistent')).toBeNull();
  });

  describe('claimNextEligible()', () => {
    it('claims a staged job and transitions it to syncing', async () => {
      const store = new LibsqlTransferJobStore(dbPath);
      await store.init();
      const job = makeJob();
      await store.create(job);

      const claimed = await store.claimNextEligible(2_000);

      expect(claimed?.id).toBe(job.id);
      expect(claimed?.status).toBe('syncing');
      expect((await store.get(job.id))?.status).toBe('syncing');
    });

    it('returns null when nothing is staged or past its retry window', async () => {
      const store = new LibsqlTransferJobStore(dbPath);
      await store.init();
      await store.create(makeJob({ status: 'sync_failed', nextRetryAt: 5_000 }));

      expect(await store.claimNextEligible(1_000)).toBeNull();
    });

    it('claims a sync_failed job once its backoff window has elapsed', async () => {
      const store = new LibsqlTransferJobStore(dbPath);
      await store.init();
      const job = makeJob({ status: 'sync_failed', nextRetryAt: 5_000, retryCount: 1 });
      await store.create(job);

      expect(await store.claimNextEligible(4_999)).toBeNull();
      const claimed = await store.claimNextEligible(5_000);
      expect(claimed?.id).toBe(job.id);
    });

    it('never claims a job already syncing/synced/dead_letter', async () => {
      const store = new LibsqlTransferJobStore(dbPath);
      await store.init();
      await store.create(makeJob({ id: 'a', status: 'syncing' }));
      await store.create(makeJob({ id: 'b', status: 'synced' }));
      await store.create(makeJob({ id: 'c', status: 'dead_letter' }));

      expect(await store.claimNextEligible(999_999)).toBeNull();
    });
  });

  describe('markSynced() / markFailed()', () => {
    it('transitions syncing -> synced', async () => {
      const store = new LibsqlTransferJobStore(dbPath);
      await store.init();
      const job = makeJob({ status: 'syncing' });
      await store.create(job);

      expect(await store.markSynced(job.id)).toBe(true);
      expect((await store.get(job.id))?.status).toBe('synced');
    });

    it('markSynced returns false if the job is not currently syncing', async () => {
      const store = new LibsqlTransferJobStore(dbPath);
      await store.init();
      const job = makeJob({ status: 'staged' });
      await store.create(job);

      expect(await store.markSynced(job.id)).toBe(false);
      expect((await store.get(job.id))?.status).toBe('staged');
    });

    it('transitions syncing -> sync_failed and increments retryCount when retries remain', async () => {
      const store = new LibsqlTransferJobStore(dbPath);
      await store.init();
      const job = makeJob({ status: 'syncing', retryCount: 0, maxRetries: 3 });
      await store.create(job);

      expect(await store.markFailed(job.id, 'boom', 9_999)).toBe(true);
      const updated = await store.get(job.id);
      expect(updated?.status).toBe('sync_failed');
      expect(updated?.retryCount).toBe(1);
      expect(updated?.lastError).toBe('boom');
      expect(updated?.nextRetryAt).toBe(9_999);
    });

    it('transitions syncing -> dead_letter once retryCount would reach maxRetries', async () => {
      const store = new LibsqlTransferJobStore(dbPath);
      await store.init();
      const job = makeJob({ status: 'syncing', retryCount: 2, maxRetries: 3 });
      await store.create(job);

      expect(await store.markFailed(job.id, 'still down', 9_999)).toBe(true);
      const updated = await store.get(job.id);
      expect(updated?.status).toBe('dead_letter');
      expect(updated?.retryCount).toBe(3);
    });
  });

  describe('requeueDeadLetter() / listDeadLetter()', () => {
    it('requeues a dead_letter job back to staged with retryCount reset', async () => {
      const store = new LibsqlTransferJobStore(dbPath);
      await store.init();
      const job = makeJob({ status: 'dead_letter', retryCount: 3, lastError: 'boom' });
      await store.create(job);

      expect(await store.requeueDeadLetter(job.id)).toBe(true);
      const updated = await store.get(job.id);
      expect(updated?.status).toBe('staged');
      expect(updated?.retryCount).toBe(0);
      expect(updated?.lastError).toBeNull();
    });

    it('requeueDeadLetter returns false for a job that is not dead_letter', async () => {
      const store = new LibsqlTransferJobStore(dbPath);
      await store.init();
      await store.create(makeJob({ status: 'staged' }));
      expect(await store.requeueDeadLetter('nonexistent')).toBe(false);
    });

    it('listDeadLetter returns only dead_letter jobs', async () => {
      const store = new LibsqlTransferJobStore(dbPath);
      await store.init();
      await store.create(makeJob({ id: 'a', status: 'dead_letter' }));
      await store.create(makeJob({ id: 'b', status: 'staged' }));

      const deadLetter = await store.listDeadLetter();
      expect(deadLetter.map((j) => j.id)).toEqual(['a']);
    });
  });

  describe('concurrency: real parallel racing workers against the same libSQL file', () => {
    it('only one of many concurrent claimNextEligible() calls wins a single staged job', async () => {
      const store = new LibsqlTransferJobStore(dbPath);
      await store.init();
      const job = makeJob();
      await store.create(job);

      // Independent store instances, same underlying file — mirrors the
      // realistic topology of multiple concurrent sync worker ticks.
      const workers = Array.from({ length: 20 }, () => new LibsqlTransferJobStore(dbPath));
      const results = await Promise.all(workers.map((w) => w.claimNextEligible(999_999)));

      const winners = results.filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      expect((await store.get(job.id))?.status).toBe('syncing');
    });

    it('only one of many concurrent markFailed() calls on the same syncing job wins', async () => {
      const store = new LibsqlTransferJobStore(dbPath);
      await store.init();
      const job = makeJob({ status: 'syncing' });
      await store.create(job);

      const workers = Array.from({ length: 20 }, () => new LibsqlTransferJobStore(dbPath));
      const results = await Promise.all(workers.map((w) => w.markFailed(job.id, 'race', 12_345)));

      expect(results.filter(Boolean)).toHaveLength(1);
      const updated = await store.get(job.id);
      expect(updated?.retryCount).toBe(1); // exactly one increment, not 20
    });
  });
});
