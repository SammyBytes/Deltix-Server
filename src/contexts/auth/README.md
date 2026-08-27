# Context: auth

Local authentication, sliding-window sessions, and Admin user management.

## Fase 5.7

- `LibsqlUserStore` is now the primary source of truth for users (`DELTIX_USER_DB_PATH`).
- `DELTIX_LOCAL_USERS` remains supported as a read-only legacy fallback for login/bootstrap compatibility and logs a deprecation warning at boot.
- `AuthService` now supports first-boot setup, CRUD user management, soft deactivation/reactivation, hard delete guarded by active-session checks, and per-user session analytics.
- Deactivated users are rejected during login with the same generic 401 response as invalid credentials.
- Optional `DELTIX_BOOTSTRAP_ADMIN_USERNAME` + `DELTIX_BOOTSTRAP_ADMIN_PASSWORD` auto-create the first admin at boot and disable `/admin/setup`.

## Fase 5.6 — autorización por repo

- The `auth` context now owns per-repo ACL assignments in the same libSQL user DB via a `repo_roles` table keyed by `(username, repoId)`.
- Supported roles are intentionally simple: `reader`, `writer`, and `admin` only. There is no granular RBAC or per-branch override yet.
- `AuthService` exposes the authorization surface consumed by `versioning` through the public barrel only: `getRepoRole()`, `listRepoRoles()`, `grantRepoRole()`, `revokeRepoRole()`, and `grantRepoAdminToCreator()`.
- Repo creation bootstraps access fail-closed by automatically granting the creator `admin` on the newly provisioned repo; every other repo access requires an explicit assignment.
