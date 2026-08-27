import { Hono } from 'hono';
import { z } from 'zod';
import { createLogger } from '../../shared/logger';
import type { AuthService } from '../auth';
import {
  InvalidRepoIdError,
  RepoAlreadyProvisionedError,
  RepoNotFoundError,
  SyncPreferenceConflictError,
} from './errors';
import type { RepoProvisioningService } from './repo-provisioning.service';
import type { SyncPreferenceService } from './sync-preference.service';

const logger = createLogger('http:versioning');

const provisionRequestSchema = z.object({
  repoId: z.string().min(1).max(64),
});

const syncRequestSchema = z.object({
  mode: z.enum(['schema_only', 'schema_and_data']),
  tables: z.array(z.string().min(1).max(128)).max(256).nullable().optional(),
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

async function requireUsername(
  c: Parameters<Hono['get']>[1] extends (arg: infer T) => unknown ? T : never,
  authService: AuthService,
) {
  const username = await authenticate(c.req.header('authorization'), authService);
  if (!username) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return username;
}

function parseSyncBody(
  parsed: z.SafeParseReturnType<
    unknown,
    { mode: 'schema_only' | 'schema_and_data'; tables?: string[] | null | undefined }
  >,
) {
  if (!parsed.success) {
    return {
      ok: false as const,
      response: { error: 'Invalid request body', details: parsed.error.issues },
    };
  }
  return {
    ok: true as const,
    data: { mode: parsed.data.mode, tables: parsed.data.tables ?? null },
  };
}

function handleSyncError(err: unknown, fallback: string) {
  if (err instanceof InvalidRepoIdError) {
    return { body: { error: err.message }, status: 400 };
  }
  if (err instanceof RepoNotFoundError) {
    return { body: { error: err.message }, status: 404 };
  }
  if (err instanceof SyncPreferenceConflictError) {
    return { body: { error: err.message }, status: 409 };
  }
  return { body: { error: fallback }, status: 500 };
}

export function createVersioningRouter(
  authService: AuthService,
  provisioningService: RepoProvisioningService,
  syncPreferenceService?: SyncPreferenceService,
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

  if (syncPreferenceService) {
    app.get('/repos/:repoId/sync-preferences', async (c) => {
      const username = await requireUsername(c, authService);
      if (typeof username !== 'string') {
        return username;
      }
      try {
        const preference = await syncPreferenceService.get(c.req.param('repoId'));
        return c.json({ preference }, 200);
      } catch (err) {
        const handled = handleSyncError(err, 'Failed to read sync preference');
        return c.json(handled.body, handled.status as 400 | 404 | 409 | 500);
      }
    });

    app.put('/repos/:repoId/sync-preferences', async (c) => {
      const username = await requireUsername(c, authService);
      if (typeof username !== 'string') {
        return username;
      }
      const parsed = parseSyncBody(
        syncRequestSchema.safeParse(await c.req.json().catch(() => null)),
      );
      if (!parsed.ok) {
        return c.json(parsed.response, 400);
      }
      try {
        const preference = await syncPreferenceService.upsert(c.req.param('repoId'), parsed.data);
        return c.json({ preference }, 200);
      } catch (err) {
        logger.error({ err, repoId: c.req.param('repoId') }, 'Failed to save sync preference');
        const handled = handleSyncError(err, 'Failed to save sync preference');
        return c.json(handled.body, handled.status as 400 | 404 | 409 | 500);
      }
    });

    app.post('/repos/:repoId/sync-preferences/dry-run', async (c) => {
      const username = await requireUsername(c, authService);
      if (typeof username !== 'string') {
        return username;
      }
      const parsed = parseSyncBody(
        syncRequestSchema.safeParse(await c.req.json().catch(() => null)),
      );
      if (!parsed.ok) {
        return c.json(parsed.response, 400);
      }
      try {
        const plan = await syncPreferenceService.preview(c.req.param('repoId'), parsed.data);
        return c.json({ plan }, 200);
      } catch (err) {
        logger.error({ err, repoId: c.req.param('repoId') }, 'Failed to preview sync preference');
        const handled = handleSyncError(err, 'Failed to preview sync preference');
        return c.json(handled.body, handled.status as 400 | 404 | 409 | 500);
      }
    });
  }

  return app;
}
