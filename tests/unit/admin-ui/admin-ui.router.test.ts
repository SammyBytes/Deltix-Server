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
});
