/**
 * HonoJS presentation layer for the auth context. Parses/validates request
 * bodies and formats responses — no business logic here (all of it lives in
 * `AuthService`). Kept intentionally thin per copilot-instructions.md.
 *
 * The refresh token is ALSO set as an httpOnly, SameSite=Strict cookie on
 * login/refresh (in addition to being returned in the JSON body, for the
 * CLI which has no cookie jar). Browser clients (Admin Web UI) rely
 * exclusively on the cookie — it is never read by JavaScript — so a page
 * reload can call POST /refresh with no body and silently restore the
 * session, instead of forcing a fresh login. The CLI keeps using the JSON
 * body value directly, unaffected by this cookie.
 *
 * `secure` is only forced on in production: browsers refuse `Secure`
 * cookies over plain HTTP, and this server is commonly run over HTTP on
 * localhost/private networks in dev/test. NEVER weaken this in a real
 * production deployment — it MUST be served behind TLS there.
 *
 * CSRF defense-in-depth: `SameSite=Strict` already blocks the cookie from
 * being sent on cross-site navigations/requests in all modern browsers,
 * but as a second layer (older browsers, future SameSite regressions,
 * defense-in-depth per OWASP ASVS V4), every request that ends up
 * authenticating via the cookie (rather than an explicit body
 * `refreshToken`, which is what the CLI uses) must present an `Origin`
 * header that matches this server's own `Host` header — i.e. same-origin
 * only. A request with no `Origin` header at all (same-origin fetches
 * sometimes omit it, and non-browser HTTP clients like the CLI never
 * cookie-auth in the first place) is allowed through; a request with a
 * MISMATCHED `Origin` is rejected outright.
 */

import type { Context } from 'hono';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { createLogger } from '../../shared/logger';
import type { AuthService } from './auth.service';
import {
  InvalidCredentialsError,
  SessionExpiredError,
  SessionNotFoundError,
  TooManyLoginAttemptsError,
} from './errors';

const logger = createLogger('http:auth');

const REFRESH_TOKEN_COOKIE = 'deltix_refresh_token';

const loginBodySchema = z.object({
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(1024),
});

const sessionTokenBodySchema = z.object({
  refreshToken: z.string().min(1).optional(),
});

function setRefreshTokenCookie(c: Context, token: string, secure: boolean) {
  setCookie(c, REFRESH_TOKEN_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'Strict',
    path: '/',
  });
}

/**
 * Returns true if this request is safe to authenticate via the
 * cookie-derived refresh token: either it carries no `Origin` header at
 * all (non-browser client, e.g. the CLI, or a same-origin request that
 * omitted it), or the `Origin` it does carry matches this server's own
 * scheme+host, per the `Host` header Hono/Bun expose for the request.
 */
function isSameOriginOrNoOrigin(c: Context): boolean {
  const origin = c.req.header('origin');
  if (!origin) {
    return true;
  }
  const host = c.req.header('host');
  if (!host) {
    return false;
  }
  try {
    const originHost = new URL(origin).host;
    return originHost === host;
  } catch {
    return false;
  }
}

export function createAuthRouter(authService: AuthService, secureCookies = true): Hono {
  const app = new Hono();

  app.post('/login', async (c) => {
    const parsed = loginBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body' }, 400);
    }

    try {
      const result = await authService.login(parsed.data.username, parsed.data.password);
      setRefreshTokenCookie(c, result.refreshToken, secureCookies);
      return c.json(result, 200);
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        logger.warn({ username: parsed.data.username }, 'Login failed: invalid credentials');
        return c.json({ error: 'Invalid credentials' }, 401);
      }
      if (err instanceof TooManyLoginAttemptsError) {
        logger.warn({ username: parsed.data.username }, 'Login failed: rate limited');
        return c.json({ error: 'Too many attempts, try again later' }, 429);
      }
      throw err;
    }
  });

  app.post('/refresh', async (c) => {
    const parsed = sessionTokenBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body' }, 400);
    }
    const refreshToken = parsed.data.refreshToken ?? getCookie(c, REFRESH_TOKEN_COOKIE);
    if (!refreshToken) {
      return c.json({ error: 'No active session' }, 401);
    }
    // Only enforce the same-origin check when we actually fell back to the
    // cookie — an explicit body refreshToken (the CLI's path, which has no
    // cookie jar and no CSRF exposure) never goes through this check.
    if (!parsed.data.refreshToken && !isSameOriginOrNoOrigin(c)) {
      return c.json({ error: 'Cross-origin request rejected' }, 403);
    }

    try {
      const result = await authService.refresh(refreshToken);
      setRefreshTokenCookie(c, result.refreshToken, secureCookies);
      return c.json(result, 200);
    } catch (err) {
      if (err instanceof SessionNotFoundError || err instanceof SessionExpiredError) {
        deleteCookie(c, REFRESH_TOKEN_COOKIE, { path: '/' });
        return c.json({ error: 'Session not found or expired' }, 401);
      }
      throw err;
    }
  });

  app.post('/keep-alive', async (c) => {
    const parsed = sessionTokenBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body' }, 400);
    }
    const refreshToken = parsed.data.refreshToken ?? getCookie(c, REFRESH_TOKEN_COOKIE);
    if (!refreshToken) {
      return c.json({ error: 'Invalid request body' }, 400);
    }
    // Only enforce the same-origin check when we actually fell back to the
    // cookie — an explicit body refreshToken (the CLI's path) is never
    // cookie-driven and has no CSRF exposure to defend against here.
    if (!parsed.data.refreshToken && !isSameOriginOrNoOrigin(c)) {
      return c.json({ error: 'Cross-origin request rejected' }, 403);
    }

    try {
      await authService.keepAlive(refreshToken);
      return c.json({ ok: true }, 200);
    } catch (err) {
      if (err instanceof SessionNotFoundError || err instanceof SessionExpiredError) {
        return c.json({ error: 'Session not found or expired' }, 401);
      }
      throw err;
    }
  });

  app.post('/logout', async (c) => {
    const parsed = sessionTokenBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body' }, 400);
    }
    const refreshToken = parsed.data.refreshToken ?? getCookie(c, REFRESH_TOKEN_COOKIE);
    if (!parsed.data.refreshToken && refreshToken && !isSameOriginOrNoOrigin(c)) {
      return c.json({ error: 'Cross-origin request rejected' }, 403);
    }
    if (refreshToken) {
      await authService.logout(refreshToken);
    }
    deleteCookie(c, REFRESH_TOKEN_COOKIE, { path: '/' });
    return c.json({ ok: true }, 200);
  });

  return app;
}
