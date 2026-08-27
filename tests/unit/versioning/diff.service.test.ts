import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { DiffService } from '../../../src/contexts/versioning/diff.service';
import {
  BranchNotFoundError,
  InvalidCommitReferenceError,
  RepoNotFoundError,
} from '../../../src/contexts/versioning/errors';
import type { RepoStore } from '../../../src/contexts/versioning/repo-store';
import type {
  DiffResult,
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

describe('versioning/DiffService', () => {
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

  it('reads structured diffs for a provisioned repo', async () => {
    const diff: DiffResult = {
      fromRef: 'main',
      toRef: 'feat',
      tables: [
        {
          table: 'items',
          diffType: 'modified',
          dataChange: true,
          schemaChange: false,
          changes: [
            {
              diffType: 'modified',
              oldValues: { id: '1', name: 'a' },
              newValues: { id: '1', name: 'b' },
            },
          ],
        },
      ],
    };
    const runDoltReadDiff = mock(async () => diff);
    const service = new DiffService(store, { runDoltReadDiff });

    await expect(service.read('demo', 'main', 'feat')).resolves.toEqual(diff);
    expect(runDoltReadDiff).toHaveBeenCalledWith({
      doltPath: '/repos/demo',
      fromRef: 'main',
      toRef: 'feat',
    });
  });

  it.each([' bad', '../escape', 'branch..name', 'ABCDEF1234567890ABCDEF1234567890'])(
    'rejects invalid refs: %p',
    async (ref) => {
      const service = new DiffService(store, {
        runDoltReadDiff: mock(async () => ({ fromRef: 'a', toRef: 'b', tables: [] })),
      });
      await expect(service.read('demo', ref, 'main')).rejects.toBeInstanceOf(
        InvalidCommitReferenceError,
      );
    },
  );

  it('accepts a 32-character lowercase dolt commit hash as a ref', async () => {
    const runDoltReadDiff = mock(async () => ({ fromRef: 'a', toRef: 'b', tables: [] }));
    const service = new DiffService(store, { runDoltReadDiff });
    await service.read('demo', '3lfs06dv07gacfldu98ml064ks0n2rtm', 'main');
    expect(runDoltReadDiff).toHaveBeenCalledTimes(1);
  });

  it('translates missing refs into BranchNotFoundError', async () => {
    const service = new DiffService(store, {
      runDoltReadDiff: mock(async () => {
        throw new Error('branch not found');
      }),
    });
    await expect(service.read('demo', 'main', 'missing')).rejects.toBeInstanceOf(
      BranchNotFoundError,
    );
  });

  it('fails with RepoNotFoundError for missing repos', async () => {
    const service = new DiffService(new InMemoryRepoStore(), {
      runDoltReadDiff: mock(async () => ({ fromRef: 'a', toRef: 'b', tables: [] })),
    });
    await expect(service.read('missing', 'main', 'feat')).rejects.toBeInstanceOf(RepoNotFoundError);
  });
});
