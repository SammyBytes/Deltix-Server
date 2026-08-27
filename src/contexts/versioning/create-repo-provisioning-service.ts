/**
 * Factory that wires the versioning context together from validated env
 * vars. Boot-time composition root — nothing else should construct
 * `LibsqlRepoStore`/`RepoProvisioningService` directly. Mirrors
 * `contexts/storage/create-nas-sync-service.ts`'s pattern.
 */
import type { Env } from '../../shared/env';
import { runDoltInit } from './dolt-cli';
import { LibsqlRepoStore } from './libsql-repo-store';
import { RepoProvisioningService } from './repo-provisioning.service';

export async function createRepoProvisioningService(env: Env): Promise<RepoProvisioningService> {
  const store = new LibsqlRepoStore(env.DELTIX_REPO_DB_PATH);
  await store.init();
  return new RepoProvisioningService(store, runDoltInit, env.DELTIX_DOLT_REPOS_ROOT_PATH);
}
