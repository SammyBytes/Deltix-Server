/**
 * Factory that wires the auth context together from validated env vars.
 * This is the boot-time composition root for this context — nothing else
 * should construct `AuthService`/`LibsqlSessionStore` directly.
 */
import type { Env } from '../../shared/env';
import { AuthService } from './auth.service';
import { LibsqlSessionStore } from './libsql-session-store';

const DEFAULT_MAX_LOGIN_ATTEMPTS = 5;
const DEFAULT_LOGIN_ATTEMPT_WINDOW_MS = 60_000;

export async function createAuthService(env: Env): Promise<AuthService> {
  const store = new LibsqlSessionStore(env.DELTIX_SESSION_DB_PATH);
  await store.init();

  return new AuthService(
    {
      users: env.DELTIX_LOCAL_USERS,
      jwtPrivateKeyPem: env.DELTIX_JWT_PRIVATE_KEY,
      jwtPublicKeyPem: env.DELTIX_JWT_PUBLIC_KEY,
      accessTokenTtlSeconds: env.DELTIX_ACCESS_TOKEN_TTL_SECONDS,
      sessionTtlSeconds: env.DELTIX_SESSION_TTL_SECONDS,
      maxLoginAttempts: DEFAULT_MAX_LOGIN_ATTEMPTS,
      loginAttemptWindowMs: DEFAULT_LOGIN_ATTEMPT_WINDOW_MS,
    },
    store,
  );
}
