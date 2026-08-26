import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { applySecurityMiddleware } from '../../../src/shared/security-middleware';

function buildApp(allowedOrigins: string[]): Hono {
  const app = new Hono();
  applySecurityMiddleware(app, { allowedOrigins });
  app.get('/ping', (c) => c.json({ ok: true }));
  return app;
}

describe('shared/security-middleware (unit, real Hono.fetch)', () => {
  it('attaches baseline security headers to every response', async () => {
    const app = buildApp([]);

    const res = await app.request('/ping');

    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('does not set Access-Control-Allow-Origin when the origin is not allow-listed', async () => {
    const app = buildApp(['https://admin.deltix.example']);

    const res = await app.request('/ping', { headers: { Origin: 'https://evil.example' } });

    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('sets Access-Control-Allow-Origin only for an explicitly allow-listed origin', async () => {
    const app = buildApp(['https://admin.deltix.example']);

    const res = await app.request('/ping', {
      headers: { Origin: 'https://admin.deltix.example' },
    });

    expect(res.headers.get('access-control-allow-origin')).toBe('https://admin.deltix.example');
  });

  it('never reflects a wildcard origin when the allow-list is empty (fail closed)', async () => {
    const app = buildApp([]);

    const res = await app.request('/ping', { headers: { Origin: 'https://anything.example' } });

    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('responds to a CORS preflight OPTIONS request for an allow-listed origin', async () => {
    const app = buildApp(['https://admin.deltix.example']);

    const res = await app.request('/ping', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://admin.deltix.example',
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://admin.deltix.example');
  });
});
