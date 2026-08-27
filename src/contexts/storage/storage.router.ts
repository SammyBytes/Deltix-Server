/**
 * HonoJS presentation layer for the storage context's dead-letter
 * management API (Fase 3 continued). Lets an operator see which transfer
 * jobs exhausted their automatic retries and require manual action
 * (retry now, or investigate/discard), ahead of a future Admin Web UI
 * panel wired to these same endpoints.
 *
 * Same auth discipline as the transfer router: requires a valid Fase 2
 * JWT access token. No separate auth path to secure.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { createLogger } from '../../shared/logger';
import type { AuthService } from '../auth';
import type { NasSyncService } from './nas-sync.service';

const logger = createLogger('http:storage');

const jobIdBodySchema = z.object({
  jobId: z.string().min(1).max(512),
});

async function authenticate(
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

export function createStorageRouter(authService: AuthService, syncService: NasSyncService) {
  const app = new Hono();

  app.get('/transfer-jobs/dead-letter', async (c) => {
    const username = await authenticate(c.req.header('authorization'), authService);
    if (!username) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const jobs = await syncService.listDeadLetter();
    return c.json({ jobs }, 200);
  });

  app.post('/transfer-jobs/dead-letter/retry', async (c) => {
    const username = await authenticate(c.req.header('authorization'), authService);
    if (!username) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const parsed = jobIdBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body' }, 400);
    }

    const requeued = await syncService.retryDeadLetter(parsed.data.jobId);
    if (!requeued) {
      return c.json({ error: 'Job not found or not in dead_letter state' }, 404);
    }

    logger.info(
      { username, jobId: parsed.data.jobId },
      'Dead-letter transfer job manually requeued',
    );
    return c.json({ ok: true }, 200);
  });

  return app;
}
