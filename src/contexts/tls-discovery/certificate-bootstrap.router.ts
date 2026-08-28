import { Hono } from 'hono';
import { createLogger } from '../../shared/logger';
import { BootstrapRateLimiter } from './bootstrap-rate-limiter';
import type { CertificateBootstrapService } from './certificate-bootstrap.service';

const logger = createLogger('http:bootstrap');

const MAX_REQUESTS_PER_WINDOW = 20;
const WINDOW_MS = 60_000;

/**
 * Best-effort source-address extraction for rate-limiting purposes only —
 * never used for access-control decisions. Falls back to a shared bucket
 * when no address is available (e.g. behind a proxy that strips
 * `X-Forwarded-For`), which degrades to a single global limit rather than
 * an unlimited one.
 */
function sourceKey(c: { req: { header: (name: string) => string | undefined } }): string {
  const forwardedFor = c.req.header('x-forwarded-for');
  if (forwardedFor) return forwardedFor.split(',')[0]?.trim() ?? 'unknown';
  return 'unknown';
}

export function createCertificateBootstrapRouter(service: CertificateBootstrapService): Hono {
  const app = new Hono();
  const limiter = new BootstrapRateLimiter(MAX_REQUESTS_PER_WINDOW, WINDOW_MS);

  app.get('/certificate', (c) => {
    const key = sourceKey(c);
    if (!limiter.isAllowed(key)) {
      logger.warn(
        { event: 'bootstrap_rate_limited' },
        'Certificate bootstrap request rate-limited',
      );
      return c.json({ error: 'Too many requests' }, 429);
    }
    limiter.recordAttempt(key);

    const certificates = service.getCertificates();
    logger.info({ event: 'bootstrap_certificate_served' }, 'Certificate bootstrap request served');

    return c.json({
      http: certificates.http
        ? { pem: certificates.http.pem, sha256Fingerprint: certificates.http.sha256Fingerprint }
        : null,
      grpc: { pem: certificates.grpc.pem, sha256Fingerprint: certificates.grpc.sha256Fingerprint },
      warning:
        'This certificate was served over an unauthenticated endpoint for bootstrap convenience. ' +
        'Always verify the sha256Fingerprint out-of-band (e.g. compare against the value the server ' +
        'administrator generated) before trusting it — this is a Trust-On-First-Use mechanism, not proof of identity.',
    });
  });

  return app;
}
