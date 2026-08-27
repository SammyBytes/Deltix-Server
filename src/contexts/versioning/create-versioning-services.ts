/**
 * Factory that wires the versioning context together from validated env
 * vars. Boot-time composition root — nothing else should construct
 * `LibsqlRepoStore`/`RepoProvisioningService`/`CommitService` directly.
 * Mirrors `contexts/storage/create-nas-sync-service.ts`'s pattern.
 */
import type { Env } from '../../shared/env';
import { CommitService } from './commit.service';
import { runDoltInit } from './dolt-cli';
import { runDoltCommit } from './dolt-commit-cli';
import { LibsqlRepoStore } from './libsql-repo-store';
import { RepoProvisioningService } from './repo-provisioning.service';

export interface VersioningServices {
  repoProvisioningService: RepoProvisioningService;
  commitService: CommitService;
}

/**
 * Builds both services from a single shared `LibsqlRepoStore` instance —
 * they must agree on the same repoId <-> doltPath mapping, so there is
 * exactly one store per process, never two independent connections that
 * could drift apart.
 */
export async function createVersioningServices(env: Env): Promise<VersioningServices> {
  const store = new LibsqlRepoStore(env.DELTIX_REPO_DB_PATH);
  await store.init();
  return {
    repoProvisioningService: new RepoProvisioningService(
      store,
      runDoltInit,
      env.DELTIX_DOLT_REPOS_ROOT_PATH,
    ),
    commitService: new CommitService(store, runDoltCommit),
  };
}
