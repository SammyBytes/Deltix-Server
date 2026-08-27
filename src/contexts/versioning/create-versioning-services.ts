import type { Env } from '../../shared/env';
import { CommitService } from './commit.service';
import { runDoltInit } from './dolt-cli';
import { runDoltCommit } from './dolt-commit-cli';
import { readForeignKeyEdges } from './dolt-foreign-key-reader';
import { LibsqlRepoStore } from './libsql-repo-store';
import { RepoProvisioningService } from './repo-provisioning.service';
import { SyncPreferenceService } from './sync-preference.service';

export interface VersioningServices {
  repoProvisioningService: RepoProvisioningService;
  commitService: CommitService;
  syncPreferenceService: SyncPreferenceService;
}

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
    syncPreferenceService: new SyncPreferenceService(store, readForeignKeyEdges),
  };
}
