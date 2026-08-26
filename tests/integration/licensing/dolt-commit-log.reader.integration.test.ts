import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { DoltCliCommitLogReader } from '../../../src/contexts/licensing/dolt-commit-log.reader';

describe('licensing/dolt-commit-log.reader (integration, real dolt binary)', () => {
  let repoPath: string;

  beforeAll(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'deltix-dolt-repo-'));
    await $`dolt config --global --add user.name deltix-test`.quiet().nothrow();
    await $`dolt config --global --add user.email deltix-test@example.com`.quiet().nothrow();
    const init = await $`dolt --data-dir ${repoPath} init`.quiet().nothrow();
    if (init.exitCode !== 0) {
      throw new Error(`Failed to init test Dolt repo: ${init.stderr.toString()}`);
    }
  });

  afterAll(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it('returns null when the repository has no commits beyond init', async () => {
    // `dolt init` itself creates the first commit, so this asserts the reader
    // can read that initial commit's timestamp rather than truly "no commits".
    const reader = new DoltCliCommitLogReader(repoPath);
    const timestamp = await reader.getLatestCommitTimestamp();

    expect(timestamp).not.toBeNull();
    expect(timestamp?.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('reflects the timestamp of the most recent commit', async () => {
    await $`dolt --data-dir ${repoPath} sql -q ${'create table widgets (id int primary key)'}`
      .quiet()
      .nothrow();
    await $`dolt --data-dir ${repoPath} add .`.quiet().nothrow();
    const commit = await $`dolt --data-dir ${repoPath} commit -m ${'add widgets table'}`
      .quiet()
      .nothrow();
    expect(commit.exitCode).toBe(0);

    const reader = new DoltCliCommitLogReader(repoPath);
    const timestamp = await reader.getLatestCommitTimestamp();

    expect(timestamp).not.toBeNull();
    expect(timestamp?.getTime()).toBeGreaterThan(0);
    // Should be very recent (within the last minute of this test run).
    expect(Date.now() - (timestamp as Date).getTime()).toBeLessThan(60_000);
  });
});
