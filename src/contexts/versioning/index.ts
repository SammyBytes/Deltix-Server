/**
 * Public API of the "versioning" bounded context (Fase 5.1: real Dolt repo
 * provisioning per logical repoId). This is the ONLY module other
 * contexts/modules are allowed to import from — see
 * .github/copilot-instructions.md for the ACL boundary rule.
 */
export { createRepoProvisioningService } from './create-repo-provisioning-service';
export { runDoltInit } from './dolt-cli';
export {
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
