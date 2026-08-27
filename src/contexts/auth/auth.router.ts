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
  SetupAlreadyConfiguredError,
  TooManyLoginAttemptsError,
  UserAlreadyExistsError,
  UserHasActiveSessionsError,
  UserInactiveError,
  UserNotFoundError,
} from './errors';

const logger = createLogger('http:auth');
const REFRESH_TOKEN_COOKIE = 'deltix_refresh_token';

const loginBodySchema = z.object({
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(1024),
});

const createUserSchema = z.object({
  username: z.string().min(1).max(256),
  password: z.string().min(8).max(1024),
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

export async function authenticateBearerToken(
  authHeader: string | undefined,
  authService: AuthService,
): Promise<string | null> {
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return null;
  }
  try {
    const claims = await authService.verifyAccessToken(token);
    return claims.sub;
  } catch {
    return null;
  }
}

export function createAuthRouter(authService: AuthService, secureCookies = true): Hono {
  const app = new Hono();

  app.get('/setup-status', async (c) => {
    const status = await authService.getSetupStatus();
    return c.json(status, status.eligible ? 200 : 404);
  });

  app.post('/setup', async (c) => {
    const status = await authService.getSetupStatus();
    if (!status.eligible) {
      return c.json({ error: 'Setup already completed', reason: status.reason }, 404);
    }

    const parsed = createUserSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body', details: parsed.error.issues }, 400);
    }

    try {
      const user = await authService.setupFirstAdmin(parsed.data);
      logger.info({ username: user.username }, 'Initial admin created via setup wizard');
      return c.json({ user: { username: user.username, createdAt: user.createdAt } }, 201);
    } catch (err) {
      if (err instanceof SetupAlreadyConfiguredError) {
        return c.json({ error: err.message }, 404);
      }
      if (err instanceof UserAlreadyExistsError) {
        return c.json({ error: err.message }, 409);
      }
      throw err;
    }
  });

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
      if (err instanceof InvalidCredentialsError || err instanceof UserInactiveError) {
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

  app.get('/users', async (c) => {
    const username = await authenticateBearerToken(c.req.header('authorization'), authService);
    if (!username) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const users = await authService.listUsers();
    return c.json({ users }, 200);
  });

  app.post('/users', async (c) => {
    const username = await authenticateBearerToken(c.req.header('authorization'), authService);
    if (!username) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const parsed = createUserSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body', details: parsed.error.issues }, 400);
    }
    try {
      const user = await authService.createUser({ ...parsed.data, createdBy: username });
      return c.json(
        { user: { username: user.username, createdAt: user.createdAt, active: true } },
        201,
      );
    } catch (err) {
      if (err instanceof UserAlreadyExistsError) {
        return c.json({ error: err.message }, 409);
      }
      throw err;
    }
  });

  app.post('/users/:username/deactivate', async (c) => {
    const caller = await authenticateBearerToken(c.req.header('authorization'), authService);
    if (!caller) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    try {
      await authService.deactivateUser(c.req.param('username'));
      return c.json({ ok: true }, 200);
    } catch (err) {
      if (err instanceof UserNotFoundError) {
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }
  });

  app.post('/users/:username/reactivate', async (c) => {
    const caller = await authenticateBearerToken(c.req.header('authorization'), authService);
    if (!caller) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    try {
      await authService.reactivateUser(c.req.param('username'));
      return c.json({ ok: true }, 200);
    } catch (err) {
      if (err instanceof UserNotFoundError) {
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }
  });

  app.delete('/users/:username', async (c) => {
    const caller = await authenticateBearerToken(c.req.header('authorization'), authService);
    if (!caller) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    try {
      await authService.deleteUser(c.req.param('username'));
      return c.json({ ok: true }, 200);
    } catch (err) {
      if (err instanceof UserHasActiveSessionsError) {
        return c.json({ error: err.message }, 409);
      }
      if (err instanceof UserNotFoundError) {
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }
  });

  return app;
}
