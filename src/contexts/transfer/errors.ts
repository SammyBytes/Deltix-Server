/**
 * Transfer-specific error types. Kept distinct from `contexts/auth/errors.ts`
 * — the two contexts must never import each other's internals (ACL rule).
 * `transfer` only depends on `auth`'s public barrel (`contexts/auth/index.ts`)
 * to verify the caller's JWT session before issuing a ticket.
 */

export class TicketNotFoundError extends Error {
  constructor() {
    super('Ticket not found');
    this.name = 'TicketNotFoundError';
  }
}

export class TicketExpiredError extends Error {
  constructor() {
    super('Ticket has expired');
    this.name = 'TicketExpiredError';
  }
}

/**
 * Thrown when a ticket that has already transitioned out of `issued`
 * (i.e. already `active` or `closed`) is presented again for activation.
 * Tickets are single-use by design — this is the concurrency-safety
 * boundary: only ONE caller may ever win the issued -> active transition.
 */
export class TicketAlreadyConsumedError extends Error {
  constructor() {
    super('Ticket has already been consumed');
    this.name = 'TicketAlreadyConsumedError';
  }
}

/**
 * Thrown when a ticket is presented for an operation or repo it was not
 * issued for. A ticket authorizes exactly one (operation, repo) pair —
 * this prevents a leaked ticket from being repurposed for a different,
 * more sensitive operation.
 */
export class TicketOperationMismatchError extends Error {
  constructor() {
    super('Ticket does not authorize this operation/repo');
    this.name = 'TicketOperationMismatchError';
  }
}

/**
 * Thrown when a ticket is presented for consumption (gRPC Push/Pull) but
 * the issuing user's repo role has since been revoked or downgraded below
 * what the ticket's operation requires. A ticket only proves that
 * authorization held true at ISSUANCE time — without this re-check at
 * CONSUMPTION time, revoking a user's role would not take effect until
 * their already-issued ticket naturally expired (`DELTIX_TICKET_TTL_SECONDS`,
 * renewable via heartbeat), which could be minutes or longer. This closes
 * that fail-open window: every ticket consumption re-validates the
 * caller's CURRENT repo role against the live `repo_roles` table.
 */
export class TicketRoleRevokedError extends Error {
  constructor() {
    super('Repo role required for this ticket has been revoked or downgraded since issuance');
    this.name = 'TicketRoleRevokedError';
  }
}
