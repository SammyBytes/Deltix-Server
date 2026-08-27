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

## Fase 5.3 — branching

`BranchService` exposes real branch lifecycle operations on provisioned
repos, backed by the new `dolt-branch-cli.ts` wrapper:

- `runDoltListBranches()` reads `dolt_branches` via `dolt sql` and uses
  `dolt branch` only to determine which branch is currently checked out for
  the working directory used by that repo.
- `runDoltCreateBranch()` shells out to `dolt branch <name>`.
- `runDoltCheckoutBranch()` shells out to `dolt checkout <name>`.
- `runDoltDeleteBranch()` shells out to `dolt branch -d <name>`.
- `runDoltCurrentBranch()` parses the current `* <branch>` marker from the
  real `dolt branch` output.

Branch names are validated server-side against
`/^[A-Za-z0-9_][A-Za-z0-9_.\-/]{0,127}$/`, then additionally rejected if
they contain whitespace, `..`, or leading/trailing `/`. This is
defense-in-depth on top of `Bun.$` argument quoting.

REST API surface (same JWT `authenticate` / `requireUsername` pattern as
existing versioning routes):

- `GET /api/v1/versioning/repos/:repoId/branches`
- `POST /api/v1/versioning/repos/:repoId/branches`
- `GET /api/v1/versioning/repos/:repoId/branches/current`
- `POST /api/v1/versioning/repos/:repoId/branches/:name/checkout`
- `DELETE /api/v1/versioning/repos/:repoId/branches/:name`

Because each provisioned repo has one real working directory, branch
checkout is a filesystem-level mutation. `BranchService` serializes
create/checkout/delete operations per repo with an in-process mutex so a
checkout cannot race another branch mutation on the same repo. Commits keep
recording against whatever branch is currently checked out in that working
directory; `CommitService.recordPush()` itself remains branch-agnostic in
this sub-phase.

Protected-branch rules enforced by the service:

- current checked-out branch cannot be deleted
- `main` cannot be deleted

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

## Fase 5.4 — merge y conflictos

`MergeService` exposes real `dolt merge` operations on provisioned repos,
backed by `dolt-merge-cli.ts`:

- `runDoltMerge()` shells out to `dolt merge <sourceBranch>` and optionally
  checks out an explicit target branch first.
- `runDoltReadConflicts()` reads `dolt_conflicts` plus each
  `dolt_conflicts_<table>` system table and translates raw SQL rows into
  structured JSON.
- `runDoltMergeAbort()` fail-closes conflicted merges by aborting them after
  conflict capture so the repo working tree returns to a clean state.
- `runDoltLatestCommitHash()` reads the post-merge commit hash from
  `dolt_log`.

Conflict payload shape:

- per table: `{ table, count, conflicts }`
- per conflict row:
  `{ fromRootIsh, base, ours, theirs, ourDiffType, theirDiffType, conflictId }`

REST API surface:

- `POST /api/v1/versioning/repos/:repoId/merge`
  with body `{ sourceBranch: string, targetBranch?: string }`

Response outcomes:

- `200 { merge: { status: 'merged', commitHash, fastForward, ... } }`
- `200 { merge: { status: 'up_to_date', ... } }`
- `409 { error, merge: { status: 'conflicted', conflicts: [...] } }`

Merge operations share the exact same per-repo in-memory mutex as branching
via `repo-branch-mutex.ts`, so checkout/create/delete/merge cannot
interleave on the same real Dolt working directory.

## Not yet implemented

- merge/conflicts, log/diff, and per-repo/branch authorization — see the
  ADR for the remaining Fase 5 sub-phases.
