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
import type { AuthService } from './contexts/auth';
import { createAuthRouter, createAuthService } from './contexts/auth';
import { createLicenseValidator, resolveLicenseAddonsConfig } from './contexts/licensing';
import {
  createNasSyncService,
  createStorageRouter,
  NasSyncWorker,
  startGrpcTransferEngine,
} from './contexts/storage';
import { createTicketService, createTransferRouter } from './contexts/transfer';
import type { RepoProvisioningService } from './contexts/versioning';
import { createVersioningRouter, createVersioningServices } from './contexts/versioning';
import { getBuildInfo } from './shared/build-info';
import { loadEnv } from './shared/env';
import { createLogger } from './shared/logger';
import { applySecurityMiddleware } from './shared/security-middleware';

const logger = createLogger('boot');

/**
 * Break-glass recovery for repos left with zero role assignments (see
 * AuthService.backfillOrphanedRepoAdmin) -- e.g. a repo provisioned before
 * per-repo authorization existed. Only runs when a bootstrap admin is
 * configured, and only touches repos with NO existing role, never a repo
 * that already has an owner (fail-closed access control is otherwise
 * preserved). A single problematic repo must never abort the entire boot
 * sequence, so each repo is backfilled independently.
 */
async function backfillOrphanedRepoAdmins(
  authService: AuthService,
  repoProvisioningService: RepoProvisioningService,
  bootstrapAdminUsername: string,
): Promise<void> {
  const allRepos = await repoProvisioningService.list();
  for (const repo of allRepos) {
    try {
      const rescued = await authService.backfillOrphanedRepoAdmin(
        repo.repoId,
        bootstrapAdminUsername,
      );
      if (rescued) {
        logger.warn(
          { repoId: repo.repoId, username: rescued.username },
          'Orphaned repo (no role assignments) rescued by granting admin to the bootstrap admin',
        );
      }
    } catch (err) {
      logger.error(
        { repoId: repo.repoId, err },
        'Failed to backfill orphaned repo admin, skipping this repo',
      );
    }
  }
}

async function main(): Promise<void> {
  const buildInfo = await getBuildInfo();
  logger.info(buildInfo, 'Deltix-Server starting');

  const validator = createLicenseValidator();
  const result = await validator.validateOnBoot();

  if (!result.valid) {
    logger.fatal({ reason: result.reason }, 'License validation failed, refusing to boot');
    process.exit(1);
  }

  logger.info({ tier: result.license.tier, seats: result.license.seats }, 'License valid, booting');

  const env = loadEnv();
  const authService = await createAuthService(env);
  const ticketService = await createTicketService(env, authService);
  const nasSyncService = await createNasSyncService(env);
  const addonTrustStore = await createAddonTrustStore(env);
  const {
    repoProvisioningService,
    commitService,
    branchService,
    mergeService,
    logService,
    diffService,
    syncPreferenceService,
  } = await createVersioningServices(env);

  if (env.DELTIX_BOOTSTRAP_ADMIN_USERNAME) {
    await backfillOrphanedRepoAdmins(
      authService,
      repoProvisioningService,
      env.DELTIX_BOOTSTRAP_ADMIN_USERNAME,
    );
  }

  const secureCookies = env.NODE_ENV === 'production';
  const authRouter = createAuthRouter(authService, secureCookies);
  const transferRouter = createTransferRouter(authService, ticketService);
  const storageRouter = createStorageRouter(authService, nasSyncService);
  const addonsRouter = createAddonsRouter(authService, addonTrustStore);
  const versioningRouter = createVersioningRouter(
    authService,
    repoProvisioningService,
    syncPreferenceService,
    branchService,
    mergeService,
    logService,
    diffService,
  );
  const app = new Hono();
  applySecurityMiddleware(app, { allowedOrigins: env.DELTIX_CORS_ALLOWED_ORIGINS });
  app.get('/status', async (c) => c.json(await getBuildInfo()));
  app.route('/api/v1/auth', authRouter);
  app.route('/api/v1', transferRouter);
  app.route('/api/v1/storage', storageRouter);
  app.route('/api/v1/addons', addonsRouter);
  app.route('/api/v1/versioning', versioningRouter);

  if (env.DELTIX_ADMIN_UI_ENABLED) {
    app.route('/admin', createAdminUiRouter(authService));
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
  const grpcEngine = await startGrpcTransferEngine(
    env,
    ticketService,
    async ({ repo, username, jobId, checksum }) => {
      const commitHash = await commitService.recordPush({ repo, username, jobId, checksum });
      if (commitHash) {
        logger.info({ repo, username, jobId, commitHash }, 'Recorded real Dolt commit for push');
      }
    },
    async ({ repo, username, stagingPath, syncOptions }) => {
      const parsed = (syncOptions ?? null) as {
        mode?: 'schema_only' | 'schema_and_data';
        tables?: string[] | null;
        dryRun?: boolean;
      } | null;
      const shouldValidateSync = await repoProvisioningService.get(repo);
      if (!shouldValidateSync) {
        return { repo, username, stagingPath, dryRun: parsed?.dryRun ?? false };
      }
      const validation = await syncPreferenceService.validatePushOptions(repo, {
        ...(parsed?.mode !== undefined ? { mode: parsed.mode } : {}),
        ...(parsed?.tables !== undefined ? { tables: parsed.tables } : {}),
        dryRun: parsed?.dryRun ?? false,
      });
      logger.info(
        {
          repo,
          username,
          mode: validation.mode,
          dryRun: validation.dryRun,
          requestedTables: validation.requestedTables,
        },
        'Validated push sync preferences before staging commit',
      );
      return { repo, username, stagingPath, dryRun: validation.dryRun };
    },
  );
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
