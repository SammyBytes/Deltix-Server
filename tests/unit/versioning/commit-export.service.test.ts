import { describe, expect, it, mock } from 'bun:test';
import {
  CommitExportService,
  type ExportedCommit,
} from '../../../src/contexts/versioning/commit-export.service';
import { RepoNotFoundError } from '../../../src/contexts/versioning/errors';
import type { RepoStore } from '../../../src/contexts/versioning/repo-store';
import type { RepoRecord, RepoSyncPreferenceSummary } from '../../../src/contexts/versioning/types';

function createRepoStore(record: RepoRecord | null = null): RepoStore {
  let current = record;
  return {
    init: async () => {},
    create: async (r) => {
      current = r;
    },
    get: async () => current,
    list: async () => (current ? [current] : []),
    getSyncPreference: async (): Promise<RepoSyncPreferenceSummary | null> => null,
    upsertSyncPreference: async () => {},
  };
}

const demoRepo: RepoRecord = {
  repoId: 'demo',
  doltPath: '/repos/demo',
  createdAt: 1,
  createdBy: 'seed',
};

const commits: ExportedCommit[] = [
  {
    hash: 'h1',
    message: 'add customers',
    author: 'alice',
    tables: [{ name: 'customers', data: 'id\n1\n' }],
  },
  {
    hash: 'h2',
    message: 'add orders',
    author: 'bob',
    tables: [{ name: 'orders', data: 'id\n10\n' }],
  },
];

function fakeExport() {
  return mock(async function* () {
    for (const c of commits) yield c;
  });
}

describe('versioning/CommitExportService', () => {
  it('streams commits oldest-first from the injected exporter', async () => {
    const service = new CommitExportService(
      createRepoStore(demoRepo),
      fakeExport(),
      async () => 'h2',
      async () => [],
    );
    const out: ExportedCommit[] = [];
    for await (const c of service.streamCommits('demo', 'main', null)) out.push(c);
    expect(out.map((c) => c.hash)).toEqual(['h1', 'h2']);
  });

  it('passes repoId doltPath, branch and fromHash through to the exporter', async () => {
    const runExport = fakeExport();
    const service = new CommitExportService(
      createRepoStore(demoRepo),
      runExport,
      async () => 'h2',
      async () => [],
    );
    for await (const _ of service.streamCommits('demo', 'main', 'h1')) {
      /* drain */
    }
    expect(runExport).toHaveBeenCalledWith({
      doltPath: '/repos/demo',
      branch: 'main',
      fromHash: 'h1',
    });
  });

  it('returns the branch head via the injected head getter', async () => {
    const service = new CommitExportService(
      createRepoStore(demoRepo),
      fakeExport(),
      async () => 'abc',
      async () => [],
    );
    expect(await service.getBranchHead('demo', 'main')).toBe('abc');
  });

  it('lists refs via the injected lister', async () => {
    const service = new CommitExportService(
      createRepoStore(demoRepo),
      fakeExport(),
      async () => 'abc',
      async () => [{ branch: 'main', hash: 'abc' }],
    );
    expect(await service.listRefs('demo')).toEqual([{ branch: 'main', hash: 'abc' }]);
  });

  it('throws RepoNotFoundError for an unknown repo', async () => {
    const service = new CommitExportService(
      createRepoStore(null),
      fakeExport(),
      async () => null,
      async () => [],
    );
    await expect(service.getBranchHead('ghost')).rejects.toBeInstanceOf(RepoNotFoundError);
    const it2 = service.streamCommits('ghost');
    await expect(it2.next()).rejects.toBeInstanceOf(RepoNotFoundError);
  });
});
