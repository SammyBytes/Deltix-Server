/**
 * Public API of the "versioning" bounded context (Fase 5.1: real Dolt repo
 * provisioning per logical repoId). This is the ONLY module other
 * contexts/modules are allowed to import from — see
 * .github/copilot-instructions.md for the ACL boundary rule.
 */

export { BranchService } from './branch.service';
export type { PushCommitParams, RunDoltCommit } from './commit.service';
export { CommitService } from './commit.service';
export type { VersioningServices } from './create-versioning-services';
export { createVersioningServices } from './create-versioning-services';
export { DiffService } from './diff.service';
export {
  runDoltCheckoutBranch,
  runDoltCreateBranch,
  runDoltCurrentBranch,
  runDoltDeleteBranch,
  runDoltListBranches,
} from './dolt-branch-cli';
export { runDoltInit } from './dolt-cli';
export { runDoltCommit } from './dolt-commit-cli';
export { runDoltReadDiff } from './dolt-diff-cli';
export { assertSafeTableName, readForeignKeyEdges } from './dolt-foreign-key-reader';
export { runDoltReadLog } from './dolt-log-cli';
export {
  runDoltCheckoutBranch as runDoltMergeCheckoutBranch,
  runDoltCurrentBranch as runDoltMergeCurrentBranch,
  runDoltLatestCommitHash,
  runDoltMerge,
  runDoltMergeAbort,
  runDoltReadConflicts,
} from './dolt-merge-cli';
export {
  BranchAlreadyExistsError,
  BranchNotFoundError,
  CommitFailedError,
  InvalidBranchNameError,
  InvalidCommitReferenceError,
  InvalidPaginationLimitError,
  InvalidRepoIdError,
  MergeConflictError,
  ProtectedBranchError,
  RepoAlreadyProvisionedError,
  RepoNotFoundError,
  RepoProvisioningFailedError,
  SyncPreferenceConflictError,
} from './errors';
export { LibsqlRepoStore } from './libsql-repo-store';
export { LogService } from './log.service';
export { MergeService } from './merge.service';
export { RepoBranchMutex, sharedRepoBranchMutex } from './repo-branch-mutex';
export type { RunDoltInit } from './repo-provisioning.service';
export { RepoProvisioningService } from './repo-provisioning.service';
export type { RepoStore } from './repo-store';
export { SyncPreferenceService } from './sync-preference.service';
export type {
  ForeignKeyEdge,
  PushSyncOptions,
  PushSyncValidationResult,
  RepoSyncPreferenceRecord,
  SyncMode,
  SyncPlan,
  SyncPlanRequest,
} from './sync-preference-types';
export type {
  BranchSummary,
  DiffResult,
  DiffRowChange,
  DiffTableSummary,
  LogCommitEntry,
  MergeConflictRow,
  MergeConflictTable,
  MergeResult,
  RepoRecord,
  RepoSyncPreferenceSummary,
} from './types';
export { createVersioningRouter } from './versioning.router';
