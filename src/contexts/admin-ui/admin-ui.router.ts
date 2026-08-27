import { join } from 'node:path';
import { Hono } from 'hono';
import type { AuthService } from '../auth';

const LOGIN_PAGE_PATH = join(import.meta.dir, 'assets', 'login.html');
const loginPageHtml = await Bun.file(LOGIN_PAGE_PATH).text();
const SETUP_PAGE_PATH = join(import.meta.dir, 'assets', 'setup.html');
const setupPageHtml = await Bun.file(SETUP_PAGE_PATH).text();
const APP_SCRIPT_PATH = join(import.meta.dir, 'assets', 'app.js');
const appScriptJs = await Bun.file(APP_SCRIPT_PATH).text();

/**
 * Vendored, offline-servable copies of Tailwind CSS and driver.js — see
 * `assets/vendor/README.md`. The Admin Web UI must render fully on an
 * air-gapped/no-internet deployment (e.g. a VMware VM with no outbound
 * access): it previously loaded these from `cdn.tailwindcss.com` and
 * `cdn.jsdelivr.net`, which silently produced an unstyled, broken page
 * whenever the server couldn't reach the public internet.
 */
const VENDOR_DIR = join(import.meta.dir, 'assets', 'vendor');
const VENDOR_FILES: Record<string, { path: string; contentType: string }> = {
  'tailwind.css': { path: join(VENDOR_DIR, 'tailwind.css'), contentType: 'text/css' },
  'driver.css': { path: join(VENDOR_DIR, 'driver.css'), contentType: 'text/css' },
  'driver.iife.js': {
    path: join(VENDOR_DIR, 'driver.iife.js'),
    contentType: 'application/javascript',
  },
};
const vendorAssets = new Map<string, { body: string; contentType: string }>();
for (const [name, { path, contentType }] of Object.entries(VENDOR_FILES)) {
  vendorAssets.set(name, { body: await Bun.file(path).text(), contentType });
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "frame-ancestors 'none'",
].join('; ');

/**
 * The Admin Web UI ships as static HTML/JS/CSS served directly by this
 * router (no build hash / cache-busting filenames), so without an explicit
 * Cache-Control the browser is free to keep serving a stale `app.js` (or
 * `login.html`) from its disk cache indefinitely after a server upgrade --
 * silently running old client code against a new server, which produces
 * exactly the "I upgraded but nothing changed" symptom. Always revalidate.
 */
function setNoCacheHeaders(c: { header: (name: string, value: string) => void }): void {
  c.header('cache-control', 'no-store, no-cache, must-revalidate');
  c.header('pragma', 'no-cache');
}

export function createAdminUiRouter(authService: AuthService): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    c.header('content-security-policy', CONTENT_SECURITY_POLICY);
    setNoCacheHeaders(c);
    const setup = await authService.getSetupStatus();
    return c.html(setup.eligible ? setupPageHtml : loginPageHtml);
  });

  app.get('/setup', async (c) => {
    c.header('content-security-policy', CONTENT_SECURITY_POLICY);
    setNoCacheHeaders(c);
    const setup = await authService.getSetupStatus();
    if (!setup.eligible) {
      return c.html(loginPageHtml, 404);
    }
    return c.html(setupPageHtml);
  });

  app.get('/users', async (c) => {
    c.header('content-security-policy', CONTENT_SECURITY_POLICY);
    setNoCacheHeaders(c);
    return c.html(loginPageHtml);
  });

  app.get('/app.js', (c) => {
    c.header('content-security-policy', CONTENT_SECURITY_POLICY);
    setNoCacheHeaders(c);
    return c.text(appScriptJs, 200, { 'content-type': 'application/javascript; charset=utf-8' });
  });

  app.get('/vendor/:file', (c) => {
    c.header('content-security-policy', CONTENT_SECURITY_POLICY);
    setNoCacheHeaders(c);
    const asset = vendorAssets.get(c.req.param('file'));
    if (!asset) {
      return c.notFound();
    }
    return c.text(asset.body, 200, { 'content-type': `${asset.contentType}; charset=utf-8` });
  });

  return app;
}
