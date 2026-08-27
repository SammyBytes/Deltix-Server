import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  BranchNotFoundError,
  InvalidBranchNameError,
  InvalidPaginationLimitError,
  RepoNotFoundError,
} from '../../../src/contexts/versioning/errors';
import { LogService } from '../../../src/contexts/versioning/log.service';
import type { RepoStore } from '../../../src/contexts/versioning/repo-store';
import type {
  LogCommitEntry,
  RepoRecord,
  RepoSyncPreferenceSummary,
} from '../../../src/contexts/versioning/types';

class InMemoryRepoStore implements RepoStore {
  private records = new Map<string, RepoRecord>();
  async init(): Promise<void> {}
  async create(record: RepoRecord): Promise<void> {
    this.records.set(record.repoId, record);
  }
  async get(repoId: string): Promise<RepoRecord | null> {
    return this.records.get(repoId) ?? null;
  }
  async list(): Promise<RepoRecord[]> {
    return [...this.records.values()];
  }
  async getSyncPreference(_repoId: string): Promise<RepoSyncPreferenceSummary | null> {
    return null;
  }
  async upsertSyncPreference(): Promise<void> {}
}

describe('versioning/LogService', () => {
  let store: InMemoryRepoStore;

  beforeEach(async () => {
    store = new InMemoryRepoStore();
    await store.create({
      repoId: 'demo',
      doltPath: '/repos/demo',
      createdAt: 1,
      createdBy: 'seed',
    });
  });

  it('reads commit history for a provisioned repo', async () => {
    const entries: LogCommitEntry[] = [
      {
        commitHash: '3lfs06dv07gacfldu98ml064ks0n2rtm',
        author: 'alice',
        authorEmail: 'alice@example.com',
        timestamp: '2026-08-27 11:27:53.188',
        message: 'feat',
        parents: ['apdhclv4ccmlg921t1ot845rptsp24jp'],
      },
    ];
    const runDoltReadLog = mock(async () => entries);
    const service = new LogService(store, { runDoltReadLog });

    await expect(service.list('demo', { limit: 10 })).resolves.toEqual(entries);
    expect(runDoltReadLog).toHaveBeenCalledWith({
      doltPath: '/repos/demo',
      branchName: undefined,
      limit: 10,
    });
  });

  it('defaults limit to 50 and clamps it to 200', async () => {
    const runDoltReadLog = mock(async () => []);
    const service = new LogService(store, { runDoltReadLog });

    await service.list('demo', {});
    await service.list('demo', { limit: 999 });

    expect(runDoltReadLog).toHaveBeenNthCalledWith(1, {
      doltPath: '/repos/demo',
      branchName: undefined,
      limit: 50,
    });
    expect(runDoltReadLog).toHaveBeenNthCalledWith(2, {
      doltPath: '/repos/demo',
      branchName: undefined,
      limit: 200,
    });
  });

  it.each([' feature', 'bad name', '../escape', 'branch..name'])(
    'rejects invalid branch names: %p',
    async (branchName) => {
      const service = new LogService(store, { runDoltReadLog: mock(async () => []) });
      await expect(service.list('demo', { branch: branchName })).rejects.toBeInstanceOf(
        InvalidBranchNameError,
      );
    },
  );

  it.each([0, -1, 1.5])('rejects invalid pagination limits: %p', async (limit) => {
    const service = new LogService(store, { runDoltReadLog: mock(async () => []) });
    await expect(service.list('demo', { limit })).rejects.toBeInstanceOf(
      InvalidPaginationLimitError,
    );
  });

  it('translates unknown branch errors into BranchNotFoundError', async () => {
    const service = new LogService(store, {
      runDoltReadLog: mock(async () => {
        throw new Error('unknown branch');
      }),
    });

    await expect(service.list('demo', { branch: 'missing' })).rejects.toBeInstanceOf(
      BranchNotFoundError,
    );
  });

  it('fails with RepoNotFoundError for missing repos', async () => {
    const service = new LogService(new InMemoryRepoStore(), {
      runDoltReadLog: mock(async () => []),
    });
    await expect(service.list('missing', {})).rejects.toBeInstanceOf(RepoNotFoundError);
  });
});
