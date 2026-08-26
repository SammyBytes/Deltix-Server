/**
 * HonoJS presentation layer for the auth context. Parses/validates request
 * bodies and formats responses — no business logic here (all of it lives in
 * `AuthService`). Kept intentionally thin per copilot-instructions.md.
 */
import { Hono } from 'hono';
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

const loginBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const sessionTokenBodySchema = z.object({
  refreshToken: z.string().min(1),
});

export function createAuthRouter(authService: AuthService): Hono {
  const app = new Hono();

  app.post('/login', async (c) => {
    const parsed = loginBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body' }, 400);
    }

    try {
      const result = await authService.login(parsed.data.username, parsed.data.password);
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

  app.post('/keep-alive', async (c) => {
    const parsed = sessionTokenBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body' }, 400);
    }

    try {
      await authService.keepAlive(parsed.data.refreshToken);
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

    await authService.logout(parsed.data.refreshToken);
    return c.json({ ok: true }, 200);
  });

  return app;
}
