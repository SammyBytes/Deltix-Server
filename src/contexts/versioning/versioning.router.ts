import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { createLogger } from '../../shared/logger';
import type { AuthService, RepoRole } from '../auth';
import { InvalidRepoRoleError, RepoRoleAssignmentNotFoundError, UserNotFoundError } from '../auth';
import type { BranchService } from './branch.service';
import type { DiffService } from './diff.service';
import {
  BranchAlreadyExistsError,
  BranchNotFoundError,
  InvalidBranchNameError,
  InvalidCommitReferenceError,
  InvalidPaginationLimitError,
  InvalidRepoIdError,
  MergeConflictError,
  ProtectedBranchError,
  RepoAccessDeniedError,
  RepoAlreadyProvisionedError,
  RepoNotFoundError,
  SyncPreferenceConflictError,
} from './errors';
import type { LogService } from './log.service';
import type { MergeService } from './merge.service';
import type { RepoProvisioningService } from './repo-provisioning.service';
import type { SyncPreferenceService } from './sync-preference.service';

const logger = createLogger('http:versioning');
const ROLE_RANK: Record<RepoRole, number> = { reader: 1, writer: 2, admin: 3 };

const provisionRequestSchema = z.object({
  repoId: z.string().min(1).max(64),
});

const branchRequestSchema = z.object({
  name: z.string().min(1).max(128),
});

const mergeRequestSchema = z.object({
  sourceBranch: z.string().min(1).max(128),
  targetBranch: z.string().min(1).max(128).optional(),
});

