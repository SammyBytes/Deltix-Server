/**
 * Deltix-Server entrypoint.
 *
 * Fase 1 scope: validate the license (signature + expiry + anti-tamper,
 * backed by Dolt's own immutable commit graph) before doing anything else.
 * If validation fails, the process exits non-zero — fail-closed, no silent
 * degradation, no retry loop. HTTP/gRPC bootstrap lands in later phases.
 */
import { createLicenseValidator } from './contexts/licensing';
import { createLogger } from './shared/logger';

const logger = createLogger('boot');

async function main(): Promise<void> {
  const validator = createLicenseValidator();
  const result = await validator.validateOnBoot();

  if (!result.valid) {
    logger.fatal({ reason: result.reason }, 'License validation failed, refusing to boot');
    process.exit(1);
  }

  logger.info({ tier: result.license.tier, seats: result.license.seats }, 'License valid, booting');
  // HTTP/gRPC bootstrap lands in Fase 2/3.
}

if (import.meta.main) {
  main().catch((error) => {
    logger.fatal({ err: error }, 'Unhandled error during boot');
    process.exit(1);
  });
}
