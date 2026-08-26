/**
 * Deltix-Server entrypoint.
 *
 * Boot sequence: validate the license (signature + expiry + anti-tamper,
 * backed by Dolt's own immutable commit graph) before doing anything else.
 * If validation fails, the process exits non-zero — fail-closed, no silent
 * degradation, no retry loop. Only once the license is valid does the HTTP
 * control plane (Fase 2: auth) start listening.
 */

import { Hono } from 'hono';
import { createAdminUiRouter } from './contexts/admin-ui';
import { createAuthRouter, createAuthService } from './contexts/auth';
import { createLicenseValidator } from './contexts/licensing';
import { loadEnv } from './shared/env';
import { createLogger } from './shared/logger';
import { applySecurityMiddleware } from './shared/security-middleware';

const logger = createLogger('boot');

async function main(): Promise<void> {
  const validator = createLicenseValidator();
  const result = await validator.validateOnBoot();

  if (!result.valid) {
    logger.fatal({ reason: result.reason }, 'License validation failed, refusing to boot');
    process.exit(1);
  }

  logger.info({ tier: result.license.tier, seats: result.license.seats }, 'License valid, booting');

  const env = loadEnv();
  const authService = await createAuthService(env);
  const secureCookies = env.NODE_ENV === 'production';
  const authRouter = createAuthRouter(authService, secureCookies);
  const app = new Hono();
  applySecurityMiddleware(app, { allowedOrigins: env.DELTIX_CORS_ALLOWED_ORIGINS });
  app.route('/api/v1/auth', authRouter);

  if (env.DELTIX_ADMIN_UI_ENABLED) {
    app.route('/admin', createAdminUiRouter());
    logger.info('Admin Web UI enabled at /admin');
  }

  const httpPort = Number(Bun.env.HTTP_PORT ?? 9090);
  Bun.serve({ port: httpPort, fetch: app.fetch });
  logger.info({ port: httpPort }, 'HTTP control plane listening');
  // gRPC transfer engine (Fase 3) and Add-on loading (Fase 4) land later.
}

if (import.meta.main) {
  main().catch((error) => {
    logger.fatal({ err: error }, 'Unhandled error during boot');
    process.exit(1);
  });
}
