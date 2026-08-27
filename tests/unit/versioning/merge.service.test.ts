import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  BranchNotFoundError,
  InvalidBranchNameError,
  RepoNotFoundError,
} from '../../../src/contexts/versioning/errors';
import { MergeService } from '../../../src/contexts/versioning/merge.service';
import type { RepoStore } from '../../../src/contexts/versioning/repo-store';
import type { RepoRecord, RepoSyncPreferenceSummary } from '../../../src/contexts/versioning/types';

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

describe('versioning/MergeService', () => {
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

  it('returns a merged result with commit hash for a clean merge', async () => {
    const service = new MergeService(store, {
      runDoltMerge: mock(async () => ({
        exitCode: 0,
        stdout: 'Fast-forward',
        stderr: '',
        currentBranch: 'main',
      })),
      runDoltMergeAbort: mock(async () => {}),
      runDoltReadConflicts: mock(async () => []),
      runDoltLatestCommitHash: mock(async () => 'abc123'),
      runDoltCurrentBranch: mock(async () => 'main'),
    });

    await expect(service.merge('demo', 'feature/demo')).resolves.toEqual({
      status: 'merged',
      targetBranch: 'main',
      sourceBranch: 'feature/demo',
      commitHash: 'abc123',
      fastForward: true,
      message: 'Fast-forward',
    });
  });

  it('returns an up_to_date result for no-op merges', async () => {
    const service = new MergeService(store, {
      runDoltMerge: mock(async () => ({
        exitCode: 0,
        stdout: 'Already up to date.',
        stderr: '',
        currentBranch: 'main',
      })),
      runDoltMergeAbort: mock(async () => {}),
      runDoltReadConflicts: mock(async () => []),
      runDoltLatestCommitHash: mock(async () => 'ignored'),
      runDoltCurrentBranch: mock(async () => 'main'),
    });

    await expect(service.merge('demo', 'feature/demo')).resolves.toEqual({
      status: 'up_to_date',
      targetBranch: 'main',
      sourceBranch: 'feature/demo',
      message: 'Already up to date.',
    });
  });

  it('captures structured conflicts and aborts the merge to keep the repo clean', async () => {
    const runDoltMergeAbort = mock(async () => {});
    const runDoltReadConflicts = mock(async () => [
      {
        table: 'items',
        count: 1,
        conflicts: [
          {
            fromRootIsh: 'root',
            base: { id: '1', value: 'base' },
            ours: { id: '1', value: 'ours' },
            theirs: { id: '1', value: 'theirs' },
            ourDiffType: 'modified',
            theirDiffType: 'modified',
            conflictId: 'conflict-1',
          },
        ],
      },
    ]);
    const service = new MergeService(store, {
      runDoltMerge: mock(async () => ({
        exitCode: 1,
        stdout: 'CONFLICT (content): Merge conflict in items',
        stderr: '',
        currentBranch: 'main',
      })),
      runDoltMergeAbort,
      runDoltReadConflicts,
      runDoltLatestCommitHash: mock(async () => 'ignored'),
      runDoltCurrentBranch: mock(async () => 'main'),
    });

    await expect(service.merge('demo', 'feature/demo')).rejects.toMatchObject({
      name: 'MergeConflictError',
      sourceBranch: 'feature/demo',
      targetBranch: 'main',
      conflicts: [expect.objectContaining({ table: 'items', count: 1 })],
    });
    expect(runDoltReadConflicts).toHaveBeenCalledTimes(1);
    expect(runDoltMergeAbort).toHaveBeenCalledTimes(1);
  });

  it.each(['', ' feature', 'bad name', '../escape', 'branch..name'])(
    'rejects invalid branch names: %p',
    async (branchName) => {
      const service = new MergeService(store, {
        runDoltMerge: mock(async () => ({
          exitCode: 0,
          stdout: '',
          stderr: '',
          currentBranch: 'main',
        })),
        runDoltMergeAbort: mock(async () => {}),
        runDoltReadConflicts: mock(async () => []),
        runDoltLatestCommitHash: mock(async () => 'hash'),
        runDoltCurrentBranch: mock(async () => 'main'),
      });

      await expect(service.merge('demo', branchName)).rejects.toBeInstanceOf(
        InvalidBranchNameError,
      );
    },
  );

  it('translates missing source or target branches into BranchNotFoundError', async () => {
    const service = new MergeService(store, {
      runDoltMerge: mock(async () => {
        throw new Error('unknown branch');
      }),
      runDoltMergeAbort: mock(async () => {}),
      runDoltReadConflicts: mock(async () => []),
      runDoltLatestCommitHash: mock(async () => 'hash'),
      runDoltCurrentBranch: mock(async () => 'main'),
    });

    await expect(service.merge('demo', 'missing')).rejects.toBeInstanceOf(BranchNotFoundError);
  });

  it('fails with RepoNotFoundError for missing repos', async () => {
    const emptyStore = new InMemoryRepoStore();
    const service = new MergeService(emptyStore, {
      runDoltMerge: mock(async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        currentBranch: 'main',
      })),
      runDoltMergeAbort: mock(async () => {}),
      runDoltReadConflicts: mock(async () => []),
      runDoltLatestCommitHash: mock(async () => 'hash'),
      runDoltCurrentBranch: mock(async () => 'main'),
    });

    await expect(service.merge('missing', 'feature/demo')).rejects.toBeInstanceOf(
      RepoNotFoundError,
    );
  });

  it('checks out an explicit target branch before merging into it', async () => {
    const runDoltMerge = mock(async () => ({
      exitCode: 0,
      stdout: 'merge ok',
      stderr: '',
      currentBranch: 'release',
    }));
    const service = new MergeService(store, {
      runDoltMerge,
      runDoltMergeAbort: mock(async () => {}),
      runDoltReadConflicts: mock(async () => []),
      runDoltLatestCommitHash: mock(async () => 'hash'),
      runDoltCurrentBranch: mock(async () => 'main'),
    });

    await service.merge('demo', 'feature/demo', 'release');

    expect(runDoltMerge).toHaveBeenCalledWith({
      doltPath: '/repos/demo',
      sourceBranch: 'feature/demo',
      targetBranch: 'release',
    });
  });
});
