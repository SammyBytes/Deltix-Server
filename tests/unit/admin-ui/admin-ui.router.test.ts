import { describe, expect, it } from 'bun:test';
import { createAdminUiRouter } from '../../../src/contexts/admin-ui/admin-ui.router';

describe('admin-ui/admin-ui.router (unit, real Hono.fetch)', () => {
  it('GET /admin serves the login page as HTML', async () => {
    const app = createAdminUiRouter();

    const res = await app.request('/');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<title>Deltix Admin</title>');
  });

  it('GET / does not embed any secret/token/key literal in the served HTML', async () => {
    const app = createAdminUiRouter();

    const res = await app.request('/');
    const body = await res.text();

    expect(body.toLowerCase()).not.toContain('privatekey');
    expect(body.toLowerCase()).not.toContain('licensekey');
  });

  it('sets a restrictive Content-Security-Policy header', async () => {
    const app = createAdminUiRouter();

    const res = await app.request('/');

    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeString();
    expect(csp).toContain("default-src 'self'");
  });

  it('CSP has no unsafe-inline for scripts (the page logic must load as an external file)', async () => {
    const app = createAdminUiRouter();

    const res = await app.request('/');
    const csp = res.headers.get('content-security-policy') ?? '';
    const scriptSrcDirective = csp.split(';').find((d) => d.trim().startsWith('script-src'));

    expect(scriptSrcDirective).toBeDefined();
    expect(scriptSrcDirective).not.toContain('unsafe-inline');
  });

  it('the served HTML has no inline <script> body — only external src= scripts', async () => {
    const app = createAdminUiRouter();

    const res = await app.request('/');
    const body = await res.text();

    // Every <script ...> tag must either self-close or be immediately
    // followed by </script> (no inline JS body), otherwise a strict CSP
    // without 'unsafe-inline' silently drops the script and the login form
    // falls back to a native GET submit — leaking the password into the URL.
    const scriptTagPattern = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
    for (const match of body.matchAll(scriptTagPattern)) {
      expect(match[1].trim()).toBe('');
    }
  });

  it('GET /app.js serves the page logic as same-origin JavaScript', async () => {
    const app = createAdminUiRouter();

    const res = await app.request('/app.js');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    const body = await res.text();
    expect(body).toContain("fetch('/api/v1/auth/login'");
  });
});
