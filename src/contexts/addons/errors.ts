/**
 * Domain error types for the addons context. Each represents a distinct
 * fail-closed reason an addon was refused loading, mirroring the pattern
 * already established in `contexts/licensing/errors.ts`.
 */
export class AddonManifestInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddonManifestInvalidError';
  }
}

export class AddonCapabilityDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddonCapabilityDeniedError';
  }
}

export class AddonSignatureInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddonSignatureInvalidError';
  }
}

export class AddonNotTrustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddonNotTrustedError';
  }
}

export class AddonLicenseDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddonLicenseDeniedError';
  }
}

export class AddonLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddonLimitExceededError';
  }
}
