/**
 * Baseline HTTP security hardening applied to every route on the REST
 * control plane: a strict, fail-closed CORS policy (exact origin allow-list,
 * never a wildcard reflection) plus a small set of defensive response
 * headers. Kept intentionally minimal — this is not a full CSP/helmet
 * clone, just the headers relevant to a JSON API with no HTML rendering.
 */
import type { Hono } from 'hono';
import { cors } from 'hono/cors';

export interface SecurityMiddlewareOptions {
  /** Exact origins allowed to make cross-origin requests. Empty = none allowed. */
  allowedOrigins: string[];
}

export function applySecurityMiddleware(app: Hono, options: SecurityMiddlewareOptions): void {
  app.use(
    '*',
    cors({
      // Never fall back to "*": only echo back an origin that is explicitly
      // allow-listed. Hono's cors() only sets the header when this callback
      // returns a matching string, so an unmatched origin fails closed.
      origin: (origin) => options.allowedOrigins.find((allowed) => allowed === origin),
      allowMethods: ['GET', 'POST'],
      credentials: false,
    }),
  );

  app.use('*', async (c, next) => {
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('x-frame-options', 'DENY');
    c.header('referrer-policy', 'no-referrer');
  });
}
