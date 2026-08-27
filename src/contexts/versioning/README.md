# Context: versioning

Real Dolt-backed version control per logical repo (Fase 5). Only `index.ts`
from this folder may be imported by other contexts (ACL boundary).

## Fase 5.1 — per-repo Dolt provisioning

`RepoProvisioningService` provisions a real, isolated `dolt init`
repository per logical `repoId`, and persists the `repoId <-> doltPath`
mapping in libSQL via `LibsqlRepoStore` (same pattern as
`contexts/addons`' `LibsqlAddonTrustStore`). Exposed over
`POST/GET /api/v1/versioning/repos` (JWT-authenticated).

`repoId` is validated against `/^[a-zA-Z0-9_-]{1,64}$/` before ever
touching the filesystem or the `dolt` CLI — defense-in-depth against path
traversal / shell injection (OWASP A03), since it becomes a literal path
segment.

## Fase 5.2 — real commits on push

`CommitService.recordPush()` is invoked (via an injected hook, see
`contexts/storage/README.md`) right after a push finishes staging and its
checksum is verified. For a `repo` that has a provisioned Dolt repository,
it:

1. Ensures a `deltix_push_log` table exists inside that repo's own Dolt
   database (`CREATE TABLE IF NOT EXISTS`).
2. Inserts one row (`job_id`, `author`, `checksum`, `pushed_at`).
3. Runs `dolt add -A && dolt commit --author "<pusher> <...>"`.
4. Returns the new commit hash (read back from `dolt_log`).

This deliberately does NOT yet apply the transferred payload as real
application-schema table rows — that requires a real schema/data import
format and is planned for a later sub-phase (see
`docs/decisions/0002-phase-5-versioning-and-user-management.md`). What it
already gives: every push produces a real, queryable
(`dolt sql -q "select * from deltix_push_log"`), tamper-evident Dolt
commit — a verifiable step up from the Fase 3/4 plain-file-copy behavior.

A repo with no provisioned Dolt backend is a legal, backward-compatible
no-op (`recordPush` returns `null`, no commit is created) — pushing still
works exactly as it did before Fase 5.

Dolt is consumed strictly as a black-box binary throughout (`dolt-cli.ts`,
`dolt-commit-cli.ts`) — same convention as
`contexts/licensing/dolt-commit-log.reader.ts`. All dynamic values passed
into `dolt sql -q` are either server-generated (UUID/hex, shape-validated
before interpolation) or sanitized (author name), never raw, unsanitized
user input.

## Fase 5.8 — sync preferences

`LibsqlRepoStore` now persists per-repo sync preferences in the same libSQL
DB as the `repoId <-> doltPath` mapping. `SyncPreferenceService` is the
server-side source of truth for:

- `schema_only` vs `schema_and_data` mode
- requested table subsets per repo
- dry-run previews of FK-closure expansion
- fail-closed rejection when a requested subset excludes FK-required tables

Foreign-key closure is always recomputed server-side from Dolt via
`dolt sql` against `information_schema.KEY_COLUMN_USAGE`; the client may
propose overrides on the transfer-ticket request, but the server never
trusts precomputed client closure data. The REST API is:

- `GET /api/v1/versioning/repos/:repoId/sync-preferences`
- `PUT /api/v1/versioning/repos/:repoId/sync-preferences`
- `POST /api/v1/versioning/repos/:repoId/sync-preferences/dry-run`

During gRPC Push, `storage` invokes an injected `onBeforePush` hook (wired
from `src/index.ts`) so `versioning` can revalidate any ticket override
before a transfer job is committed, without breaking the cross-context ACL
boundary.

## Not yet implemented

- Branching (`dolt branch`/`checkout`), merge/conflicts, log/diff, and
  per-repo/branch authorization — see the ADR for the remaining Fase 5
  sub-phases.
