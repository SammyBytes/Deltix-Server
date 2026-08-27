/**
 * Integration test: exercises `CommitService` against the REAL `dolt` CLI
 * binary (via `runDoltCommit`), on a real repo provisioned by
 * `RepoProvisioningService` (Fase 5.1). Confirms Fase 5.2's core promise:
 * a push produces a real, queryable, tamper-evident Dolt commit — not
 * just a plain file copy.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { CommitService } from '../../../src/contexts/versioning/commit.service';
import { runDoltInit } from '../../../src/contexts/versioning/dolt-cli';
import { runDoltCommit } from '../../../src/contexts/versioning/dolt-commit-cli';
import { LibsqlRepoStore } from '../../../src/contexts/versioning/libsql-repo-store';
import { RepoProvisioningService } from '../../../src/contexts/versioning/repo-provisioning.service';

describe('versioning/CommitService (integration, real dolt binary)', () => {
  let workDir: string;
  let store: LibsqlRepoStore;
  let provisioningService: RepoProvisioningService;
  let commitService: CommitService;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deltix-commit-integration-'));
    store = new LibsqlRepoStore(join(workDir, 'repos.db'));
    await store.init();
    provisioningService = new RepoProvisioningService(
      store,
      runDoltInit,
      join(workDir, 'dolt-repos'),
    );
    commitService = new CommitService(store, runDoltCommit);
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('creates a real, additional Dolt commit for a provisioned repo, authored by the pusher', async () => {
    const record = await provisioningService.provision('commit-repo', 'admin');

    const before = await $`dolt --data-dir ${record.doltPath} log --oneline`.quiet();
    const commitsBefore = before.stdout.toString().trim().split('\n').length;

    const hash = await commitService.recordPush({
      repo: 'commit-repo',
      username: 'alice',
      jobId: '11111111-1111-4111-8111-111111111111',
      checksum: 'a'.repeat(64),
    });

    expect(hash).not.toBeNull();

    const after = await $`dolt --data-dir ${record.doltPath} log --oneline`.quiet();
    const commitsAfter = after.stdout.toString().trim().split('\n').length;
    expect(commitsAfter).toBe(commitsBefore + 1);

    const authorLog = await $`dolt --data-dir ${record.doltPath} log -n 1`.quiet();
    expect(authorLog.stdout.toString()).toContain('alice');

    const rows =
      await $`dolt --data-dir ${record.doltPath} sql -q ${'SELECT job_id, author, checksum FROM deltix_push_log'} -r csv`.quiet();
    expect(rows.stdout.toString()).toContain('11111111-1111-4111-8111-111111111111');
    expect(rows.stdout.toString()).toContain('alice');
  });

  it('returns null and creates no commit for a repo with no provisioned Dolt backend', async () => {
    const result = await commitService.recordPush({
      repo: 'never-provisioned-repo',
      username: 'alice',
      jobId: '22222222-2222-4222-8222-222222222222',
      checksum: 'b'.repeat(64),
    });
    expect(result).toBeNull();
  });

  it('a second push to the same repo produces a second independent commit', async () => {
    const record = await provisioningService.provision('multi-push-repo', 'admin');
    const before = await $`dolt --data-dir ${record.doltPath} log --oneline`.quiet();
    const commitsBefore = before.stdout.toString().trim().split('\n').length;

    await commitService.recordPush({
      repo: 'multi-push-repo',
      username: 'alice',
      jobId: '33333333-3333-4333-8333-333333333333',
      checksum: 'c'.repeat(64),
    });
    await commitService.recordPush({
      repo: 'multi-push-repo',
      username: 'bob',
      jobId: '44444444-4444-4444-8444-444444444444',
      checksum: 'd'.repeat(64),
    });

    const after = await $`dolt --data-dir ${record.doltPath} log --oneline`.quiet();
    const commitsAfter = after.stdout.toString().trim().split('\n').length;
    expect(commitsAfter).toBe(commitsBefore + 2);

    const rows =
      await $`dolt --data-dir ${record.doltPath} sql -q ${'SELECT job_id FROM deltix_push_log'} -r csv`.quiet();
    expect(rows.stdout.toString()).toContain('33333333-3333-4333-8333-333333333333');
    expect(rows.stdout.toString()).toContain('44444444-4444-4444-8444-444444444444');
  });
});