const logQuerySchema = z.object({
  branch: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const diffQuerySchema = z.object({
  from: z.string().min(1).max(128),
  to: z.string().min(1).max(128),
});

const syncRequestSchema = z.object({
  mode: z.enum(['schema_only', 'schema_and_data']),
  tables: z.array(z.string().min(1).max(128)).max(256).nullable().optional(),
});

const roleGrantRequestSchema = z.object({
  username: z.string().min(1).max(256),
  role: z.enum(['reader', 'writer', 'admin']),
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

async function requireUsername(c: Context, authService: AuthService) {
  const username = await authenticate(c.req.header('authorization'), authService);
  if (!username) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return username;
}

async function requireRepoRole(
  c: Context,
  authService: AuthService,
  repoId: string,
  minimumRole: RepoRole,
) {
  const username = await requireUsername(c, authService);
  if (typeof username !== 'string') {
    return username;
  }
  const role = await authService.getRepoRole(username, repoId);
  if (!role || ROLE_RANK[role] < ROLE_RANK[minimumRole]) {
    return c.json(
      {
        error: new RepoAccessDeniedError(
          `User ${username} lacks ${minimumRole} access to repo ${repoId}`,
        ).message,
      },
      403,
    );
  }
  return { username, role };
}

/**
 * Same as requireRepoRole, but global admins are also let through even with
 * no explicit per-repo role of their own. Scoped ONLY to the role-management
 * endpoints below (list/grant/revoke) -- global admin must NOT become an
 * implicit reader/writer/admin for actual repo data operations (push, merge,
 * commit, etc.), that would silently reintroduce the RBAC-bypass class of
 * bug already fixed elsewhere. Managing *who else* has access is a distinct,
 * legitimately global-admin-level responsibility.
 */
async function requireRepoRoleOrGlobalAdmin(
  c: Context,
  authService: AuthService,
  repoId: string,
  minimumRole: RepoRole,
) {
  const username = await requireUsername(c, authService);
  if (typeof username !== 'string') {
    return username;
  }
  const role = await authService.getRepoRole(username, repoId);
  if (role && ROLE_RANK[role] >= ROLE_RANK[minimumRole]) {
    return { username, role };
  }
  if (await authService.isGlobalAdmin(username)) {
    return { username, role: role ?? 'admin' };
  }
  return c.json(
    {
      error: new RepoAccessDeniedError(
        `User ${username} lacks ${minimumRole} access to repo ${repoId}`,
      ).message,
    },
    403,
  );
}

async function authorizeRepoRequest(c: Context, authService: AuthService, minimumRole: RepoRole) {
  const repoId = c.req.param('repoId');
  if (!repoId) {
    return c.json({ error: 'Missing repoId' }, 400);
  }
  return requireRepoRole(c, authService, repoId, minimumRole);
}

function parseSyncBody(parsed: z.ZodSafeParseResult<z.infer<typeof syncRequestSchema>>) {
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

function handleBranchError(err: unknown, fallback: string) {
  if (err instanceof InvalidRepoIdError || err instanceof InvalidBranchNameError) {
    return { body: { error: err.message }, status: 400 };
  }
  if (err instanceof RepoNotFoundError || err instanceof BranchNotFoundError) {
    return { body: { error: err.message }, status: 404 };
  }
  if (
    err instanceof BranchAlreadyExistsError ||
    err instanceof ProtectedBranchError ||
    err instanceof RepoAlreadyProvisionedError
  ) {
    return { body: { error: err.message }, status: 409 };
  }
  if (err instanceof RepoAccessDeniedError) {
    return { body: { error: err.message }, status: 403 };
  }
  return { body: { error: fallback }, status: 500 };
}

function handleMergeError(err: unknown, fallback: string) {
  if (err instanceof InvalidRepoIdError || err instanceof InvalidBranchNameError) {
    return { body: { error: err.message }, status: 400 };
  }
  if (err instanceof RepoNotFoundError || err instanceof BranchNotFoundError) {
    return { body: { error: err.message }, status: 404 };
  }
  if (err instanceof RepoAccessDeniedError) {
    return { body: { error: err.message }, status: 403 };
  }
  if (err instanceof MergeConflictError) {
    return {
      body: {
        error: err.message,
        merge: {
          status: 'conflicted',
          sourceBranch: err.sourceBranch,
          targetBranch: err.targetBranch,
          conflicts: err.conflicts,
        },
      },
      status: 409,
    };
  }
  return { body: { error: fallback }, status: 500 };
}

function handleHistoryError(err: unknown, fallback: string) {
  if (
    err instanceof InvalidRepoIdError ||
    err instanceof InvalidBranchNameError ||
    err instanceof InvalidCommitReferenceError ||
    err instanceof InvalidPaginationLimitError
  ) {
    return { body: { error: err.message }, status: 400 };
  }
  if (err instanceof RepoNotFoundError || err instanceof BranchNotFoundError) {
    return { body: { error: err.message }, status: 404 };
  }
  if (err instanceof RepoAccessDeniedError) {
    return { body: { error: err.message }, status: 403 };
  }
  return { body: { error: fallback }, status: 500 };
}

async function respondWithRepoLog(
  c: Context,
  logService: LogService,
  query: { branch?: string | undefined; limit?: number | undefined },
) {
  const repoId = c.req.param('repoId');
  if (!repoId) {
    return c.json({ error: 'Missing repoId' }, 400);
  }
  try {
    const commits = await logService.list(repoId, {
      ...(query.branch ? { branch: query.branch } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
    return c.json({ log: { commits, limit: Math.min(query.limit ?? 50, 200) } }, 200);
  } catch (err) {
    const handled = handleHistoryError(err, 'Failed to read repo log');
    return c.json(handled.body, handled.status as 400 | 403 | 404 | 500);
  }
}

function handleSyncError(err: unknown, fallback: string) {
  if (err instanceof InvalidRepoIdError) {
    return { body: { error: err.message }, status: 400 };
  }
  if (err instanceof RepoNotFoundError) {
    return { body: { error: err.message }, status: 404 };
  }
  if (err instanceof RepoAccessDeniedError) {
    return { body: { error: err.message }, status: 403 };
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
  branchService?: BranchService,
  mergeService?: MergeService,
  logService?: LogService,
  diffService?: DiffService,
): Hono {
  const app = new Hono();

  app.post('/repos', async (c) => {
    const username = await authenticate(c.req.header('authorization'), authService);
    if (!username) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Only users with canCreateRepos flag (or global admins) may create repos.
    if (!(await authService.canUserCreateRepos(username))) {
      return c.json({ error: 'User cannot create repos' }, 403);
    }

    const parsed = provisionRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body', details: parsed.error.issues }, 400);
    }

    try {
      const record = await provisioningService.provision(parsed.data.repoId, username);
      await authService.grantRepoAdminToCreator(record.repoId, username);
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
    const isGlobalAdmin = await authService.isGlobalAdmin(username);
    const visible = [];
    for (const repo of repos) {
      const role = await authService.getRepoRole(username, repo.repoId);
      // Global admins can see every repo (even ones they hold no explicit
      // per-repo role on) so they can actually manage roles for other users --
      // that's the whole point of the admin Roles panel. Global admin status
      // is intentionally NOT an implicit reader/writer/admin repo role.
      if (role || isGlobalAdmin) {
        visible.push({ ...repo, role: role ?? null });
      }
    }
    return c.json({ repos: visible }, 200);
  });

  app.get('/repos/:repoId', async (c) => {
    const access = await requireRepoRole(c, authService, c.req.param('repoId'), 'reader');
    if (!('username' in access)) {
      return access;
    }

    const repo = await provisioningService.get(c.req.param('repoId'));
    if (!repo) {
      return c.json({ error: 'Repo not found' }, 404);
    }
    return c.json({ repo: { ...repo, role: access.role } }, 200);
  });

  app.get('/repos/:repoId/roles', async (c) => {
    const access = await requireRepoRoleOrGlobalAdmin(
      c,
      authService,
      c.req.param('repoId'),
      'reader',
    );
    if (!('username' in access)) {
      return access;
    }
    const roles = await authService.listRepoRoles(c.req.param('repoId'));
    return c.json({ roles }, 200);
  });

  app.post('/repos/:repoId/roles', async (c) => {
    const access = await requireRepoRoleOrGlobalAdmin(
      c,
      authService,
      c.req.param('repoId'),
      'admin',
    );
    if (!('username' in access)) {
      return access;
    }
    const parsed = roleGrantRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body', details: parsed.error.issues }, 400);
    }
    try {
      const assignment = await authService.grantRepoRole({
        username: parsed.data.username,
        repoId: c.req.param('repoId'),
        role: parsed.data.role,
        grantedBy: access.username,
      });
      return c.json({ role: assignment }, 201);
    } catch (err) {
      if (err instanceof InvalidRepoRoleError) {
        return c.json({ error: err.message }, 400);
      }
      if (err instanceof UserNotFoundError) {
        return c.json({ error: err.message }, 404);
      }
      return c.json({ error: 'Failed to grant repo role' }, 500);
    }
  });

  app.delete('/repos/:repoId/roles/:username', async (c) => {
    const access = await requireRepoRoleOrGlobalAdmin(
      c,
      authService,
      c.req.param('repoId'),
      'admin',
    );
    if (!('username' in access)) {
      return access;
    }
    try {
      await authService.revokeRepoRole(c.req.param('username'), c.req.param('repoId'));
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof RepoRoleAssignmentNotFoundError) {
        return c.json({ error: err.message }, 404);
      }
      return c.json({ error: 'Failed to revoke repo role' }, 500);
    }
  });

  if (logService) {
    app.get('/repos/:repoId/log', async (c) => {
      const access = await authorizeRepoRequest(c, authService, 'reader');
      if (!('username' in access)) {
        return access;
      }
      const parsed = logQuerySchema.safeParse(c.req.query());
      if (!parsed.success) {
        return c.json({ error: 'Invalid query string', details: parsed.error.issues }, 400);
      }
      return respondWithRepoLog(c, logService, parsed.data);
    });
  }

  if (diffService) {
    app.get('/repos/:repoId/diff', async (c) => {
      const access = await authorizeRepoRequest(c, authService, 'reader');
      if (!('username' in access)) {
        return access;
      }
      const parsed = diffQuerySchema.safeParse(c.req.query());
      if (!parsed.success) {
        return c.json({ error: 'Invalid query string', details: parsed.error.issues }, 400);
      }
      try {
        const diff = await diffService.read(
          c.req.param('repoId'),
          parsed.data.from,
          parsed.data.to,
        );
        return c.json({ diff }, 200);
      } catch (err) {
        const handled = handleHistoryError(err, 'Failed to read repo diff');
        return c.json(handled.body, handled.status as 400 | 403 | 404 | 500);
      }
    });
  }

  if (mergeService) {
    app.post('/repos/:repoId/merge', async (c) => {
      const access = await authorizeRepoRequest(c, authService, 'writer');
      if (!('username' in access)) {
        return access;
      }
      const parsed = mergeRequestSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Invalid request body', details: parsed.error.issues }, 400);
      }
      try {
        const merge = await mergeService.merge(
          c.req.param('repoId'),
          parsed.data.sourceBranch,
          parsed.data.targetBranch,
        );
        return c.json({ merge }, 200);
      } catch (err) {
        logger.error({ err, repoId: c.req.param('repoId') }, 'Failed to merge branch');
        const handled = handleMergeError(err, 'Failed to merge branch');
        return c.json(handled.body, handled.status as 400 | 403 | 404 | 409 | 500);
      }
    });
  }

  if (branchService) {
    app.get('/repos/:repoId/branches', async (c) => {
      const access = await authorizeRepoRequest(c, authService, 'reader');
      if (!('username' in access)) {
        return access;
      }
      try {
        const branches = await branchService.list(c.req.param('repoId'));
        return c.json({ branches }, 200);
      } catch (err) {
        const handled = handleBranchError(err, 'Failed to list branches');
        return c.json(handled.body, handled.status as 400 | 403 | 404 | 409 | 500);
      }
    });

    app.post('/repos/:repoId/branches', async (c) => {
      const access = await authorizeRepoRequest(c, authService, 'writer');
      if (!('username' in access)) {
        return access;
      }
      const parsed = branchRequestSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Invalid request body', details: parsed.error.issues }, 400);
      }
      try {
        const branch = await branchService.create(c.req.param('repoId'), parsed.data.name);
        return c.json({ branch }, 201);
      } catch (err) {
        const handled = handleBranchError(err, 'Failed to create branch');
        return c.json(handled.body, handled.status as 400 | 403 | 404 | 409 | 500);
      }
    });

    app.get('/repos/:repoId/branches/current', async (c) => {
      const access = await authorizeRepoRequest(c, authService, 'reader');
      if (!('username' in access)) {
        return access;
      }
      try {
        const name = await branchService.current(c.req.param('repoId'));
        return c.json({ branch: { name } }, 200);
      } catch (err) {
        const handled = handleBranchError(err, 'Failed to read current branch');
        return c.json(handled.body, handled.status as 400 | 403 | 404 | 409 | 500);
      }
    });

    app.post('/repos/:repoId/branches/:name/checkout', async (c) => {
      const access = await authorizeRepoRequest(c, authService, 'writer');
      if (!('username' in access)) {
        return access;
      }
      try {
        const branch = await branchService.checkout(
          c.req.param('repoId'),
          decodeURIComponent(c.req.param('name')),
        );
        return c.json({ branch }, 200);
      } catch (err) {
        const handled = handleBranchError(err, 'Failed to checkout branch');
        return c.json(handled.body, handled.status as 400 | 403 | 404 | 409 | 500);
      }
    });

    app.delete('/repos/:repoId/branches/:name', async (c) => {
      const access = await authorizeRepoRequest(c, authService, 'admin');
      if (!('username' in access)) {
        return access;
      }
      try {
        await branchService.delete(c.req.param('repoId'), decodeURIComponent(c.req.param('name')));
        return c.body(null, 204);
      } catch (err) {
        const handled = handleBranchError(err, 'Failed to delete branch');
        return c.json(handled.body, handled.status as 400 | 403 | 404 | 409 | 500);
      }
    });
  }

  if (syncPreferenceService) {
    app.get('/repos/:repoId/sync-preferences', async (c) => {
      const access = await authorizeRepoRequest(c, authService, 'admin');
      if (!('username' in access)) {
        return access;
      }
      try {
        const preference = await syncPreferenceService.get(c.req.param('repoId'));
        return c.json({ preference }, 200);
      } catch (err) {
        const handled = handleSyncError(err, 'Failed to read sync preference');
        return c.json(handled.body, handled.status as 400 | 403 | 404 | 409 | 500);
      }
    });

    app.put('/repos/:repoId/sync-preferences', async (c) => {
      const access = await authorizeRepoRequest(c, authService, 'admin');
      if (!('username' in access)) {
        return access;
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
        return c.json(handled.body, handled.status as 400 | 403 | 404 | 409 | 500);
      }
    });

    app.post('/repos/:repoId/sync-preferences/dry-run', async (c) => {
      const access = await authorizeRepoRequest(c, authService, 'admin');
      if (!('username' in access)) {
        return access;
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
        return c.json(handled.body, handled.status as 400 | 403 | 404 | 409 | 500);
      }
    });
  }

  return app;
}
