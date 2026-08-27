/**
 * Factory that wires the transfer context together from validated env
 * vars. Boot-time composition root for this context — nothing else should
 * construct `TicketService`/`LibsqlTicketStore` directly.
 */
import type { Env } from '../../shared/env';
import { LibsqlTicketStore } from './libsql-ticket-store';
import { TicketService } from './ticket.service';

export async function createTicketService(env: Env): Promise<TicketService> {
  const store = new LibsqlTicketStore(env.DELTIX_TICKET_DB_PATH);
  await store.init();
  return new TicketService(store, env.DELTIX_TICKET_TTL_SECONDS);
}
