/**
 * HonoJS router for the Admin Web UI: serves a single static login/status
 * page. No server-side rendering, no templating engine — plain static HTML
 * read from disk once at module load. All auth calls happen client-side
 * against the exact same `/api/v1/auth/*` endpoints the CLI uses.
 */

import { join } from 'node:path';
import { Hono } from 'hono';

const LOGIN_PAGE_PATH = join(import.meta.dir, 'assets', 'login.html');
const loginPageHtml = await Bun.file(LOGIN_PAGE_PATH).text();

// Restrictive CSP: only same-origin scripts/styles/connections, plus the
// specific CDNs the page needs (Tailwind, driver.js). No inline event
// handlers are used (all wiring happens via addEventListener), so no
// 'unsafe-inline' is needed for scripts; a small inline <style> from
// driver.js/Tailwind's runtime requires 'unsafe-inline' for styles only.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://cdn.tailwindcss.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "connect-src 'self'",
  "img-src 'self' data:",
  "frame-ancestors 'none'",
].join('; ');

export function createAdminUiRouter(): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    c.header('content-security-policy', CONTENT_SECURITY_POLICY);
    return c.html(loginPageHtml);
  });

  return app;
}
