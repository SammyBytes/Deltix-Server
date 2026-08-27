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
