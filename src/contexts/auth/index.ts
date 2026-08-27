/**
 * Public surface of the "auth" bounded context (ACL boundary).
 *
 * Fase 2 — REST Control Plane & Authentication. Nothing outside this
 * context may import from `contexts/auth/<anything-else>`.
 */

export { authenticateBearerToken, createAuthRouter } from './auth.router';
export { AuthService, type AuthServiceConfig } from './auth.service';
export { createAuthService } from './create-auth-service';
export {
  InvalidCredentialsError,
  SessionExpiredError,
  SessionNotFoundError,
  SetupAlreadyConfiguredError,
  TooManyLoginAttemptsError,
  UserAlreadyExistsError,
  UserHasActiveSessionsError,
  UserInactiveError,
  UserNotFoundError,
} from './errors';
export { LibsqlUserStore } from './libsql-user-store';
export type {
  AccessTokenClaims,
  CreateUserInput,
  LocalUser,
  LoginResult,
  SetupStatus,
  UserSummary,
} from './types';
export type { LegacyUserRecord, UserRecord, UserStore } from './user-store';
