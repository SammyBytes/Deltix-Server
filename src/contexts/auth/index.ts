/**
 * Public surface of the "auth" bounded context (ACL boundary).
 *
 * Fase 2 — REST Control Plane & Authentication. Nothing outside this
 * context may import from `contexts/auth/<anything-else>`.
 */

export { createAuthRouter } from './auth.router';
export { AuthService, type AuthServiceConfig } from './auth.service';
export { createAuthService } from './create-auth-service';
export {
  InvalidCredentialsError,
  SessionExpiredError,
  SessionNotFoundError,
  TooManyLoginAttemptsError,
} from './errors';
export type { AccessTokenClaims, LocalUser, LoginResult } from './types';
