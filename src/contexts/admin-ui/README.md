# Context: admin-ui

Static same-origin Admin Web UI served by Deltix-Server.

## Fase 5.7

- `/admin/setup` exposes the one-time first-boot admin wizard only while the libSQL user store is empty and no bootstrap-admin env vars are configured.
- `/admin` restores sessions via the existing cookie-backed refresh flow, then shows the Users panel plus the existing addon-trust panel.
- The Users panel supports create, deactivate/reactivate, hard delete with explicit confirmation, and active-session seat analytics.
- Guided tours are split by feature with independent localStorage keys: login, setup, addons, and users.
- All scripts remain external same-origin assets (`/admin/app.js`) to satisfy the strict CSP.

## Global admin gating (v0.3.0)

- `/admin` is now visually gated client-side by `applyGlobalAdminGating()` in `app.js`: the
  Users, Repository roles, and Add-ons panels only render for a caller whose `isGlobalAdmin`
  flag (returned at login/`/refresh`) is `true`. Everyone else sees a short "not admin" notice
  instead. This is a UX convenience only — the real enforcement lives server-side (every
  underlying endpoint independently rejects non-global-admins with 403), so hiding the panel
  is never the only line of defense.
- New **Repository roles** panel: pick a repo from the existing `/api/v1/versioning/repos`
  list, then view/grant/revoke `reader`/`writer`/`admin` roles for that one repo via the
  existing `/api/v1/versioning/repos/:repoId/roles` endpoints. This is deliberately the same
  per-repo role system the CLI already used (`deltix roles grant/revoke/list`) — the panel is
  just a UI on top of it, not a new authorization model.
- **Global admin is not the same thing as a repo `admin` role.** Global admin is one
  account-wide flag that gates the Admin Web UI and user/add-on management; a repo `admin`
  role only controls one repository and never implies global admin access. See
  `.github/copilot-instructions.md` for the full rationale.
