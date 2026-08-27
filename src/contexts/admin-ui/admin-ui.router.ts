import { join } from 'node:path';
import { Hono } from 'hono';
import type { AuthService } from '../auth';

const LOGIN_PAGE_PATH = join(import.meta.dir, 'assets', 'login.html');
const loginPageHtml = await Bun.file(LOGIN_PAGE_PATH).text();
const SETUP_PAGE_PATH = join(import.meta.dir, 'assets', 'setup.html');
const setupPageHtml = await Bun.file(SETUP_PAGE_PATH).text();
const APP_SCRIPT_PATH = join(import.meta.dir, 'assets', 'app.js');
const appScriptJs = await Bun.file(APP_SCRIPT_PATH).text();

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://cdn.tailwindcss.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "connect-src 'self'",
  "img-src 'self' data:",
  "frame-ancestors 'none'",
].join('; ');

export function createAdminUiRouter(authService: AuthService): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    c.header('content-security-policy', CONTENT_SECURITY_POLICY);
    const setup = await authService.getSetupStatus();
    return c.html(setup.eligible ? setupPageHtml : loginPageHtml);
  });

  app.get('/setup', async (c) => {
    c.header('content-security-policy', CONTENT_SECURITY_POLICY);
    const setup = await authService.getSetupStatus();
    if (!setup.eligible) {
      return c.html(loginPageHtml, 404);
    }
    return c.html(setupPageHtml);
  });

  app.get('/users', async (c) => {
    c.header('content-security-policy', CONTENT_SECURITY_POLICY);
    return c.html(loginPageHtml);
  });

  app.get('/app.js', (c) => {
    c.header('content-security-policy', CONTENT_SECURITY_POLICY);
    return c.text(appScriptJs, 200, { 'content-type': 'application/javascript; charset=utf-8' });
  });

  return app;
}
