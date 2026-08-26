/**
 * Domain error types for the licensing context. Each represents a distinct
 * fail-closed condition the license validator can hit.
 */
export class LicenseMalformedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LicenseMalformedError';
  }
}

export class LicenseSignatureInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LicenseSignatureInvalidError';
  }
}

export class LicenseExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LicenseExpiredError';
  }
}

export class ClockRollbackDetectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClockRollbackDetectedError';
  }
}
