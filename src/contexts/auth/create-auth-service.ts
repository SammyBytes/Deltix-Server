import type { Env } from '../../shared/env';
import { createLogger } from '../../shared/logger';
import { AuthService } from './auth.service';
import { LibsqlSessionStore } from './libsql-session-store';
import { LibsqlUserStore } from './libsql-user-store';

const DEFAULT_MAX_LOGIN_ATTEMPTS = 5;
const DEFAULT_LOGIN_ATTEMPT_WINDOW_MS = 60_000;
const logger = createLogger('auth');

export async function createAuthService(env: Env): Promise<AuthService> {
  const sessionStore = new LibsqlSessionStore(env.DELTIX_SESSION_DB_PATH);
  await sessionStore.init();

  const userStore = new LibsqlUserStore(env.DELTIX_USER_DB_PATH, env.DELTIX_LOCAL_USERS ?? []);
  await userStore.init();

  const authService = new AuthService(
    {
      jwtPrivateKeyPem: env.DELTIX_JWT_PRIVATE_KEY,
      jwtPublicKeyPem: env.DELTIX_JWT_PUBLIC_KEY,
      accessTokenTtlSeconds: env.DELTIX_ACCESS_TOKEN_TTL_SECONDS,
      sessionTtlSeconds: env.DELTIX_SESSION_TTL_SECONDS,
      maxLoginAttempts: DEFAULT_MAX_LOGIN_ATTEMPTS,
      loginAttemptWindowMs: DEFAULT_LOGIN_ATTEMPT_WINDOW_MS,
      bootstrapAdminConfigured:
        Boolean(env.DELTIX_BOOTSTRAP_ADMIN_USERNAME) ||
        Boolean(env.DELTIX_BOOTSTRAP_ADMIN_PASSWORD),
    },
    userStore,
    sessionStore,
  );

  if (env.DELTIX_LOCAL_USERS && env.DELTIX_LOCAL_USERS.length > 0) {
    logger.warn(
      'DELTIX_LOCAL_USERS is deprecated and treated as a read-only legacy fallback; use the libSQL user store going forward',
    );
  }

  if (env.DELTIX_BOOTSTRAP_ADMIN_USERNAME && env.DELTIX_BOOTSTRAP_ADMIN_PASSWORD) {
    await authService.ensureBootstrapAdmin({
      username: env.DELTIX_BOOTSTRAP_ADMIN_USERNAME,
      password: env.DELTIX_BOOTSTRAP_ADMIN_PASSWORD,
    });
  }

  return authService;
}
