import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { BranchService } from '../../../src/contexts/versioning/branch.service';
import {
  BranchAlreadyExistsError,
  BranchNotFoundError,
  InvalidBranchNameError,
  ProtectedBranchError,
  RepoNotFoundError,
} from '../../../src/contexts/versioning/errors';
import type { RepoStore } from '../../../src/contexts/versioning/repo-store';
import type {
  BranchSummary,
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

describe('versioning/BranchService', () => {
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

  it('lists branches for a provisioned repo', async () => {
    const runDoltListBranches = mock(
      async () =>
        [
          { name: 'main', isCurrent: true },
          { name: 'feature/x', isCurrent: false },
        ] satisfies BranchSummary[],
    );
    const service = new BranchService(store, {
      runDoltListBranches,
      runDoltCurrentBranch: mock(async () => 'main'),
      runDoltCreateBranch: mock(async () => {}),
      runDoltCheckoutBranch: mock(async () => {}),
      runDoltDeleteBranch: mock(async () => {}),
    });

    const branches = await service.list('demo');

    expect(branches).toHaveLength(2);
    expect(runDoltListBranches).toHaveBeenCalledWith({ doltPath: '/repos/demo' });
  });

  it('creates a branch after validating its name', async () => {
    const runDoltCreateBranch = mock(async () => {});
    const service = new BranchService(store, {
      runDoltListBranches: mock(async () => [{ name: 'main', isCurrent: true }]),
      runDoltCurrentBranch: mock(async () => 'main'),
      runDoltCreateBranch,
      runDoltCheckoutBranch: mock(async () => {}),
      runDoltDeleteBranch: mock(async () => {}),
    });

    await service.create('demo', 'feature/demo');

    expect(runDoltCreateBranch).toHaveBeenCalledWith({
      doltPath: '/repos/demo',
      branchName: 'feature/demo',
    });
  });

  it.each(['', ' feature', 'bad name', '../escape', 'branch..name', 'branch~name', 'branch^name'])(
    'rejects invalid branch names: %p',
    async (branchName) => {
      const service = new BranchService(store, {
        runDoltListBranches: mock(async () => []),
        runDoltCurrentBranch: mock(async () => 'main'),
        runDoltCreateBranch: mock(async () => {}),
        runDoltCheckoutBranch: mock(async () => {}),
        runDoltDeleteBranch: mock(async () => {}),
      });

      await expect(service.create('demo', branchName)).rejects.toBeInstanceOf(
        InvalidBranchNameError,
      );
    },
  );

  it('checks out a branch on a provisioned repo', async () => {
    const runDoltCheckoutBranch = mock(async () => {});
    const service = new BranchService(store, {
      runDoltListBranches: mock(async () => [{ name: 'main', isCurrent: true }]),
      runDoltCurrentBranch: mock(async () => 'main'),
      runDoltCreateBranch: mock(async () => {}),
      runDoltCheckoutBranch,
      runDoltDeleteBranch: mock(async () => {}),
    });

    await service.checkout('demo', 'feature/demo');

    expect(runDoltCheckoutBranch).toHaveBeenCalledWith({
      doltPath: '/repos/demo',
      branchName: 'feature/demo',
    });
  });

  it('returns the current branch', async () => {
    const service = new BranchService(store, {
      runDoltListBranches: mock(async () => []),
      runDoltCurrentBranch: mock(async () => 'feature/demo'),
      runDoltCreateBranch: mock(async () => {}),
      runDoltCheckoutBranch: mock(async () => {}),
      runDoltDeleteBranch: mock(async () => {}),
    });

    await expect(service.current('demo')).resolves.toBe('feature/demo');
  });

  it('refuses to delete the current branch', async () => {
    const service = new BranchService(store, {
      runDoltListBranches: mock(async () => []),
      runDoltCurrentBranch: mock(async () => 'feature/demo'),
      runDoltCreateBranch: mock(async () => {}),
      runDoltCheckoutBranch: mock(async () => {}),
      runDoltDeleteBranch: mock(async () => {}),
    });

    await expect(service.delete('demo', 'feature/demo')).rejects.toBeInstanceOf(
      ProtectedBranchError,
    );
  });

  it('refuses to delete the protected default branch', async () => {
    const service = new BranchService(store, {
      runDoltListBranches: mock(async () => []),
      runDoltCurrentBranch: mock(async () => 'feature/demo'),
      runDoltCreateBranch: mock(async () => {}),
      runDoltCheckoutBranch: mock(async () => {}),
      runDoltDeleteBranch: mock(async () => {}),
    });

    await expect(service.delete('demo', 'main')).rejects.toBeInstanceOf(ProtectedBranchError);
  });

  it('deletes a non-protected branch', async () => {
    const runDoltDeleteBranch = mock(async () => {});
    const service = new BranchService(store, {
      runDoltListBranches: mock(async () => []),
      runDoltCurrentBranch: mock(async () => 'main'),
      runDoltCreateBranch: mock(async () => {}),
      runDoltCheckoutBranch: mock(async () => {}),
      runDoltDeleteBranch,
    });

    await service.delete('demo', 'feature/demo');

    expect(runDoltDeleteBranch).toHaveBeenCalledWith({
      doltPath: '/repos/demo',
      branchName: 'feature/demo',
    });
  });

  it('translates raw branch cli errors into typed domain errors', async () => {
    const service = new BranchService(store, {
      runDoltListBranches: mock(async () => {
        throw new Error('branch already exists');
      }),
      runDoltCurrentBranch: mock(async () => {
        throw new Error('branch not found');
      }),
      runDoltCreateBranch: mock(async () => {
        throw new Error('already exists');
      }),
      runDoltCheckoutBranch: mock(async () => {
        throw new Error('branch not found');
      }),
      runDoltDeleteBranch: mock(async () => {
        throw new Error('branch not found');
      }),
    });

    await expect(service.create('demo', 'feature/demo')).rejects.toBeInstanceOf(
      BranchAlreadyExistsError,
    );
    await expect(service.checkout('demo', 'feature/demo')).rejects.toBeInstanceOf(
      BranchNotFoundError,
    );
    await expect(service.delete('demo', 'feature/demo')).rejects.toBeInstanceOf(
      BranchNotFoundError,
    );
  });

  it('fails with RepoNotFoundError for missing repos', async () => {
    const emptyStore = new InMemoryRepoStore();
    const service = new BranchService(emptyStore, {
      runDoltListBranches: mock(async () => []),
      runDoltCurrentBranch: mock(async () => 'main'),
      runDoltCreateBranch: mock(async () => {}),
      runDoltCheckoutBranch: mock(async () => {}),
      runDoltDeleteBranch: mock(async () => {}),
    });

    await expect(service.list('missing')).rejects.toBeInstanceOf(RepoNotFoundError);
  });
});
