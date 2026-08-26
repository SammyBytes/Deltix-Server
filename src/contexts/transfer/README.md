# Context: transfer

Status: Fase 3 in progress — Ephemeral Tickets implemented; gRPC wire
protocol (:50051) and staging/NAS sync engine land next in this same phase.

Only `index.ts` from this folder may be imported by other contexts (ACL boundary).

## Ephemeral tickets — what and why

A **ticket** is a short-lived (default 120s), single-use credential that
authorizes exactly one `(operation, repo)` pair for a gRPC data transfer.
It is issued ON TOP of an already-authenticated Fase 2 JWT session — never
a replacement for it. Two separate credentials exist for a reason:

- The **JWT access token** (Fase 2) answers "who are you" and lives for
  minutes; it is a general-purpose bearer credential used across the whole
  REST API.
- The **ticket** answers "are you authorized for THIS transfer, right now"
  and lives for 2 minutes; it is scoped to one specific operation and repo.

This is defense-in-depth: a leaked ticket cannot be replayed for a
different operation/repo, cannot be reused after being consumed, and
expires fast even if never explicitly closed. A leaked JWT does not, by
itself, let an attacker start a transfer without also presenting a valid
ticket for that specific transfer.

### Lifecycle

`issued` (via `POST /api/v1/push/ticket`, requires `Authorization: Bearer
<access_token>`) → `active` (consumed exactly once, by the future gRPC
connection handshake) → `closed` (via `POST /api/v1/auth/session-close`) or
`expired` (reaper, if the sliding window lapses with no heartbeat).

### Concurrency & race-condition guarantees

Every state transition (`activate`, `renew`, `close`) is implemented as a
**single atomic conditional SQL UPDATE** (`WHERE status = '<expected>' AND
...`) against libSQL — never a read-then-decide-then-write pair. This is
verified under real parallel load in the test suite: 20-25 concurrent
callers racing to activate/renew the exact same ticket, backed by
independent store instances against the same database file (the realistic
topology for multiple concurrent gRPC connections), with exactly one
winner asserted every time.

### Sliding-window expiration (heartbeat)

Per the Fase 3 guardrail ("EXPIRACIÓN POR INACTIVIDAD — no usar TTL
absoluto"), a ticket's expiry is renewed by a heartbeat from the client
roughly every 30s while a transfer is in progress — mirroring the exact
pattern used for REST auth sessions in Fase 2
(`SlidingWindowSessionManager`). If heartbeats stop (client crash, network
partition), the ticket expires on its own; no explicit cleanup call is
required for correctness (a reaper marks it `expired` for observability).
