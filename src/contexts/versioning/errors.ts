/**
 * Domain error types for the versioning context, mirroring the pattern
 * already established in `contexts/addons/errors.ts` and
 * `contexts/licensing/errors.ts`.
 */
export class RepoAlreadyProvisionedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoAlreadyProvisionedError';
  }
}

export class RepoNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoNotFoundError';
  }
}

export class RepoProvisioningFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoProvisioningFailedError';
  }
}

export class InvalidRepoIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRepoIdError';
  }
}

export class CommitFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitFailedError';
  }
}

export class SyncPreferenceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncPreferenceConflictError';
  }
}

export class InvalidBranchNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBranchNameError';
  }
}

export class BranchAlreadyExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BranchAlreadyExistsError';
  }
}

export class BranchNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BranchNotFoundError';
  }
}

export class ProtectedBranchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtectedBranchError';
  }
}
