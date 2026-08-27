# Changelog

All notable changes to Deltix-Server are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] - 2026-08-27

### Security

- **CRITICAL: RBAC bypass on the gRPC transfer path.** `POST
  /api/v1/transfer/push/ticket` (and the equivalent pull-ticket path) issued
  ephemeral transfer tickets to any authenticated user regardless of their
  repo role, because the gRPC streaming layer trusts any ticket handed to it
  and performs no authorization of its own — the HTTP ticket-issuance
  endpoint was the only place a role check could ever happen, and it had
  none. A user with only `reader` access to a repo could therefore push
  (write) to it. Fixed by adding a `MINIMUM_ROLE_FOR_OPERATION` map
  (`push` -> `writer`, `pull` -> `reader`) checked via the existing
  `authService.getRepoRole()` before any ticket is issued; insufficient or
  missing role now returns `403` and no ticket is created. Added explicit
  regression-guard tests asserting a `reader` can never obtain a push
  ticket.

### Fixed

- **Sync-preference `dry-run` ignored the stored preference mode.** Root
  cause was actually in Deltix-Client (see its own changelog): the CLI's
  `sync-prefs dry-run` subcommand hardcoded `schema_and_data` instead of
  reading the previously saved mode, risking unexpected full-data dry-runs
  against a repo explicitly configured for `schema_only` sync.
- **Sync-preference timestamps were always reported as `0`.**
  `GET /api/v1/repos/:repo/sync-preferences` returned `createdAt: 0,
  updatedAt: 0` for every repo instead of the real values, because
  `RepoSyncPreferenceSummary` never carried timestamps and the libSQL store
  never read the `created_at`/`updated_at` columns it already persisted.
  Both are now read from storage and returned as-is, restoring audit
  traceability for sync-preference changes.

## [0.2.1] - 2026-08-27

### Fixed

- **Orphaned-repo admin lockout**: a repo left with zero role assignments (e.g.
  provisioned before per-repo authorization existed, or via any path that
  bypassed `POST /repos`) had no self-service recovery — fail-closed access
  control meant nobody, not even the bootstrap admin, could grant themselves
  a role. `AuthService.backfillOrphanedRepoAdmin` now runs at boot for every
  repo when `DELTIX_BOOTSTRAP_ADMIN_USERNAME` is set, granting admin only to
  repos with **zero** existing roles — an already-governed repo is always
  left untouched. Each repo is backfilled independently so a single
  problematic repo can never abort the whole boot sequence.

## [0.2.0] - 2026-08-27

### Added — Fase 5: Dolt-backed versioning

- **5.1 Repo provisioning**: real per-repo Dolt repositories are created and managed
  on disk instead of a single shared repo; new `versioning` bounded context and
  REST endpoints under `/api/v1/repos`.
- **5.2 Commit recording**: pushes now record real, immutable Dolt commits instead
  of just staging data — the commit graph is the source of truth for history.
- **5.3 Branching**: full branch lifecycle over the real `dolt` CLI — list, create,
  checkout, delete, and "current branch" endpoints.
- **5.4 Merge & conflicts**: branch merge endpoint with real conflict detection and
  reporting, backed by Dolt's native merge behavior.
- **5.5 Log & diff**: endpoints to inspect commit history (`log`) and compare two
  refs (`diff`) for a repo.
- **5.6 Per-repo/branch authorization**: role-based access control (reader/writer/
  admin) scoped per repository, enforced via `repo_roles` in LibSQL with a foreign
  key to the `users` table; the creator of a repo is auto-granted `admin`.
  Fail-closed by default — no role means no access.
- **5.7 First-boot user management**: bootstrap-admin creation on first boot
  (`DELTIX_BOOTSTRAP_ADMIN_USERNAME`/`DELTIX_BOOTSTRAP_ADMIN_PASSWORD`) plus Admin
  Web UI screens to create, disable, and manage other users and their addon access
  without needing direct database access.
- **5.8 Sync preferences**: per-repo, per-user preferences for schema-only vs.
  schema-and-data sync, and selectable table scope. Selecting a table automatically
  includes its related tables (via foreign keys) to avoid partial/corrupt syncs.
  Includes a dry-run endpoint to preview the resulting table set before syncing.
- Admin Web UI: onboarding flow with Driver.js guided tours, and screens for user
  creation/removal, addon access management, and sync preference configuration.
- ADRs documenting the Fase 5 design decisions and the UI/UX onboarding plan.

### Fixed

- Removed an accidental `passwordHash` leak in an API response introduced during
  branching work (Fase 5.3 follow-up).
- Resolved TypeScript errors introduced by the Fase 5.6 authorization work
  (undefined `repoId` guards, `exactOptionalPropertyTypes` widening, unsafe union
  narrowing in tests).
- Replaced a hardcoded scratch path in the LibSQL user store test with a real
  temp directory (`tmpdir()`), avoiding local/CI path collisions.

### Changed

- Dependabot-managed CI action version bumps (`actions/checkout`, `docker/*`).

## [0.1.0] - Fase 1-4

- Initial scaffolding, licensing/anti-tamper (Ed25519), REST auth control plane,
  ephemeral transfer tickets + gRPC transfer engine, dynamic license-gated addon
  loading.
