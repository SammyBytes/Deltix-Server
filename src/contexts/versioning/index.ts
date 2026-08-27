/**
 * Public API of the "versioning" bounded context (Fase 5.1: real Dolt repo
 * provisioning per logical repoId). This is the ONLY module other
 * contexts/modules are allowed to import from — see
 * .github/copilot-instructions.md for the ACL boundary rule.
 */

export type { PushCommitParams, RunDoltCommit } from './commit.service';
export { CommitService } from './commit.service';
export type { VersioningServices } from './create-versioning-services';
export { createVersioningServices } from './create-versioning-services';
export { runDoltInit } from './dolt-cli';
export { runDoltCommit } from './dolt-commit-cli';
export {
  CommitFailedError,
  InvalidRepoIdError,
  RepoAlreadyProvisionedError,
  RepoNotFoundError,
  RepoProvisioningFailedError,
} from './errors';
export { LibsqlRepoStore } from './libsql-repo-store';
export type { RunDoltInit } from './repo-provisioning.service';
export { RepoProvisioningService } from './repo-provisioning.service';
export type { RepoStore } from './repo-store';
export type { RepoRecord } from './types';
export { createVersioningRouter } from './versioning.router';
