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
import {
  AddonCircuitBreaker,
  createAddonsRouter,
  createAddonTrustStore,
  discoverAndLoadAddons,
} from './contexts/addons';
import { createAdminUiRouter } from './contexts/admin-ui';
import { createAuthRouter, createAuthService } from './contexts/auth';
import { createLicenseValidator, resolveLicenseAddonsConfig } from './contexts/licensing';
import {
  createNasSyncService,
  createStorageRouter,
  NasSyncWorker,
  startGrpcTransferEngine,
} from './contexts/storage';
import { createTicketService, createTransferRouter } from './contexts/transfer';
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
  const ticketService = await createTicketService(env);
  const nasSyncService = await createNasSyncService(env);
  const addonTrustStore = await createAddonTrustStore(env);
  const secureCookies = env.NODE_ENV === 'production';
  const authRouter = createAuthRouter(authService, secureCookies);
  const transferRouter = createTransferRouter(authService, ticketService);
  const storageRouter = createStorageRouter(authService, nasSyncService);
  const addonsRouter = createAddonsRouter(authService, addonTrustStore);
  const app = new Hono();
  applySecurityMiddleware(app, { allowedOrigins: env.DELTIX_CORS_ALLOWED_ORIGINS });
  app.route('/api/v1/auth', authRouter);
  app.route('/api/v1', transferRouter);
  app.route('/api/v1/storage', storageRouter);
  app.route('/api/v1/addons', addonsRouter);

  if (env.DELTIX_ADMIN_UI_ENABLED) {
    app.route('/admin', createAdminUiRouter());
    logger.info('Admin Web UI enabled at /admin');
  }

  const httpPort = Number(Bun.env.HTTP_PORT ?? 9090);
  Bun.serve({ port: httpPort, fetch: app.fetch });
  logger.info({ port: httpPort }, 'HTTP control plane listening');

  const nasSyncWorker = new NasSyncWorker(
    nasSyncService,
    env.DELTIX_NAS_SYNC_POLL_INTERVAL_MS,
    (err) => {
      logger.error({ err }, 'NAS sync worker tick failed');
    },
  );
  nasSyncWorker.start();
  logger.info(
    { intervalMs: env.DELTIX_NAS_SYNC_POLL_INTERVAL_MS },
    'NAS sync worker started (SSD staging -> NAS pipeline)',
  );

  // gRPC Transfer Engine (Fase 3 continued): Push/Pull/Heartbeat wire
  // protocol. Shares the same TransferJob store (libSQL file) as the NAS
  // sync worker above — Push writes 'staged' rows, the worker picks them
  // up and promotes them to the NAS pipeline.
  const grpcEngine = await startGrpcTransferEngine(env, ticketService);
  logger.info(
    { port: grpcEngine.port },
    'gRPC transfer engine listening (TLS, Push/Pull/Heartbeat)',
  );

  // Add-on loading (Fase 4): fail-closed pipeline — manifest -> closed
  // capability list -> signature (official: Deltix key, community: TOFU) ->
  // license enforcement -> import(). One bad addon never aborts the others
  // or the control plane boot; see docs/decisions/0001-*.md.
  const addonsConfig = resolveLicenseAddonsConfig(result.license);
  const addonCircuitBreaker = new AddonCircuitBreaker({
    maxConsecutiveFailures: env.DELTIX_ADDON_MAX_CONSECUTIVE_FAILURES,
    onDisabled: (addonName) => {
      logger.error({ addonName }, 'Addon disabled after repeated runtime failures (until restart)');
    },
  });
  const { loaded: loadedAddons, failures: addonFailures } = await discoverAndLoadAddons(
    env.DELTIX_ADDON_PATHS,
    {
      officialPublicKey: env.DELTIX_LICENSE_PUBLIC_KEY,
      trustStore: addonTrustStore,
      addonsConfig,
      freeOfficialAddons: env.DELTIX_ADDON_FREE_OFFICIAL.split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
      buildContext: (addonName, grantedCapabilities) => ({ addonName, grantedCapabilities }),
    },
  );
  for (const failure of addonFailures) {
    logger.error(
      { addonDir: failure.addonDir, err: failure.error },
      'Addon failed to load, skipping (control plane boot continues)',
    );
  }
  for (const addon of loadedAddons) {
    const grantedHttpRoute = addon.manifest.capabilities.includes('http:route');
    if (grantedHttpRoute && typeof addon.module.activate === 'function') {
      await addon.module.activate({
        addonName: addon.manifest.name,
        grantedCapabilities: addon.manifest.capabilities,
        http: {
          register: (path, handler) => {
            app.all(path, async (c) =>
              addonCircuitBreaker.wrap(addon.manifest.name, handler)(c.req.raw),
            );
          },
        },
      });
    }
  }
  logger.info(
    { loaded: loadedAddons.length, failed: addonFailures.length },
    'Add-on loading complete',
  );
}

if (import.meta.main) {
  main().catch((error) => {
    logger.fatal({ err: error }, 'Unhandled error during boot');
    process.exit(1);
  });
}
