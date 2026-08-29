import type { Env } from '../../shared/env';
import { BranchService } from './branch.service';
import { CommitService } from './commit.service';
import { CommitImportService } from './commit-import.service';
import { DiffService } from './diff.service';
import {
  runDoltCheckoutBranch,
  runDoltCreateBranch,
  runDoltCurrentBranch,
  runDoltDeleteBranch,
  runDoltListBranches,
} from './dolt-branch-cli';
import { runDoltInit } from './dolt-cli';
import { runDoltCommit } from './dolt-commit-cli';
import { runDoltCommitImport } from './dolt-commit-import-cli';
import { runDoltReadDiff } from './dolt-diff-cli';
import { readForeignKeyEdges } from './dolt-foreign-key-reader';
import { runDoltReadLog } from './dolt-log-cli';
import {
  runDoltLatestCommitHash,
  runDoltMerge,
  runDoltMergeAbort,
  runDoltCurrentBranch as runDoltMergeCurrentBranch,
  runDoltReadConflicts,
} from './dolt-merge-cli';
import { LibsqlRepoStore } from './libsql-repo-store';
import { LogService } from './log.service';
import { MergeService } from './merge.service';
import { RepoProvisioningService } from './repo-provisioning.service';
import { SyncPreferenceService } from './sync-preference.service';

export interface VersioningServices {
  repoProvisioningService: RepoProvisioningService;
  commitService: CommitService;
  commitImportService: CommitImportService;
  branchService: BranchService;
  mergeService: MergeService;
  logService: LogService;
  diffService: DiffService;
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
    commitImportService: new CommitImportService(store, runDoltCommitImport),
    branchService: new BranchService(store, {
      runDoltListBranches,
      runDoltCurrentBranch,
      runDoltCreateBranch,
      runDoltCheckoutBranch,
      runDoltDeleteBranch,
    }),
    mergeService: new MergeService(store, {
      runDoltMerge,
      runDoltMergeAbort,
      runDoltReadConflicts,
      runDoltLatestCommitHash,
      runDoltCurrentBranch: runDoltMergeCurrentBranch,
    }),
    logService: new LogService(store, {
      runDoltReadLog,
    }),
    diffService: new DiffService(store, {
      runDoltReadDiff,
    }),
    syncPreferenceService: new SyncPreferenceService(store, readForeignKeyEdges),
  };
}
