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

export class UserInactiveError extends Error {
  constructor(username: string) {
    super(`User ${username} is deactivated`);
    this.name = 'UserInactiveError';
  }
}

export class UserAlreadyExistsError extends Error {
  constructor(username: string) {
    super(`User ${username} already exists`);
    this.name = 'UserAlreadyExistsError';
  }
}

export class UserNotFoundError extends Error {
  constructor(username: string) {
    super(`User ${username} was not found`);
    this.name = 'UserNotFoundError';
  }
}

export class UserHasActiveSessionsError extends Error {
  constructor(username: string) {
    super(`User ${username} still has active sessions`);
    this.name = 'UserHasActiveSessionsError';
  }
}

export class SetupAlreadyConfiguredError extends Error {
  constructor(message = 'Initial admin setup is no longer available') {
    super(message);
    this.name = 'SetupAlreadyConfiguredError';
  }
}
