import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CommitImportError,
  CommitImportService,
} from '../../../src/contexts/versioning/commit-import.service';
import { NonFastForwardError } from '../../../src/contexts/versioning/errors';
import { LibsqlRepoStore } from '../../../src/contexts/versioning/libsql-repo-store';

function createRepoStore() {
  return new LibsqlRepoStore(':memory:');
}

describe('versioning/CommitImportService', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'deltix-commit-import-test-'));
  });

  it('imports commits and returns the last commit hash', async () => {
    const store = createRepoStore();
    await store.init();
    await store.create({
      repoId: 'demo',
      doltPath: join(tempDir, 'demo'),
      createdAt: 1,
      createdBy: 'seed',
    });

    const runImport = mock(async () => 'abc123');
    const service = new CommitImportService(store, runImport);

    const result = await service.importCommits('demo', [
      {
        message: 'feat: add orders',
        author: 'alice',
        tables: [{ name: 'orders', data: 'id,name\n1,order1' }],
      },
    ]);

    expect(result.commitHash).toBe('abc123');
    expect(result.repo).toBe('demo');
    expect(runImport).toHaveBeenCalledTimes(1);
  });

  it('imports multiple commits sequentially', async () => {
    const store = createRepoStore();
    await store.init();
    await store.create({
      repoId: 'demo',
      doltPath: join(tempDir, 'demo'),
      createdAt: 1,
      createdBy: 'seed',
    });

    const runImport = mock(async () => 'hash');
    const service = new CommitImportService(store, runImport);

    const result = await service.importCommits('demo', [
      {
        message: 'first',
        author: 'alice',
        tables: [{ name: 'orders', data: 'id\n1' }],
      },
      {
        message: 'second',
        author: 'alice',
        tables: [{ name: 'customers', data: 'id\n1' }],
      },
    ]);

    expect(result.commitHash).toBe('hash');
    expect(runImport).toHaveBeenCalledTimes(2);
  });

  it('skips commits with no tables', async () => {
    const store = createRepoStore();
    await store.init();
    await store.create({
      repoId: 'demo',
      doltPath: join(tempDir, 'demo'),
      createdAt: 1,
      createdBy: 'seed',
    });

    const runImport = mock(async () => 'hash');
    const service = new CommitImportService(store, runImport);

    await expect(
      service.importCommits('demo', [
        {
          message: 'empty',
          author: 'alice',
          tables: [],
        },
      ]),
    ).rejects.toThrow(CommitImportError);
  });

  it('throws CommitImportError for nonexistent repo', async () => {
    const store = createRepoStore();
    await store.init();

    const service = new CommitImportService(store, async () => 'hash');

    await expect(
      service.importCommits('nonexistent', [
        {
          message: 'test',
          author: 'alice',
          tables: [{ name: 'orders', data: 'id\n1' }],
        },
      ]),
    ).rejects.toThrow(CommitImportError);
  });

  it('throws CommitImportError for empty commits array', async () => {
    const store = createRepoStore();
    await store.init();
    await store.create({
      repoId: 'demo',
      doltPath: join(tempDir, 'demo'),
      createdAt: 1,
      createdBy: 'seed',
    });

    const service = new CommitImportService(store, async () => 'hash');

    await expect(service.importCommits('demo', [])).rejects.toThrow(CommitImportError);
  });

  it('throws CommitImportError when all commits have empty tables', async () => {
    const store = createRepoStore();
    await store.init();
    await store.create({
      repoId: 'demo',
      doltPath: join(tempDir, 'demo'),
      createdAt: 1,
      createdBy: 'seed',
    });

    const runImport = mock(async () => 'hash');
    const service = new CommitImportService(store, runImport);

    // Two commits, both with empty tables — both skipped, no hash returned
    await expect(
      service.importCommits('demo', [
        { message: 'a', author: 'alice', tables: [] },
        { message: 'b', author: 'alice', tables: [] },
      ]),
    ).rejects.toThrow(CommitImportError);
  });

  it('accepts a fast-forward push when from matches the remote head', async () => {
    const store = createRepoStore();
    await store.init();
    await store.create({
      repoId: 'demo',
      doltPath: join(tempDir, 'demo'),
      createdAt: 1,
      createdBy: 'seed',
    });

    const runImport = mock(async () => 'newhash');
    const runBranchHead = mock(async ({ branch }: { branch: string }) =>
      branch === 'main' ? 'basehead' : null,
    );
    const service = new CommitImportService(store, runImport, runBranchHead);

    const result = await service.importCommits(
      'demo',
      [{ message: 'feat', author: 'alice', tables: [{ name: 't', data: 'id\n1' }] }],
      'basehead',
    );

    expect(result.commitHash).toBe('newhash');
    expect(runImport).toHaveBeenCalled();
  });

  it('rejects a non-fast-forward push when the remote head has advanced', async () => {
    const store = createRepoStore();
    await store.init();
    await store.create({
      repoId: 'demo',
      doltPath: join(tempDir, 'demo'),
      createdAt: 1,
      createdBy: 'seed',
    });

    const runImport = mock(async () => 'newhash');
    const runBranchHead = mock(async () => 'newerhead');
    const service = new CommitImportService(store, runImport, runBranchHead);

    await expect(
      service.importCommits(
        'demo',
        [{ message: 'feat', author: 'alice', tables: [{ name: 't', data: 'id\n1' }] }],
        'basehead',
      ),
    ).rejects.toThrow(NonFastForwardError);
    expect(runImport).not.toHaveBeenCalled();
  });

  it('does not reject when from is absent (backwards-compatible client)', async () => {
    const store = createRepoStore();
    await store.init();
    await store.create({
      repoId: 'demo',
      doltPath: join(tempDir, 'demo'),
      createdAt: 1,
      createdBy: 'seed',
    });

    const runImport = mock(async () => 'newhash');
    const runBranchHead = mock(async () => 'newerhead');
    const service = new CommitImportService(store, runImport, runBranchHead);

    const result = await service.importCommits('demo', [
      { message: 'feat', author: 'alice', tables: [{ name: 't', data: 'id\n1' }] },
    ]);

    expect(result.commitHash).toBe('newhash');
    expect(runImport).toHaveBeenCalled();
  });

  it('forwards the client-requested branch to the commit runner instead of always importing to main', async () => {
    const store = createRepoStore();
    await store.init();
    await store.create({
      repoId: 'demo',
      doltPath: join(tempDir, 'demo'),
      createdAt: 1,
      createdBy: 'seed',
    });

    const runImport = mock(async () => 'newhash');
    const service = new CommitImportService(store, runImport);

    await service.importCommits(
      'demo',
      [{ message: 'feat', author: 'alice', tables: [{ name: 't', data: 'id\n1' }] }],
      null,
      'sync-develop-base',
    );

    expect(runImport).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'sync-develop-base' }),
    );
  });

  it('checks the remote head on the client-requested branch, not always main', async () => {
    const store = createRepoStore();
    await store.init();
    await store.create({
      repoId: 'demo',
      doltPath: join(tempDir, 'demo'),
      createdAt: 1,
      createdBy: 'seed',
    });

    const runImport = mock(async () => 'newhash');
    const runBranchHead = mock(async ({ branch }: { branch: string }) =>
      branch === 'sync-develop-base' ? 'basehead' : 'wrong-branch-head',
    );
    const service = new CommitImportService(store, runImport, runBranchHead);

    const result = await service.importCommits(
      'demo',
      [{ message: 'feat', author: 'alice', tables: [{ name: 't', data: 'id\n1' }] }],
      'basehead',
      'sync-develop-base',
    );

    expect(result.commitHash).toBe('newhash');
    expect(runBranchHead).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'sync-develop-base' }),
    );
  });
});
