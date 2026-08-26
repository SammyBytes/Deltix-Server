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
    const refreshToken = getCookie(c, REFRESH_TOKEN_COOKIE);
    if (!refreshToken) {
      return c.json({ error: 'No active session' }, 401);
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
    if (refreshToken) {
      await authService.logout(refreshToken);
    }
    deleteCookie(c, REFRESH_TOKEN_COOKIE, { path: '/' });
    return c.json({ ok: true }, 200);
  });

  return app;
}
