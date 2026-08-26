/**
 * Auth-specific error types. Kept distinct from `contexts/licensing/errors.ts`
 * — the two contexts must never import each other's internals (ACL rule).
 */

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid username or password');
    this.name = 'InvalidCredentialsError';
  }
}

export class TooManyLoginAttemptsError extends Error {
  constructor(retryAfterMs: number) {
    super(`Too many login attempts, retry after ${retryAfterMs}ms`);
    this.name = 'TooManyLoginAttemptsError';
  }
}

export class SessionNotFoundError extends Error {
  constructor() {
    super('Session not found or already revoked');
    this.name = 'SessionNotFoundError';
  }
}

export class SessionExpiredError extends Error {
  constructor() {
    super('Session has expired due to inactivity');
    this.name = 'SessionExpiredError';
  }
}
