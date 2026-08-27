/**
 * Public API of the "transfer" bounded context (Fase 3: Ephemeral Tickets &
 * gRPC Engine). This is the ONLY module other contexts/modules are allowed
 * to import from — see .github/copilot-instructions.md for the ACL
 * boundary rule.
 */
export { createTicketService } from './create-ticket-service';
export {
  TicketAlreadyConsumedError,
  TicketExpiredError,
  TicketNotFoundError,
  TicketOperationMismatchError,
} from './errors';
export { TicketService } from './ticket.service';
export { createTransferRouter } from './transfer.router';
export type { Ticket, TicketStatus, TransferOperation } from './types';
