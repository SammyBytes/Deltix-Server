/**
 * Unit tests for RepoProvisioningService — mocks the Dolt CLI invocation
 * (injected as a `runDoltInit` function) so this suite never shells out to
 * a real `dolt` binary. Real-binary behavior is covered separately by
 * tests/integration/versioning/*.integration.test.ts.
 */
import { describe, expect, it, mock } from 'bun:test';
import {
  InvalidRepoIdError,
  RepoAlreadyProvisionedError,
  RepoProvisioningFailedError,
} from '../../../src/contexts/versioning/errors';
import { RepoProvisioningService } from '../../../src/contexts/versioning/repo-provisioning.service';
import type { RepoStore } from '../../../src/contexts/versioning/repo-store';
import type { RepoRecord } from '../../../src/contexts/versioning/types';

function createInMemoryRepoStore(): RepoStore {
  const records = new Map<string, RepoRecord>();
  return {
    init: async () => {},
    create: async (record) => {
      records.set(record.repoId, record);
    },
    get: async (repoId) => records.get(repoId) ?? null,
    list: async () => Array.from(records.values()),
  };
}

describe('versioning/RepoProvisioningService', () => {
  it('provisions a new Dolt repo and persists the mapping', async () => {
    const store = createInMemoryRepoStore();
    const runDoltInit = mock(async () => {});
    const service = new RepoProvisioningService(store, runDoltInit, '/data/dolt-repos', () => 1000);

    const record = await service.provision('demo-repo', 'admin');

    expect(record.repoId).toBe('demo-repo');
    expect(record.doltPath).toBe('/data/dolt-repos/demo-repo');
    expect(record.createdBy).toBe('admin');
    expect(record.createdAt).toBe(1000);
    expect(runDoltInit).toHaveBeenCalledTimes(1);
    expect(runDoltInit).toHaveBeenCalledWith('/data/dolt-repos/demo-repo');

    const stored = await store.get('demo-repo');
    expect(stored).toEqual(record);
  });

  it('rejects a repoId that is already provisioned (fail-closed, no silent overwrite)', async () => {
    const store = createInMemoryRepoStore();
    const runDoltInit = mock(async () => {});
    const service = new RepoProvisioningService(store, runDoltInit, '/data/dolt-repos');

    await service.provision('demo-repo', 'admin');

    await expect(service.provision('demo-repo', 'admin')).rejects.toBeInstanceOf(
      RepoAlreadyProvisionedError,
    );
    // Only the first provision() call should have touched the Dolt CLI.
    expect(runDoltInit).toHaveBeenCalledTimes(1);
  });

  it.each(['', '  ', '../escape', 'a/b', 'a\\b', 'a b', 'a'.repeat(65)])(
    'rejects an invalid repoId: %p',
    async (repoId) => {
      const store = createInMemoryRepoStore();
      const runDoltInit = mock(async () => {});
      const service = new RepoProvisioningService(store, runDoltInit, '/data/dolt-repos');

      await expect(service.provision(repoId, 'admin')).rejects.toBeInstanceOf(InvalidRepoIdError);
      expect(runDoltInit).not.toHaveBeenCalled();
    },
  );

  it('accepts repoIds made only of letters, digits, dashes and underscores', async () => {
    const store = createInMemoryRepoStore();
    const runDoltInit = mock(async () => {});
    const service = new RepoProvisioningService(store, runDoltInit, '/data/dolt-repos');

    await expect(service.provision('Repo_123-test', 'admin')).resolves.toBeTruthy();
  });

  it('wraps a Dolt CLI failure in RepoProvisioningFailedError and never persists a half-created record', async () => {
    const store = createInMemoryRepoStore();
    const runDoltInit = mock(async () => {
      throw new Error('dolt: command not found');
    });
    const service = new RepoProvisioningService(store, runDoltInit, '/data/dolt-repos');

    await expect(service.provision('demo-repo', 'admin')).rejects.toBeInstanceOf(
      RepoProvisioningFailedError,
    );
    expect(await store.get('demo-repo')).toBeNull();
  });

  it('lists every provisioned repo', async () => {
    const store = createInMemoryRepoStore();
    const runDoltInit = mock(async () => {});
    const service = new RepoProvisioningService(store, runDoltInit, '/data/dolt-repos');

    await service.provision('repo-a', 'admin');
    await service.provision('repo-b', 'admin');

    const list = await service.list();
    expect(list.map((r) => r.repoId).sort()).toEqual(['repo-a', 'repo-b']);
  });

  it('gets a single provisioned repo by id', async () => {
    const store = createInMemoryRepoStore();
    const runDoltInit = mock(async () => {});
    const service = new RepoProvisioningService(store, runDoltInit, '/data/dolt-repos');

    await service.provision('repo-a', 'admin');
    const found = await service.get('repo-a');
    expect(found?.repoId).toBe('repo-a');

    const notFound = await service.get('does-not-exist');
    expect(notFound).toBeNull();
  });
});
