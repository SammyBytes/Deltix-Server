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

export class InvalidCommitReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCommitReferenceError';
  }
}

export class InvalidPaginationLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPaginationLimitError';
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

export class MergeConflictError extends Error {
  constructor(
    message: string,
    public readonly conflicts: Array<{
      table: string;
      count: number;
      conflicts: Array<{
        fromRootIsh: string | null;
        base: Record<string, string | null>;
        ours: Record<string, string | null>;
        theirs: Record<string, string | null>;
        ourDiffType: string | null;
        theirDiffType: string | null;
        conflictId: string | null;
      }>;
    }>,
    public readonly branches: { sourceBranch: string; targetBranch: string },
  ) {
    super(message);
    this.name = 'MergeConflictError';
  }

  get sourceBranch(): string {
    return this.branches.sourceBranch;
  }

  get targetBranch(): string {
    return this.branches.targetBranch;
  }
}
