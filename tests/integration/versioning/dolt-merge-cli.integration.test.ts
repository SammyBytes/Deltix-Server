import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import {
  runDoltCurrentBranch,
  runDoltLatestCommitHash,
  runDoltMerge,
  runDoltMergeAbort,
  runDoltReadConflicts,
} from '../../../src/contexts/versioning/dolt-merge-cli';

async function commitAll(doltPath: string, message: string) {
  await $`dolt --data-dir ${doltPath} add -A`.quiet();
  await $`dolt --data-dir ${doltPath} commit -m ${message}`.quiet();
}

describe('versioning/dolt-merge-cli (integration, real dolt binary)', () => {
  let workDir: string;
  let doltPath: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deltix-merge-cli-integration-'));
    doltPath = join(workDir, 'repo');
    await mkdir(doltPath, { recursive: true });
    await $`dolt --data-dir ${doltPath} init`.quiet();
    await $`dolt --data-dir ${doltPath} sql -q ${"create table items (id int primary key, value varchar(50)); insert into items values (1,'base');"}`.quiet();
    await commitAll(doltPath, 'base');
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns the latest commit hash after a clean merge', async () => {
    await $`dolt --data-dir ${doltPath} branch feature-clean`.quiet();
    await $`dolt --data-dir ${doltPath} checkout feature-clean`.quiet();
    await $`dolt --data-dir ${doltPath} sql -q ${"insert into items values (2,'feature-clean');"}`.quiet();
    await commitAll(doltPath, 'feature clean');
    await $`dolt --data-dir ${doltPath} checkout main`.quiet();

    const merge = await runDoltMerge({ doltPath, sourceBranch: 'feature-clean' });

    expect(merge.exitCode).toBe(0);
    expect(merge.stdout.toLowerCase()).toContain('updating');
    expect(await runDoltLatestCommitHash({ doltPath })).toBeString();
  });

  it('reports structured conflict rows and can abort the merge', async () => {
    await $`dolt --data-dir ${doltPath} branch feature-conflict`.quiet();
    await $`dolt --data-dir ${doltPath} checkout feature-conflict`.quiet();
    await $`dolt --data-dir ${doltPath} sql -q ${"update items set value='theirs' where id=1;"}`.quiet();
    await commitAll(doltPath, 'theirs');
    await $`dolt --data-dir ${doltPath} checkout main`.quiet();
    await $`dolt --data-dir ${doltPath} sql -q ${"update items set value='ours' where id=1;"}`.quiet();
    await commitAll(doltPath, 'ours');

    const merge = await runDoltMerge({ doltPath, sourceBranch: 'feature-conflict' });

    expect(merge.exitCode).toBe(1);
    const conflicts = await runDoltReadConflicts({ doltPath });
    expect(conflicts).toEqual([
      {
        table: 'items',
        count: 1,
        conflicts: [
          {
            fromRootIsh: expect.any(String),
            base: { id: '1', value: 'base' },
            ours: { id: '1', value: 'ours' },
            theirs: { id: '1', value: 'theirs' },
            ourDiffType: 'modified',
            theirDiffType: 'modified',
            conflictId: expect.any(String),
          },
        ],
      },
    ]);

    await runDoltMergeAbort({ doltPath });
    const status = await $`dolt --data-dir ${doltPath} status`.quiet();
    expect(status.stdout.toString()).toContain('working tree clean');
    expect(await runDoltCurrentBranch({ doltPath })).toBe('main');
  });

  it('can merge into an explicitly named target branch', async () => {
    const statusBefore = await $`dolt --data-dir ${doltPath} status`.quiet();
    expect(statusBefore.stdout.toString()).toContain('working tree clean');
    await $`dolt --data-dir ${doltPath} branch release`.quiet().nothrow();
    await $`dolt --data-dir ${doltPath} branch -D feature-target`.quiet().nothrow();
    await $`dolt --data-dir ${doltPath} branch feature-target`.quiet();
    await $`dolt --data-dir ${doltPath} checkout feature-target`.quiet();
    await $`dolt --data-dir ${doltPath} sql -q ${"insert into items values (3,'release-target');"}`.quiet();
    await commitAll(doltPath, 'target merge source');
    await $`dolt --data-dir ${doltPath} checkout main`.quiet();

    const merge = await runDoltMerge({
      doltPath,
      sourceBranch: 'feature-target',
      targetBranch: 'release',
    });

    expect(merge.exitCode).toBe(0);
    expect(await runDoltCurrentBranch({ doltPath })).toBe('release');
    const rows =
      await $`dolt --data-dir ${doltPath} sql -q ${'select id,value from items where id=3'} -r csv`.quiet();
    expect(rows.stdout.toString()).toContain('release-target');
  });
});
