# Changelog

All notable changes to Deltix-Server are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
