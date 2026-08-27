import { Hono } from 'hono';
import { z } from 'zod';
import { createLogger } from '../../shared/logger';
import type { AuthService, RepoRole } from '../auth';
import {
  TicketAlreadyConsumedError,
  TicketExpiredError,
  TicketNotFoundError,
  TicketOperationMismatchError,
} from './errors';
import type { TicketService } from './ticket.service';
import type { PushTicketSyncOptions } from './types';

const logger = createLogger('http:transfer');
const ROLE_RANK: Record<RepoRole, number> = { reader: 1, writer: 2, admin: 3 };
// Push mutates the repo's data, so it requires at least `writer`; pull is
// read-only and only requires `reader`. This is the ticket-issuance-time
// enforcement point for repo RBAC on the transfer/gRPC path — the gRPC
// streaming layer itself never re-checks roles, it only trusts that a
// ticket was issued for a (username, operation, repo) tuple that already
// passed this check, so this MUST NOT be skipped or weakened.
const MINIMUM_ROLE_FOR_OPERATION: Record<'push' | 'pull', RepoRole> = {
  push: 'writer',
  pull: 'reader',
};

const syncOptionsSchema = z
  .object({
    mode: z.enum(['schema_only', 'schema_and_data']).optional(),
    tables: z.array(z.string().min(1).max(128)).max(256).nullable().optional(),
    dryRun: z.boolean().optional(),
  })
  .optional();

const issueTicketBodySchema = z.object({
  operation: z.enum(['push', 'pull']),
  repo: z.string().min(1).max(512),
  sync: syncOptionsSchema,
});

const ticketIdBodySchema = z.object({
  ticketId: z.string().min(1).max(512),
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

function toPushTicketSyncOptions(
  sync: z.infer<typeof syncOptionsSchema>,
): PushTicketSyncOptions | null {
  if (!sync) {
    return null;
  }
  const options: PushTicketSyncOptions = {};
  if (sync.mode !== undefined) {
    options.mode = sync.mode;
  }
  if (sync.tables !== undefined) {
    options.tables = sync.tables;
  }
  if (sync.dryRun !== undefined) {
    options.dryRun = sync.dryRun;
  }
  return options;
}

export function createTransferRouter(authService: AuthService, ticketService: TicketService) {
  const app = new Hono();

  app.post('/push/ticket', async (c) => {
    const username = await authenticate(c.req.header('authorization'), authService);
    if (!username) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const parsed = issueTicketBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body' }, 400);
    }

    // Every ticket-issuing request must be checked against the caller's
    // actual repo role here — this is the only authorization gate for the
    // gRPC transfer path, since the streaming layer itself trusts any
    // ticket it's handed. A `reader` must never be able to obtain a push
    // ticket (write access), even though the HTTP layer for other
    // endpoints separately enforces its own role checks.
    const minimumRole = MINIMUM_ROLE_FOR_OPERATION[parsed.data.operation];
    const role = await authService.getRepoRole(username, parsed.data.repo);
    if (!role || ROLE_RANK[role] < ROLE_RANK[minimumRole]) {
      logger.warn(
        { username, operation: parsed.data.operation, repo: parsed.data.repo, role },
        'Transfer ticket request denied: insufficient repo role',
      );
      return c.json(
        { error: `User ${username} lacks ${minimumRole} access to repo ${parsed.data.repo}` },
        403,
      );
    }

    const syncOptions =
      parsed.data.operation === 'push' ? toPushTicketSyncOptions(parsed.data.sync) : null;
    const ticket = await ticketService.issueTicket(
      username,
      parsed.data.operation,
      parsed.data.repo,
      syncOptions,
    );
    logger.info(
      { username, operation: ticket.operation, repo: ticket.repo },
      'Ephemeral transfer ticket issued',
    );

    return c.json(
      {
        ticketId: ticket.id,
        operation: ticket.operation,
        repo: ticket.repo,
        expiresAt: ticket.expiresAt,
        sync: ticket.syncOptions ?? null,
      },
      201,
    );
  });

  app.post('/auth/session-close', async (c) => {
    const username = await authenticate(c.req.header('authorization'), authService);
    if (!username) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const parsed = ticketIdBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body' }, 400);
    }

    try {
      await ticketService.closeTicket(parsed.data.ticketId);
      return c.json({ ok: true }, 200);
    } catch (err) {
      if (err instanceof TicketNotFoundError) {
        return c.json({ error: 'Ticket not found or not active' }, 404);
      }
      throw err;
    }
  });

  return app;
}

export {
  TicketAlreadyConsumedError,
  TicketExpiredError,
  TicketNotFoundError,
  TicketOperationMismatchError,
};
