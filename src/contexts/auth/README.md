# Context: auth

Local authentication, sliding-window sessions, and Admin user management.

## Fase 5.7

- `LibsqlUserStore` is now the primary source of truth for users (`DELTIX_USER_DB_PATH`).
- `DELTIX_LOCAL_USERS` remains supported as a read-only legacy fallback for login/bootstrap compatibility and logs a deprecation warning at boot.
- `AuthService` now supports first-boot setup, CRUD user management, soft deactivation/reactivation, hard delete guarded by active-session checks, and per-user session analytics.
- Deactivated users are rejected during login with the same generic 401 response as invalid credentials.
- Optional `DELTIX_BOOTSTRAP_ADMIN_USERNAME` + `DELTIX_BOOTSTRAP_ADMIN_PASSWORD` auto-create the first admin at boot and disable `/admin/setup`.
