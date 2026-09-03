import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CommitImportError,
  CommitImportService,
} from '../../../src/contexts/versioning/commit-import.service';
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
});
