/**
 * HonoJS presentation layer for repo provisioning (Fase 5.1): lets an
 * authenticated user create a new Dolt-backed repo and list/inspect
 * existing ones. Same auth discipline as every other management endpoint
 * in this project: requires a valid Fase 2 JWT access token.
 *
 * Fase 5.6 will extend this with per-repo/branch authorization; for 5.1
 * any authenticated user may provision a repo, same current-state
 * coarseness as the addons trust endpoints.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { createLogger } from '../../shared/logger';
import type { AuthService } from '../auth';
import { InvalidRepoIdError, RepoAlreadyProvisionedError } from './errors';
import type { RepoProvisioningService } from './repo-provisioning.service';

const logger = createLogger('http:versioning');

const provisionRequestSchema = z.object({
  repoId: z.string().min(1).max(64),
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

export function createVersioningRouter(
  authService: AuthService,
  provisioningService: RepoProvisioningService,
): Hono {
  const app = new Hono();

  app.post('/repos', async (c) => {
    const username = await authenticate(c.req.header('authorization'), authService);
    if (!username) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const parsed = provisionRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body', details: parsed.error.issues }, 400);
    }

    try {
      const record = await provisioningService.provision(parsed.data.repoId, username);
      logger.info({ username, repoId: record.repoId }, 'Repo provisioned with a real Dolt backend');
      return c.json({ repo: record }, 201);
    } catch (err) {
      if (err instanceof InvalidRepoIdError) {
        return c.json({ error: err.message }, 400);
      }
      if (err instanceof RepoAlreadyProvisionedError) {
        return c.json({ error: err.message }, 409);
      }
      logger.error({ err, repoId: parsed.data.repoId }, 'Repo provisioning failed');
      return c.json({ error: 'Failed to provision repo' }, 500);
    }
  });

  app.get('/repos', async (c) => {
    const username = await authenticate(c.req.header('authorization'), authService);
    if (!username) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const repos = await provisioningService.list();
    return c.json({ repos }, 200);
  });

  app.get('/repos/:repoId', async (c) => {
    const username = await authenticate(c.req.header('authorization'), authService);
    if (!username) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const repo = await provisioningService.get(c.req.param('repoId'));
    if (!repo) {
      return c.json({ error: 'Repo not found' }, 404);
    }
    return c.json({ repo }, 200);
  });

  return app;
}
