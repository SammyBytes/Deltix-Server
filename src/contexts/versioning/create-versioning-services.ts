import type { Env } from '../../shared/env';
import { BranchService } from './branch.service';
import { CommitService } from './commit.service';
import {
  runDoltCheckoutBranch,
  runDoltCreateBranch,
  runDoltCurrentBranch,
  runDoltDeleteBranch,
  runDoltListBranches,
} from './dolt-branch-cli';
import { runDoltInit } from './dolt-cli';
import { runDoltCommit } from './dolt-commit-cli';
import { readForeignKeyEdges } from './dolt-foreign-key-reader';
import { LibsqlRepoStore } from './libsql-repo-store';
import { RepoProvisioningService } from './repo-provisioning.service';
import { SyncPreferenceService } from './sync-preference.service';

export interface VersioningServices {
  repoProvisioningService: RepoProvisioningService;
  commitService: CommitService;
  branchService: BranchService;
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
    branchService: new BranchService(store, {
      runDoltListBranches,
      runDoltCurrentBranch,
      runDoltCreateBranch,
      runDoltCheckoutBranch,
      runDoltDeleteBranch,
    }),
    syncPreferenceService: new SyncPreferenceService(store, readForeignKeyEdges),
  };
}
