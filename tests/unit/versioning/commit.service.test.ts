import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { CommitService } from '../../../src/contexts/versioning/commit.service';
import { CommitFailedError } from '../../../src/contexts/versioning/errors';
import type { RepoStore } from '../../../src/contexts/versioning/repo-store';
import type { RepoRecord, RepoSyncPreferenceSummary } from '../../../src/contexts/versioning/types';

class InMemoryRepoStore implements RepoStore {
  private records = new Map<string, RepoRecord>();
  private syncPreferences = new Map<string, RepoSyncPreferenceSummary>();

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

  async getSyncPreference(repoId: string): Promise<RepoSyncPreferenceSummary | null> {
    return this.syncPreferences.get(repoId) ?? null;
  }

  async upsertSyncPreference(params: {
    repoId: string;
    mode: RepoSyncPreferenceSummary['mode'];
    requestedTables: string[] | null;
    createdAt: number;
    updatedAt: number;
  }): Promise<void> {
    this.syncPreferences.set(params.repoId, {
      mode: params.mode,
      requestedTables: params.requestedTables,
    });
  }
}

describe('versioning/CommitService', () => {
  let store: InMemoryRepoStore;

  beforeEach(() => {
    store = new InMemoryRepoStore();
  });

  it('returns null and never invokes runDoltCommit for a repo that was never provisioned', async () => {
    const runDoltCommit = mock(async () => 'deadbeef');
    const service = new CommitService(store, runDoltCommit);

    const result = await service.recordPush({
      repo: 'unprovisioned-repo',
      username: 'alice',
      jobId: 'job-1',
      checksum: 'abc123',
    });

    expect(result).toBeNull();
    expect(runDoltCommit).not.toHaveBeenCalled();
  });

  it('invokes runDoltCommit with the repo Dolt path and returns the new commit hash', async () => {
    await store.create({
      repoId: 'demo-repo',
      doltPath: '/tmp/dolt-repos/demo-repo',
      createdAt: 1,
      createdBy: 'alice',
    });
    const runDoltCommit = mock(async () => 'abcdef1234567890');
    const service = new CommitService(store, runDoltCommit);

    const result = await service.recordPush({
      repo: 'demo-repo',
      username: 'alice',
      jobId: 'job-42',
      checksum: 'deadbeef',
    });

    expect(result).toBe('abcdef1234567890');
    expect(runDoltCommit).toHaveBeenCalledTimes(1);
    expect(runDoltCommit).toHaveBeenCalledWith({
      doltPath: '/tmp/dolt-repos/demo-repo',
      authorName: 'alice',
      jobId: 'job-42',
      checksum: 'deadbeef',
    });
  });

  it('wraps a runDoltCommit failure in CommitFailedError without corrupting repo state', async () => {
    await store.create({
      repoId: 'demo-repo',
      doltPath: '/tmp/dolt-repos/demo-repo',
      createdAt: 1,
      createdBy: 'alice',
    });
    const runDoltCommit = mock(async () => {
      throw new Error('dolt commit exploded');
    });
    const service = new CommitService(store, runDoltCommit);

    await expect(
      service.recordPush({
        repo: 'demo-repo',
        username: 'alice',
        jobId: 'job-1',
        checksum: 'abc',
      }),
    ).rejects.toThrow(CommitFailedError);
  });
});
