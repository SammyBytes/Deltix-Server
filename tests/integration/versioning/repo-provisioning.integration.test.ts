/**
 * Integration test: exercises RepoProvisioningService against the REAL
 * `dolt` CLI binary (via `runDoltInit`) and a real temporary libSQL file
 * for the repo store — no mocking of Dolt itself. Confirms Fase 5.1's
 * core promise: after provisioning, a real, independent Dolt repository
 * exists on disk (verifiable with `dolt --data-dir <path> log`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { runDoltInit } from '../../../src/contexts/versioning/dolt-cli';
import { RepoAlreadyProvisionedError } from '../../../src/contexts/versioning/errors';
import { LibsqlRepoStore } from '../../../src/contexts/versioning/libsql-repo-store';
import { RepoProvisioningService } from '../../../src/contexts/versioning/repo-provisioning.service';

describe('versioning/RepoProvisioningService (integration, real dolt binary)', () => {
  let workDir: string;
  let store: LibsqlRepoStore;
  let service: RepoProvisioningService;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deltix-versioning-integration-'));
    store = new LibsqlRepoStore(join(workDir, 'repos.db'));
    await store.init();
    service = new RepoProvisioningService(store, runDoltInit, join(workDir, 'dolt-repos'));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('provisions a real, isolated Dolt repository on disk', async () => {
    const record = await service.provision('integration-repo', 'admin');

    // Confirm a real Dolt repo exists at doltPath by querying its commit
    // graph directly with the CLI — same technique already used by
    // contexts/licensing/dolt-commit-log.reader.ts.
    const result = await $`dolt --data-dir ${record.doltPath} log`.quiet();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('Initialize data repository');

    const branches = await $`dolt --data-dir ${record.doltPath} branch`.quiet();
    expect(branches.stdout.toString()).toContain('main');
  });

  it('persists the record so a second lookup returns the same Dolt path', async () => {
    await service.provision('lookup-repo', 'admin');
    const found = await service.get('lookup-repo');
    expect(found?.doltPath).toBe(join(workDir, 'dolt-repos', 'lookup-repo'));
  });

  it('refuses to re-provision an already-provisioned repoId', async () => {
    await service.provision('dup-repo', 'admin');
    await expect(service.provision('dup-repo', 'admin')).rejects.toBeInstanceOf(
      RepoAlreadyProvisionedError,
    );
  });

  it('two provisioned repos are fully independent Dolt repositories', async () => {
    const a = await service.provision('independent-a', 'admin');
    const b = await service.provision('independent-b', 'admin');

    await $`dolt --data-dir ${a.doltPath} sql -q "CREATE TABLE only_in_a (id INT PRIMARY KEY)"`.quiet();
    await $`dolt --data-dir ${a.doltPath} sql -q "CALL DOLT_COMMIT('-Am', 'add only_in_a')"`.quiet();

    const tablesInB = await $`dolt --data-dir ${b.doltPath} sql -q "show tables" -r csv`.quiet();
    expect(tablesInB.stdout.toString()).not.toContain('only_in_a');

    const tablesInA = await $`dolt --data-dir ${a.doltPath} sql -q "show tables" -r csv`.quiet();
    expect(tablesInA.stdout.toString()).toContain('only_in_a');
  });
});
