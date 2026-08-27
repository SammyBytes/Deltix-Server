import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { runDoltReadDiff } from '../../../src/contexts/versioning/dolt-diff-cli';
import { runDoltReadLog } from '../../../src/contexts/versioning/dolt-log-cli';

async function commitAll(doltPath: string, message: string) {
  await $`dolt --data-dir ${doltPath} add -A`.quiet();
  await $`dolt --data-dir ${doltPath} commit -m ${message}`.quiet();
}

describe('versioning/dolt-log-cli + dolt-diff-cli (integration, real dolt binary)', () => {
  let workDir: string;
  let doltPath: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deltix-history-cli-integration-'));
    doltPath = join(workDir, 'repo');
    await mkdir(doltPath, { recursive: true });
    await $`dolt --data-dir ${doltPath} init`.quiet();
    await $`dolt --data-dir ${doltPath} sql -q ${"create table items (id int primary key, name varchar(50)); insert into items values (1,'a');"}`.quiet();
    await commitAll(doltPath, 'init');
    await $`dolt --data-dir ${doltPath} branch feat`.quiet();
    await $`dolt --data-dir ${doltPath} checkout feat`.quiet();
    await $`dolt --data-dir ${doltPath} sql -q ${"update items set name='b' where id=1; insert into items values (2,'c');"}`.quiet();
    await commitAll(doltPath, 'feat');
    await $`dolt --data-dir ${doltPath} checkout main`.quiet();
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('reads structured commit history from dolt_log with branch scoping and limits', async () => {
    const all = await runDoltReadLog({ doltPath, limit: 10 });
    expect(all[0]?.commitHash).toBeString();
    expect(all[0]?.message).toBe('init');

    const feat = await runDoltReadLog({ doltPath, branchName: 'feat', limit: 2 });
    expect(feat).toHaveLength(2);
    expect(feat[0]?.message).toBe('feat');
    expect(feat[0]?.parents.length).toBe(1);
  });

  it('reads structured per-table row diffs between two refs', async () => {
    const diff = await runDoltReadDiff({ doltPath, fromRef: 'main', toRef: 'feat' });
    expect(diff.tables).toEqual([
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
          {
            diffType: 'added',
            oldValues: { id: null, name: null },
            newValues: { id: '2', name: 'c' },
          },
        ],
      },
    ]);
  });
});
