/**
 * Deltix-Server entrypoint (scaffolding).
 *
 * This is intentionally a placeholder on `main`. The `phase-1-crypto-licensing`
 * branch wires up real license validation (signature + expiry + anti-tamper)
 * as the first thing that runs before anything else — fail-closed, no silent
 * degradation. HTTP/gRPC bootstrap lands in later phases.
 */
import { createLogger } from './shared/logger';

const logger = createLogger('boot');

if (import.meta.main) {
  logger.info('Deltix-Server scaffold — see roadmap phases for feature implementation');
}
