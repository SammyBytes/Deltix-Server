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

const APP_SCRIPT_PATH = join(import.meta.dir, 'assets', 'app.js');
const appScriptJs = await Bun.file(APP_SCRIPT_PATH).text();

// Restrictive CSP: only same-origin scripts/styles/connections, plus the
// specific CDNs the page needs (Tailwind, driver.js). The page logic lives
// in an external same-origin script (/admin/app.js) rather than inline, so
// this policy carries NO 'unsafe-inline' for scripts — an inline <script>
// would otherwise be silently blocked by the browser, which is exactly what
// happened before this fix (the login form silently fell back to a native
// GET submit, leaking the password into the URL query string).
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

  app.get('/app.js', (c) => {
    c.header('content-security-policy', CONTENT_SECURITY_POLICY);
    return c.text(appScriptJs, 200, { 'content-type': 'application/javascript; charset=utf-8' });
  });

  return app;
}
