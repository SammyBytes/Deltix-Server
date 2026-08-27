# Context: admin-ui

Static same-origin Admin Web UI served by Deltix-Server.

## Fase 5.7

- `/admin/setup` exposes the one-time first-boot admin wizard only while the libSQL user store is empty and no bootstrap-admin env vars are configured.
- `/admin` restores sessions via the existing cookie-backed refresh flow, then shows the Users panel plus the existing addon-trust panel.
- The Users panel supports create, deactivate/reactivate, hard delete with explicit confirmation, and active-session seat analytics.
- Guided tours are split by feature with independent localStorage keys: login, setup, addons, and users.
- All scripts remain external same-origin assets (`/admin/app.js`) to satisfy the strict CSP.
