import { Hono } from 'hono';
import { z } from 'zod';
import { createLogger } from '../../shared/logger';
import type { AuthService } from '../auth';
import {
  TicketAlreadyConsumedError,
  TicketExpiredError,
  TicketNotFoundError,
  TicketOperationMismatchError,
} from './errors';
import type { TicketService } from './ticket.service';

const logger = createLogger('http:transfer');

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

    const syncOptions = parsed.data.operation === 'push' ? (parsed.data.sync ?? null) : null;
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
