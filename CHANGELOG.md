# Changelog

All notable changes to Deltix-Server are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each entry starts with a **plain-language summary** (what changed, in
everyday words) before any technical detail — written so someone outside
engineering can understand what shipped and why it matters.

## [0.8.6] - 2026-08-31

**In plain terms:** the refresh-token session lifetime now defaults to
**7 days** instead of 2 hours. Combined with the v0.7.10 access-token
auto-refresh, operators can leave for a long weekend and still be
logged in when they come back.

### Changed

- **`DELTIX_SESSION_TTL_SECONDS` default raised from 120 (2 h) to
  604800 (7 d).** This is the sliding-window inactivity window for the
  refresh token. Every `/refresh` call (which the CLI does every time
  it needs an access token) slides the window out to 7 days from that
  point, so an active operator effectively stays logged in forever.
  Inactive operators still get booted after 7 days, which matches the
  realistic security-vs-convenience tradeoff for a CLI tool.
  Override via the env var to dial it back for higher-security
  installations.

## [0.8.5] - 2026-08-31

**In plain terms:** `deltix push` no longer crashes the server when the
source DB had rows with empty strings inside DATETIME / DATE / NUMERIC
columns (a common artifact of MySQL running with permissive sql_mode).

### Fixed

- **Push crashed the server with `Incorrect datetime value: ''`** when a
  row had an empty string in a typed column. The server was building
  per-row `INSERT INTO ... VALUES (...)` statements, so any empty string
  landed in the SQL literally — and Dolt rejects `''` for non-string
  column types. Switched the row-loading step to `dolt table import -r`
  (the same command the client uses locally), which uses Dolt's own CSV
  parser with proper type coercion. Also dramatically faster for tables
  with thousands of rows — one subprocess per table instead of one per row.

## [0.8.4] - 2026-08-31

**In plain terms:** `deltix push` returned 500 on every push because
the server's router referenced an error class that wasn't imported.
Crash with `ReferenceError: CommitImportError is not defined`.
Now it imports the class.

### Fixed

- **`deltix push` returned 500 from the server with
  `ReferenceError: CommitImportError is not defined`.** The push-commits
  router caught `instanceof CommitImportError` but never imported the
  class. Every push hit a `ReferenceError`, which the framework
  reported as a generic 500. Tests didn't catch it because no test
  exercised the actual push path with that error type.
  Fix: add `CommitImportError` to the named-import block.

## [0.8.3] - 2026-08-31

**In plain terms:** global admins now have full access to every repo by
default — no more having to ask themselves "please grant me reader
access to the repo I just created, from the other account I happen to be
logged in as".

### Changed

- **Global admins get implicit `admin` access to every repo.** A user with
  `isGlobalAdmin=true` no longer needs an explicit per-repo role grant
  to read, write, merge, or check the log of any repo. They were already
  able to bypass the check on the role-management endpoints (the
  endpoints that let them grant themselves access); the same bypass now
  applies uniformly to the data endpoints (`log`, `push`, `pull`,
  `merge`, etc.) that the role-management endpoints are supposed to
  protect. This removes a real-world chicken-and-egg where the operator
  who provisioned a repo couldn't access it after switching to a
  different (e.g. human) account for daily use.

## [0.8.2] - 2026-08-31

**In plain terms:** `deltix repo create` (and any operation that internally
calls `dolt init` for a freshly-provisioned repo) used to fail with a
generic 500 on every install, hiding the real cause: the systemd service
user had no Dolt identity configured, so every `dolt init` exited with
"empty ident name not allowed". The error is now reported back to the
client verbatim, AND the installer always sets up the service user's
identity (not just on a brand-new install, and not just for root).

### Fixed

- **`POST /api/v1/versioning/repos` returned a generic `Failed to
  provision repo` 500** when the underlying `dolt init` exited non-zero,
  forcing operators to dig through `journalctl` to find the real cause
  (dolt missing from PATH, permissions, identity, etc.). The router now
  returns the underlying `err.message` instead, so the same request that
  used to say only `Failed to provision repo` will now say
  `Failed to provision Dolt repo for "X": dolt init exited with code 1:
  <stderr>`. Server-side log line unchanged (`logger.error({ err }, ...)`).

- **`scripts/install.sh` did not configure a Dolt identity for the
  systemd service user.** Two compounding mistakes: the
  `dolt config --global` calls only ran inside the first-install block
  (`if [ ! -f "${ENV_FILE}" ]`), so reinstall/upgrade paths never
  re-asserted the identity; AND they ran as root (install.sh's UID), so
  the identity landed in `/root/.doltconfig` instead of
  `/var/lib/deltix/.doltconfig` where the service actually looks.
  Fix: a new `ensure_dolt_identity_for_service_user()` function runs
  after the data-dir chown on every install, as
  `sudo -u "${SERVICE_USER}" -H dolt config --global --add ...`. Idempotent.
  The in-if-block root identity config (for the one-time `dolt init` of
  the anti-tamper license log) is kept as-is, with the license-log dir
  chowned to the service user first so the next `dolt init` runs with
  the right ownership.

### Tests

- 277 unit tests pass; lint clean.

## [0.8.1] - 2026-08-29

**In plain terms:** the Admin UI now lets an administrator decide, per person,
who is allowed to create new repositories — a simple toggle in the Users panel.
(The commit-based push/pull server work from 0.8.0 is unchanged; this release
simply ships the admin-UI permission toggle, which landed after 0.8.0 was cut.)

### Added

- **Admin UI — per-user "Can Create Repos" toggle (Fase 5.9).** The Users panel
  gained a column and a row action that grants/revokes the `canCreateRepos`
  permission on a specific user, via the existing
  `POST`/`DELETE /api/v1/auth/users/:username/can-create-repos` endpoints. This
  is managed at the *user* level (a person's ability to open new repos), not at
  the repository level. Global admins always bypass the check.

### Tests

- 277 unit tests + admin-ui unit + admin-user-management smoke pass; build +
  lint clean.

## [0.8.0] - 2026-08-29

**In plain terms:** this release adds the *other half* of the Git-like loop: a
way for the server to hand commits back to a client so `deltix pull` works. A
client can now ask the server "which commits am I missing?" and receive them as
a stream, one per line, ready to apply locally. It also fixes a real bug in the
push path: pushing a brand-new table used to fail because the server tried to
empty a table that didn't exist yet — now each table is recreated faithfully
from its definition (including its primary key), so first pushes land correctly.

### Added

- **`GET /api/v1/versioning/repos/:repoId/pull-commits?branch=&from=` (Fase 5.9).**
  Streams the commits on a branch that a client hasn't seen yet as
  `application/x-ndjson` (one commit per line: `{hash, message, author,
  tables:[{name, schema, data}]}`), with the branch head in an
  `X-Deltix-Server-Head` response header. Reader role enforced per repo. Served
  as a true stream so a first clone of a large repo stays flat in memory.
  Implemented via the new `CommitExportService` + `dolt-commit-export-cli.ts`
  (enumerates `dolt_log AS OF <branch>`, changed tables via
  `dolt diff --name-only <hash>^..<hash>`, data via `SELECT * FROM t AS OF
  <hash>`).
- **`GET /api/v1/versioning/repos/:repoId/refs` (Fase 5.9).** Returns the
  repo's `branch -> head` map so a client can negotiate what to fetch (like
  `git ls-remote`).

### Fixed

- **Pushing a new table failed (Fase 5.9).** `push-commits` imported each table
  with `TRUNCATE TABLE` before loading, which errors when the table doesn't
  exist yet — i.e. the normal first push that *creates* a table. The commit
  payload now carries each table's `CREATE TABLE` DDL (`dolt schema export`);
  import creates the table from that DDL (falling back to `TRUNCATE` on a
  re-push) and reloads rows, so primary keys and column types survive the round
  trip. A bare CSV cannot carry a primary key, which is why the schema ships
  alongside the data.

### Tests

- 277 unit + integration tests pass. New: `CommitExportService` unit suite
  (fakes) and a real-Dolt integration test for the export endpoints (refs,
  NDJSON streaming with the head header, `from` filtering, 401 on
  unauthenticated).

## [0.7.0] - 2026-08-29

**In plain terms:** three big steps toward a "Git for databases" workflow.
(1) When you push only some of your tables, the server now commits exactly
those tables — including any tables they depend on — instead of everything in
the database. (2) The company owner can now decide **who is allowed to create
new repositories**: a new per-user permission controls it, and the first time
someone with that permission pushes to a repository that doesn't exist yet, the
server creates it automatically and makes them its owner (like GitHub creating
a repo on first push). (3) A new REST endpoint accepts structured commits
directly, so a client can send "here are my commits and their table data"
instead of uploading raw files. Without the permission, a push to an unknown
repository is rejected and the user's data simply stays local.

### Added

- **`POST /api/v1/versioning/repos/:repoId/push-commits` (Fase 4b).** Accepts
  a JSON body `{ commits: [{ message, author, tables: [{ name, data }] }] }`,
  verifies the caller holds `writer`/`admin` on the repo (403 otherwise),
  imports each commit's CSV table data (truncate + insert), and creates a real
  Dolt commit per entry with the original message and author. Implemented via
  the new `CommitImportService` + `dolt-commit-import-cli.ts`.
- **`canCreateRepos` per-user flag (Fase 4a).** Global admins grant/revoke it
  via `POST`/`DELETE /api/v1/auth/users/:username/can-create-repos`; it is
  returned by login/refresh and listed in `GET /users`. Global admins always
  bypass the check.
- **Auto-creation of repos on first push (Fase 4a).** In the gRPC `onBeforePush`
  hook, a push to a repo that doesn't exist yet provisions it (Dolt backend +
  role grant to the pusher) when the user holds `canCreateRepos`; otherwise the
  push is aborted with a clear message and nothing is staged.

### Changed

- **Push commits honor the sync-pref table allow-list (Fase 3c).** The
  FK-closed `resolvedTables` set computed during sync validation now flows
  through `onBeforePush` → `onPushCommitted` → `CommitService.recordPush` →
  `runDoltCommit`, which stages exactly those tables (`dolt add <tables>`)
  instead of `dolt add -A`. With no sync prefs configured, behavior is
  unchanged (full working tree).
- **Dry-run previews no longer fail closed (Fase 3c).**
  `SyncPreferenceService.preview()` (and therefore
  `POST /repos/:repoId/sync-preferences/dry-run`) returns the full plan —
  `resolvedTables` plus `autoIncludedTables` — instead of throwing 409 when a
  requested subset pulls in FK dependencies. Persisting (`PUT`) and real pushes
  still reject an incomplete closure; the point of a dry run is to *show* what
  would be auto-included.

### Security

- **Repo creation is permission-gated (Fase 4a).** `POST /repos` returns 403
  unless the caller is a global admin or holds `canCreateRepos`. Combined with
  the push path, creating repositories is now an explicitly-granted capability,
  not something any authenticated user can do.
- **push-commits enforces repo membership (Fase 4b).** The endpoint checks the
  caller's per-repo role (`writer`/`admin`) before importing anything; table
  names are validated against a strict identifier regex and author names are
  sanitized before reaching the Dolt CLI (OWASP A03).

### Removed

- **Dead code (Fase 3c):** `LibsqlSyncPreferenceStore` and the
  `SyncPreferenceStore` interface — sync preferences have been persisted
  through `LibsqlRepoStore` since Fase 5.8 and nothing referenced the old store.

### Tests

- 271 unit + 117 integration tests pass. New: `CommitImportService` suite
  (import, multi-commit, skip-empty, unknown-repo, empty-batch), 9
  `canCreateRepos` auth-service tests (login/refresh flag, toggle, admin
  bypass, fail-closed for unknown users), and updated dry-run tests asserting
  the resolved plan (transitive FK closure `orders → customers → regions`)
  instead of a 409 throw.

## [0.6.16] - 2026-08-29

**In plain terms:** the CLI trusts one certificate and uses it to validate
both the HTTP control-plane (login) and the gRPC data-plane (push/pull). But
`install.sh` had been generating two *different* self-signed certificates --
one for HTTP and a separate one for gRPC -- so after `deltix configure`
trusted the gRPC cert, `deltix login` failed with `self signed certificate`
(and, without the `NODE_TLS_REJECT_UNAUTHORIZED=0` env var being set,
everything over HTTP broke). The installer now makes both ports present the
identical certificate and repairs existing installs whose certs differ.

### Fixed

- **`deltix login` / `deltix push` failed with `self signed certificate`
  whenever `NODE_TLS_REJECT_UNAUTHORIZED=0` was not set.** The HTTP control
  plane (cert `certs/server.crt`) and the gRPC transfer engine (cert
  `certs/grpc/server.crt`) were serving *separate* self-signed certificates.
  `deltix configure` fetches and trusts a single cert (from the gRPC port)
  and the CLI validates the HTTP control plane with that same CA, so the very
  first HTTP call (`login`, ticket issuance) rejected the mismatched HTTP
  cert. This had gone unnoticed during testing because the insecure
  `NODE_TLS_REJECT_UNAUTHORIZED=0` env var masks it. In `self-signed` mode
  `install.sh` now reuses the HTTP cert for the gRPC engine, and repairs an
  existing install whenever the two are detected to differ (via `cmp`), so one
  trusted cert works for both ports. The auto-detected hostname/SAN behavior
  is unchanged.

## [0.6.15] - 2026-08-28

**In plain terms:** if an operator removed the server's certificate files (for
example to force fresh ones, or as part of a cleanup) the service would go
into an endless restart loop and never come back up, because the internal
encrypted data-transfer certificate wasn't recreated. Updates now detect when
that certificate is missing and create it again automatically, so the service
comes back up on the next install run instead of crash-looping.

### Fixed

- **Server crash-looped with `ENOENT .../certs/grpc/server.crt` after the
  certificate files were deleted.** The gRPC transfer engine's TLS cert was
  only generated on the very first installation (guarded by `deltix.env` not
  existing), so on an upgrade — or after an operator wiped
  `${DATA_DIR}/certs` to force new certs — the data plane cert was never
  recreated. `bindGrpcTransferServer` then failed at boot with
  `ENOENT: /var/lib/deltix/certs/grpc/server.crt` and the service crashed in
  a restart loop. `install.sh` now regenerates the gRPC cert whenever either
  `server.crt` or `server.key` is missing — not just on first install —
  while retaining an existing valid cert on normal upgrades (no churn). The
  regenerated cert keeps the same auto-detected hostname/SAN behavior as the
  HTTP cert (bare-IP servers get their machine hostname added as a DNS name).

## [0.6.14] - 2026-08-28

**In plain terms:** if a company's Deltix server lives at a bare IP address
(no hostname), the client couldn't successfully push or pull files to it over
TLS — the transfer started but was rejected at the security handshake, and the
login screen worked but the actual data transfer never did. The server now
automatically names each certificate with its own hostname (in addition to its
IP) and the client setup detects and suggests that name, so a client pointed
at any company's server can verify its certificate out of the box — without
anyone hard-coding an address or guessing a name.

### Fixed

- **Bare-IP servers could not be used over gRPC (Drive/Transfer) TLS.**
  When a server is reached only by its IP (the common internal/air-gapped
  shape) the generated certificate previously carried only the IP in its
  Subject/Subject-Alternative-Name. Node/gRPC and Bun refuse to use an IP as
  a TLS server name (they throw `ERR_INVALID_ARG_VALUE: Setting the TLS
  ServerName to an IP address is not permitted`), so any `deltix push/pull`
  failed with `DEPTH_ZERO_SELF_SIGNED_CERT` even after the CA was trusted —
  the login (REST) worked, the data plane didn't. The certificate generator
  and `install.sh` now add a real, machine-specific DNS-style name to the SAN
  of every certificate generated for a bare-IP host: this host's FQDN (or
  short hostname), which is unique per server and present on every company's
  box with zero configuration. An operator can still pin a specific name via
  `TLS_SERVER_NAME_OVERRIDE` when their network has one in mind. The chosen
  name is persisted in `.tls-state` and printed at cert generation so
  operators know what to tell their clients.

### Changed

- `scripts/generate-server-tls-cert.ts` now derives the host's DNS name
  (`node:os` hostname, or an explicit extra SAN) whenever the requested
  identity is a bare IP, and prints the server-name override clients should
  use. `scripts/install.sh` passes the detected name to both the HTTP and
  gRPC certificate generations and records it in the TLS state file.

## [0.6.13] - 2026-08-28

**In plain terms:** upgrading the server on an existing machine that had TLS
enabled could abort with a "variable unbound" error at the very start of the
installer, before it even asked you anything — and once it crashed, the
installation never continued. The installer now tolerates a previous
configuration that didn't record every TLS detail, and proceeds normally.

### Fixed

- **Installer aborted with `PREV_TLS[hostname]: unbound variable` when a
  previous TLS configuration was present but didn't record a server
  hostname.** The upgrade path reads the persisted TLS state written by
  v0.6.11 and re-offers those paths. Under `set -u`, dereferencing a
  persisted TLS state key that simply isn't present in the state file
  (an older state file, or one written before hostname capture) made the
  whole script exit with an unbound-variable error at line 254, before any
  prompt. The lookups now use guarded `${PREV_TLS[key]:-}` defaults (the same
  pattern already used for `mode`), so a missing key is treated as
  "not recorded" rather than a hard crash. Reproduced the exact failures:
  the pre-fix script aborts with the same unbound-variable error, and the
  post-fix script runs to completion with a full unit suite and lint clean.

## [0.6.12] - 2026-08-28

**In plain terms:** if you left the Admin Web UI open for a while and then
tried to manage users — create, delete, revoke a role, or deactivate an
account — nothing worked, even though you were the global administrator. The
buttons weren't broken: the server's login "key" expires automatically after
about 15 minutes, and the admin page was never renewing it on its own. After
that, every request the page made was rejected as no-longer-authorized. The
admin page now quietly renews that key in the background before it expires, so
your session keeps working as long as you're signed in — no more mystery
"everything stopped working" a quarter of an hour after logging in.

### Fixed

- **Admin session silently died ~15 minutes after login, breaking every
  management action**: the server issues an access token that expires after
  `accessTokenTtlSeconds` (default 900s / 15 min), while the frontend obtained
  it once at login/refresh and never renewed it during the session. Once the
  token lapsed, every authenticated call — `POST/DELETE users`, repo role
  grant/revoke, deactivate, global-admin toggle, etc. — returned 401, so a
  logged-in global admin was suddenly "unable to do anything" until they
  logged out and back in. `showSession()` now arms a `scheduleTokenRenewal()`
  timer that calls `POST /api/v1/auth/refresh` well before the access token
  expires (and more often than the sliding session timeout), minting a fresh
  token and sliding the HttpOnly session so the operator stays authorized
  indefinitely while signed in. Renewal is stopped on logout (`showForm`),
  and if a refresh fails transiently it retries shortly after.

### Tests

- Extended `tests/unit/admin-ui/app-data-load.test.ts`: after login a renewal
  timeout is scheduled; firing it issues `POST /api/v1/auth/refresh` and
  schedules a fresh renewal timer. Against v0.6.10 (no renewer) this test
  FAILS — no renewal timer exists — and against this release it PASSES. Suite:
  265 pass / 0 fail; lint clean.

## [0.6.11] - 2026-08-28

**In plain terms:** upgrading the server no longer makes you re-type your
TLS certificate paths every single time. If you already configured a
certificate once (either your own files or one the installer generated), the
installer remembers those paths and, on the next upgrade, asks if you want to
just reuse what's already there instead of entering the full paths by hand
again. The remembered paths are shown in plain sight so you can confirm or
change them in one step.

### Added

- **TLS certificate paths persist across upgrades**: `scripts/install.sh`
  now writes a small state file (`/etc/deltix/.tls-state`) when TLS
  credentials are configured — recording the TLS mode (self-signed or
  existing) and the certificate/key paths (and, for self-signed, the
  hostname/IP). On the next run the installer loads that state and offers the
  previously used paths as the default.
- **Interactive wizard offers to reuse remembered credentials**: when you
  choose "Existing certificate" (option 3) on a machine that already has a
  saved configuration, the wizard now shows the remembered cert and key paths
  and asks "Reuse these paths, or enter new ones?" — pressing `r` (or Enter
  on the now-defaulted option) reuses them. No more retyping absolute paths
  on every update. For self-signed setups, the remembered hostname/IP is also
  offered as the default.
- **Upgrade-safe defaults**: if a TLS mode was already persisted, re-running
  the installer keeps it as the default for the "Choose" prompt instead of
  silently defaulting back to plain HTTP, so an upgrade can never accidentally
  tear down an existing HTTPS setup. Explicitly choosing another option (or an
  env var like `TLS_MODE`) still overrides it, and unattended runs pick up the
  saved paths automatically without prompting.

### Tests

- Validated the new state logic with an isolated harness: empty state falls
  back to `none`; writing and reloading the state file preserves mode, cert
  and key paths (and hostname); the "reuse" branch restores the remembered
  paths; and `TLS_MODE=none` never writes a state file. `install.sh` and
  `get-deltix.sh` pass `bash -n` after the change.

## [0.6.10] - 2026-08-28

**In plain terms:** two Admin Web UI issues are fixed here. First, the
"active sessions" and seat counters were only a snapshot from when you logged
in (or last did an action) — if someone else signed in or out, the numbers
stayed stale until you reloaded. The dashboard now refreshes those numbers
on its own every few seconds and whenever the browser tab regains focus.
Second, accounts that are not global administrators could see visual glitches
on the dashboard: a broken cross-fade animation right after signing in, and
navigation tabs for restricted admin screens that, when clicked, showed blank
panels. The glitchy animation source was removed and, for regular accounts,
the admin-only tabs are now hidden entirely — they only see what they can
actually use.

### Fixed

- **Active-session counters stayed stale until the next action/reload**:
  `user.activeSessions`, the seat usage indicator and the dashboard tiles
  (`Users & Active Seats`, repos, add-ons) were only fetched on login or after
  a write action. A new `startLiveRefresh()` mechanism re-fetches
  `loadUsers`/`loadTrustedAddons`/`loadReposAndDirectory` every 15 seconds
  while a session is open, and immediately when the browser tab regains focus
  or becomes visible again — so other operators' logins/logouts show up in
  near real time. It stops on logout (`showForm`) so nothing polls a closed
  session.
- **Visual glitch on login from the CSS view transition**: `#tab-panel` had
  `view-transition-name: tab-panel`. Because `#session-panel` starts
  `display:none` on the login screen, Chromium had to capture the named panel
  while it had no rendered box, which produced broken/blank snapshots during
  the login cross-fade. The inline `view-transition-name` was removed; the
  page-level fade still runs cleanly as a single root group.
- **Onboarding tour highlights pointed at hidden elements on first login**: the
  dashboard/add-ons/users tours ran synchronously in `showSession()` — i.e.
  possibly before Chromium's one-frame-deferred view-transition callback had
  revealed the session panel — so the tour overlay anchored to elements that
  were still hidden and rendered as a glitch. Tours are now scheduled only
  after the view transition finishes (`withViewTransition` returns a promise).
- **Regular (non-global-admin) accounts saw admin-only tabs that led to blank
  panels**: the "Repositories & Roles", "User Management" and "Community
  Add-ons" nav buttons stayed visible even though the underlying screens were
  gated off. `applyGlobalAdminGating()` now also hides those three nav buttons
  for non-admins (plus the "Standard Operator Session" notice), leaving only
  the tabs they can actually use.

### Tests

- Extended `tests/unit/admin-ui/app-data-load.test.ts`: asserts a 15s live-refresh
  interval is installed on login and re-fetches the user list on each tick, and
  that the admin-only nav tabs are hidden for non-admins but visible for global
  admins (with the operator notice shown/hidden accordingly). Runs the real
  `app.js` through the deferred view-transition DOM harness. Suite: 264 pass /
  0 fail; lint clean for the changed test file.

## [0.6.9] - 2026-08-28

**In plain terms:** the previous fix for the empty-tables-after-login bug
turned out to be incomplete. The dashboard could still show empty tables
right after you logged in — again for exactly the same symptom (data only
reappearing after a write action) — but this time the cause was different and
even sneakier: modern Chrome/Edge defer the page's fancy cross-fade animation
for one frame, and the code decided whether to load your data *while that
animation was still pending*, so it never did. This release makes the data
load independent of the animation timing and adds a regression test that
reproduces the exact Chrome timing behaviour.

### Fixed

- **Dashboard still loaded empty in real Chrome/Edge even though the v0.6.8
  fix was in place**: `showSession()` set `currentIsGlobalAdmin` inside the
  `document.startViewTransition()` update callback, but Chromium defers that
  callback by one frame. The synchronous `if (currentIsGlobalAdmin)` that
  guards the initial data load therefore ran while the flag was still `false`,
  skipping `loadUsers`/`loadTrustedAddons`/`loadReposAndDirectory` entirely
  until a later write retriggered a fetch. The `#hash` tab navigation also
  started a *second* view transition while the first was still active, which
  Chromium aborts with `AbortError: Transition was skipped`. Now the session
  state is committed synchronously *before* the (purely visual) view
  transition, the hash-based tab switch toggles the tab directly instead of
  starting a nested transition, and `withViewTransition` also swallows the
  `updateCallbackDone`/`ready` rejections that Chromium fires for
  skipped/interrupted transitions — so a cosmetic animation can never block
  the data load again (in any browser).
- **Logout could be affected by the same timing race**: `showForm()` also
  cleared the session state inside the deferred transition callback; the state
  is now reset synchronously before the visual transition.

### Tests

- Added `tests/unit/admin-ui/app-data-load.test.ts`, which runs the real
  `app.js` through a DOM harness with a **deferred** `startViewTransition`
  (reproducing Chromium's one-frame delay) and asserts the initial data
  fetches fire after login. Against v0.6.8 the deferred-mode test FAILS with
  only `POST /api/v1/auth/login` observed — the exact user symptom; against
  this release it PASSES in both deferred and synchronous modes. Unit suite:
  261 pass / 0 fail; lint clean for the changed files.

## [0.6.8] - 2026-08-28

**In plain terms:** a serious bug could leave the Admin Web UI showing empty
tables right after you logged in — the user list, repositories, and add-ons
all looked blank — even though the data was safely stored. The data did not
actually disappear: it only reappeared after you performed an action (like
registering a user or repo). This release fixes that so the dashboard always
loads your existing data on login.

### Fixed

- **Dashboard tabs stayed empty after login until the next write**: in
  `showSession()` the initial data load (`loadUsers`, `loadTrustedAddons`,
  `loadReposAndDirectory`) ran *after* a call to start the dashboard
  onboarding tour (`maybeRunDashboardTour`). If the tour library (`driver.js`)
  threw for any reason, the exception aborted the rest of the function and the
  initial data load never happened — so a healthy admin was shown empty tables
  until a later write action re-triggered a fetch. Data loading now runs
  first, and every non-essential (tour) step is wrapped in `runNonCritical()`
  so a cosmetic failure can never block the critical data loads.

### Tests

- Added a reproduction harness that loads the real `app.js` with a
  `driver.js` tour that throws on login: pre-fix it shows `/auth/users` is
  never requested (FAIL); post-fix `/auth/users` fires (PASS) even when the
  tour errors. Verified with Bun locally; lint 0 errors; unit 259 pass / 0
  fail; smoke 34 pass / 0 fail.

## [0.6.7] - 2026-08-28

**In plain terms:** the Admin Web UI page now asks the browser for its own
script using a versioned address (`/admin/app.js?v=0.6.7`). This guarantees
that after you update the server, every browser — even one that ignored the
no-cache headers — is forced to load the brand-new user-interface script and
never keep running an old copy of the dashboard code that rendered empty
tables. It also finally stops the recurring "I upgraded but the UI didn't
change" confusion.

### Fixed

- **Admin UI asset versioning**: `login.html` and `setup.html` referenced
  `/admin/app.js` with no version marker. The pages are now assembled with a
  `?v=<package version>` suffix at serve time, so the UI script is
  cache-busted per release and can never be served stale across an upgrade.

### Tests

- Verified the asset URL substitution resolves to `?v=<version>`; lint 0
  errors; unit 259 pass / 0 fail.

## [0.6.6] - 2026-08-28

**In plain terms:** the server's health-check command kept reporting the HTTP
and gRPC ports as "FAILED — already in use" on a healthy production machine.
That was misleading: in a normal running system those ports are *supposed* to
be occupied — by the Deltix server itself. The doctor now recognizes that the
running `deltix.service` owns those ports and reports them as passed, with a
note explaining the port is held by the service (the healthy production
state). Only a genuinely foreign process holding the port is now flagged.

### Fixed

- **Doctor reported the service's own ports as failures**: `runDoctorSuite`
  treated any occupied port as a conflict. It now checks whether
  `deltix.service` is active (Linux, systemd) and, when the port is held by
  the running Deltix service, reports `PASS` with an explanatory note instead
  of a `FAIL` with `ERR_HTTP_PORT_IN_USE` / `ERR_GRPC_PORT_IN_USE`. The strict
  failure path still triggers if a foreign process is listening while Deltix
  is not running.

### Tests

- Manual: `doctor` in dev still reports 9 passed / 0 failures with free
  ports; lint 0 errors, unit 259 pass / 0 fail.

## [0.6.5] - 2026-08-28

**In plain terms:** this patch makes the server's diagnostic commands tell the
truth on a production machine. When you logged into the server and ran the
health-check command by hand, it looked at the wrong folders and databases —
it reported "permission denied" and "database missing" that weren't real, and
it even created stray keys in the source directory. It now automatically
reads the server's real configuration file (the same one the running service
uses), so its checks examine the actual data directories and report only real
problems.

### Fixed

- **Diagnostic CLI ignored the production environment file**: the running
  service loads `/etc/deltix/deltix.env` (via systemd `EnvironmentFile`), but
  the CLI run by an operator — `bun run src/cli/commands.ts doctor` — did not,
  so it analyzed the source-tree defaults (`./data/...`) instead of the real
  deployment paths (`/var/lib/deltix/...`). On a real install this produced
  misleading check results (EACCES on `/opt/deltix/data`, "database file
  missing", keys regenerated under the app directory). `loadProductionEnvFile`
  now merges `/etc/deltix/deltix.env` (or `$DELTIX_ENV_FILE`) into `Bun.env`
  at CLI startup, mirroring systemd's behavior; existing environment variables
  are never overwritten, and the feature is a no-op where the file does not
  exist (dev/CI).

### Tests

- Verified manually: `doctor` still reports "9 passed / 0 failures" in dev;
  with a simulated `deltix.env` pointing at `/var/lib/deltix/db/users.db`,
  `config export` resolves `userDbPath` to the real path instead of `./data`.
- Full local suite: lint 0 errors (81 pre-existing CLI `noConsole` warnings),
  unit 259 pass / 0 fail, smoke 34 pass / 0 fail.

## [0.6.4] - 2026-08-28

**In plain terms:** this patch fixes a trap in the installer. Reinstalling or
upgrading the server while it was still running did not actually load the new
version — the installer would copy the new files and print "Starting", but the
old server process kept running in memory because `systemctl start` does
nothing if the service is already active. That made it look like every upgrade
"didn't work": the version badge and logs still showed the previous build no
matter what you installed. Now the installer properly restarts a running
service during a reinstall, so the version you install is the version that
runs.

### Fixed

- **`scripts/install.sh` never restarted an already-running service**: when a
  reinstall ran with `Start the deltix.service now? [y/N]: y`, the installer
  called `systemctl start`, which is a no-op on an active unit. The freshly
  synced application files sat on disk while the old process kept running the
  previous version — confirmed on a real server: after "successfully" installing
  0.6.2 over a running 0.6.1, `systemctl status` still showed the 0.6.1 process
  (boot log `"version":"0.6.1"`). The installer now checks
  `systemctl is-active` and uses `systemctl restart` when the unit is already
  running, so an upgrade actually upgrades the running process.

### Tests

- `bash -n scripts/install.sh` passes (syntax-checked after the change).
- Verified against the live failure pattern that motivated the fix: the
  already-running service now bounces on reinstall instead of silently keeping
  the old binary in memory.

## [0.6.3] - 2026-08-28

**In plain terms:** this patch makes the server behave correctly when several
things try to use the same data file at the same time. The server keeps its
records (users, sessions, file-transfer jobs, repositories) in small local
database files. Under the default settings, if a read happened in the exact
moment a write was still finishing, the read failed with a "database is
locked" error — which could surface as a momentarily empty screen in the admin
panel right after a change. The server's databases now use a more
collaborative journaling mode plus a short "wait for the lock" timeout, so
concurrent reads and writes no longer collide. The automated test suite on the
build server caught this because the very same race also made a test fail
intermittently.

### Fixed

- **`SQLITE_BUSY: database is locked` errors in libSQL-backed stores**: none of
  the six libSQL store implementations enabled WAL (`journal_mode = WAL`) nor a
  busy timeout, so a second connection performing a read while the storing
  process held an in-flight write transaction failed immediately with
  `SQLITE_BUSY`. The CI smoke suite surfaced this consistently as
  "allows an operator to manually requeue a dead_letter job via the API". All
  stores now run `PRAGMA journal_mode = WAL` and `PRAGMA busy_timeout = 5000`
  in `init()` (persistent per database file), matching the WAL discipline the
  `doctor` suite already expects.
  - Affected: `addon-trust`, `session`, `user`, `transfer-job`, `ticket`,
    `repo`, and `repo-sync-preference` stores.

### Tests

- Full local verification: lint clean (0 errors), unit **259 pass / 0 fail**,
  smoke **34 pass / 0 fail** (the previously flaky `storage-boot` requeue test
  now passes reliably, locally and in CI).
- The WAL journal mode is asserted by the existing `doctor` SQLite-integrity
  check and coverage is exercised by the storage `boot` smoke suite.

## [0.6.2] - 2026-08-28

**In plain terms:** this patch makes it possible to actually *see* what is
wrong with a server when something misbehaves. The built-in diagnostic
commands (status, doctor, config) silently did nothing when you ran them —
they printed nothing at all, which made it look like there were no logs or
tools available to investigate a problem. Now they work and print a full
report. It also removes a spurious "Transition was skipped" error that cluttered
the admin panel's browser console when you switched screens, and makes the
server's automated test suite much more reliable on slow or busy machines, so
a green checkmark in CI genuinely means the software works.

### Fixed

- **Diagnostic CLI (`status`, `doctor`, `config export`) was a no-op**: the
  `runCli` entry point in `src/cli/commands.ts` was defined but never invoked
  (there was no `import.meta.main` guard), so `bun run src/cli/commands.ts doctor`
  — the exact command documented for production troubleshooting — exited 0 with
  zero output. The module is now a proper CLI entry point: `import.meta.main`
  invokes `runCli(process.argv)` and propagates the exit code.
- **Admin UI threw `Uncaught (in promise) AbortError: Transition was skipped`**
  in the browser console when a screen transition was interrupted (e.g. quickly
  switching tabs). `withViewTransition` ignored the promise returned by
  `document.startViewTransition()`, so the rejection was unhandled. It now
  attaches a catch and falls back to a plain DOM update if a transition throws.
- **Flaky smoke tests under parallel load**: Bun's default per-test timeout is
  5000 ms, but the boot smoke tests launch a full server subprocess and can
  exceed that when 15 suites boot simultaneously, timing out the `beforeAll`
  hook even though the server was fine. `test:smoke` now runs with
  `--timeout=90000`.

### Tests

- Locally verified: unit **259 pass / 0 fail**, smoke **34 pass / 0 fail** with
  the new timeout (previously 3-4 suites failed intermittently under parallel
  load), lint clean (0 errors; 81 pre-existing `noConsole` warnings in the CLI).
- CI and CD re-run the full suite (unit + integration + smoke) as a hard gate
  on every push and before publishing, so the timeout fix is exercised on
  GitHub Actions as well (`test:smoke` now carries `--timeout=90000`).

## [0.6.1] - 2026-08-28

**In plain terms:** this patch makes the Admin Web UI tell the truth about
which version of Deltix is actually running — the little version tag in the
login screen and the diagnostic/support bundle used to show the version of an
older build even after you upgraded, which made it look like a reinstall had
not worked. It also fixes three day-to-day annoyances: the small action
buttons (edit user, copy token, and so on) could be invisible because their
styling was never included in the downloaded stylesheet, the tables could
stay empty right after a server restart until you happened to add or remove a
user (they now automatically retry loading), and the server's own
`--version` command printed an old version. Finally, a rare startup race is
fixed: on a very fast restart, a monitoring probe could arrive before the
server had finished wiring up its add-on routes, permanently breaking those
add-ons for that process — add-ons are now fully registered before the server
starts answering traffic.

### Fixed

- **Admin Web UI version badge is now dynamic.** The `#server-version-badge`
  on the login page and `deltixVersion` in the support bundle previously read
  a hardcoded `v0.5.4` string baked into the app; the release did not lie
  about the binary version (boot logs, `/status`), but the UI did. Both now
  fetch the real value from `/status` (`version`, `commit`, `nodeEnv`) via
  `refreshServerVersion()` on load and fall back to `unknown` if the server
  is unreachable, instead of a stale constant.
- **`deltix-server --version` now reports the packaged version.** The CLI
  version subcommand had a hardcoded `v0.5.4`; it now reads `package.json`
  via `import ... with { type: 'json' }` (`src/cli/commands.ts`), matching the
  boot `/status` value and fixing the supported `doctor`/ops output path.
- **Admin UI action buttons can no longer be invisible.** Root cause: the
  vendored `tailwind.css` was compiled with a content glob limited to `*.html`
  (`build:css`/`watch:css` in `package.json`), so any utility class used only
  inside `app.js` — `w-4`, `w-7`, `h-7`, `hover:text-amber-400`,
  `hover:text-emerald-400`, `hover:text-red-400`, etc. — was never generated,
  and buttons collapsed to 0×0. `src/styles/admin.css` now declares
  `@source "../contexts/admin-ui/assets/**/*.{html,js}"`, both CSS scripts use
  the `{html,js}` glob, and `tailwind.css` was regenerated (verified the
  previously missing classes are present).
- **Admin UI data now self-heals after a server restart.** The first load of
  users/trusted addons/repos no longer fails silently forever when it races a
  server that is still finishing boot: new `sleep()` + `fetchWithRetry()`
  helpers (retries network errors and 5xx with exponential backoff, passthrough
  otherwise) wrap `restoreSessionOnLoad`, `loadUsers`, `loadTrustedAddons`,
  and `loadReposAndDirectory`. Before, the tables stayed error-empty until any
  mutation happened to retrigger `loadUsers()` — the reported "users/repos only
  appear after I add or delete one" bug.
- **Add-on HTTP routes can no longer be lost to an early probe.** Real bug in
  `src/index.ts`: `Bun.serve()` started listening before the add-on loading
  block ran, and Hono's router builds its route matcher on the first request.
  A health check / reverse proxy that hit the port during the (sub-second)
  boot window threw `Can not add a route since the matcher is already built`
  and permanently disabled those add-ons for that process. The add-on
  discovery/activation block now runs before `Bun.serve()` (comment marked
  "CRITICAL" in `src/index.ts`).
- **Smoke test flakiness removed (HANDOFF §11.3).** The smoke tests that
  booted a real server no longer rely on fixed ~800–1500ms sleeps before the
  first fetch (which failed with `ConnectionRefused` under CI/load). New shared
  helper `tests/helpers/wait-for-server.ts` (`waitForServerReady`) polls
  `/status` with a 15s deadline; applied to `auth-boot`, `storage-boot`,
  `addons-boot`, `boot`, `transfer-boot`, `grpc-transfer-boot`,
  `versioning-boot`, `versioning-merge-boot`, `versioning-history-boot`,
  `versioning-branching-boot`, `versioning-push-commit-boot`.

### Tests

- Full suite re-run and green: **259 unit + 214 integration + 34 smoke tests,
  0 failures**, plus `bun run lint` clean (only pre-existing warnings in
  `scripts/generate-server-tls-cert.ts`).
- Addon boot fix proven end-to-end: a real signed addon with an `http:route`
  now returns 200 via `authenticated fetch` even when `/status` is polled
  eagerly during boot (before the fix this reproduced
  `Can not add a route since the matcher is already built` deterministically).
- UI fixes verified by CSS inspection of the regenerated `tailwind.css`
  (previously missing classes now present) and by parsing `app.js` with
  `node --check`; the `--version` CLI path is covered by
  `tests/unit/cli/commands.test.ts`, which asserts `runCli(['bun','deltix','--version'])`.

## [0.6.0] - 2026-08-28

**In plain terms:** Deltix-Client can now confirm it is talking to the right
server without anyone having to manually copy or paste certificate files over
SSH. If an operator turns it on, the server will answer a single, rate-limited
request with proof of which certificate it presents (a short digital
fingerprint), and it is completely off unless someone deliberately enables it.

### Added

- **Opt-in certificate bootstrap endpoint.** New `DELTIX_CERT_BOOTSTRAP_ENABLED`
  (default `false`, fail-closed) enables `GET /api/v1/bootstrap/certificate`,
  an unauthenticated, per-source-IP rate-limited (20 req/min) endpoint that
  returns the SHA-256 fingerprint (and PEM body) of the certificates this
  server presents for its gRPC TLS listener (and its HTTP TLS listener, when
  configured) — the same bytes any client already receives during a normal TLS
  handshake. Purpose: let a Deltix-Client perform a Trust-On-First-Use
  confirmation against a self-signed certificate without an operator manually
  copying a `.crt` off the box. The response always includes a warning that the
  fingerprint must be verified out-of-band (TOFU is not proof of identity).
  Never reads or exposes a private key. New bounded context
  `src/contexts/tls-discovery/` (service, fixed-window rate limiter, router —
  no cross-context imports, per the ACL rule).

### Tests

- 11 new tests across `tests/unit/tls-discovery/` and
  `tests/integration/tls-discovery/`: fingerprint determinism and format,
  HTTP certificate isolation, no private-key material leaks (unit + over a
  real HTTP request), rate-limit enforcement per source IP (429 after the
  window fills), and per-key independence/window reset for the limiter.

## [0.5.4] - 2026-08-28

**In plain terms:** on a machine that only ever had Bun installed (which is
the entire point of this installer — no Node.js requirement), `bun install`
could fail with `node: command not found` and abort the install. The cause:
a few transitive dependencies (`protobufjs`, pulled in by
`@grpc/proto-loader`) run a `postinstall` script that shells out to a
literal `node` executable rather than `bun`. This was previously only
reported and worked around manually by a user (`sudo ln -s
/usr/local/bin/bun /usr/local/bin/node`) — the installer now does this
itself, automatically and temporarily, only for the duration of the
dependency install, and only if no real Node.js is already present.

- **Fixed:** `scripts/install.sh` and `scripts/install-windows.ps1` both
  detect whether `node` (or `node.exe`) is already on `PATH` before running
  `bun install --production`. If it is not, a throwaway shim pointing at
  the already-installed Bun binary is added to `PATH` for that one command
  only, then removed — it is never left on the system, and it is never
  used if a real Node.js installation already exists.
- **Verified:** re-ran the full install end to end inside a disposable,
  Node-less systemd container (the exact failure mode reported): dependency
  install now succeeds, `protobufjs`'s postinstall script runs cleanly
  against the Bun shim, and the resulting service starts and responds with
  HTTP 200 on `/admin`.

## [0.5.3] - 2026-08-28

**In plain terms:** Windows now has the same one-command install experience
Linux already had. Previously, installing on Windows Server meant manually
downloading or cloning the source and running `install-windows.ps1`
yourself — there was no equivalent of the Linux one-liner. `INSTALL.md` also
now says clearly that Deltix-Server does not auto-detect your operating
system: Linux and Windows each have their own installer and their own
one-line bootstrap, and every release ships the exact same source tarball
for both (Bun runs the same code on both platforms; only the small
standalone `generate-server-tls-cert` helper is currently compiled and
published as a binary for Linux only).

- **Added:** `scripts/get-deltix.ps1` — a one-line bootstrap installer for
  Windows, mirroring `scripts/get-deltix.sh`. Resolves the latest release
  (or a pinned `$env:DELTIX_VERSION`), downloads the source tarball, and
  runs `scripts\install-windows.ps1` automatically:
  `iwr -useb .../get-deltix.ps1 | iex`.
- **Documented:** `INSTALL.md` now states explicitly that platform
  selection is manual (no auto-detect) and that CD does not build or
  publish separate Windows binaries for the server itself — only the
  optional TLS certificate tool is currently Linux-only as a compiled
  binary.

## [0.5.2] - 2026-08-28

**In plain terms:** the previous installer (`install.sh` / `get-deltix.sh`)
looked successful but silently produced a server that could never actually
start — it never generated the license, the JWT signing keys, the
mandatory gRPC certificate, or the anti-tamper commit log the server
requires to boot, and it wrote configuration under the wrong variable
names entirely. This was only caught by testing the installer against a
real, disposable Ubuntu virtual machine end to end (not just checking
that the install script "finished without errors"). It is now fixed and
was re-verified the same way: a clean VM, the real one-line installer, a
running service, and a real HTTP response from the Admin UI.

- **Fixed:** `scripts/install.sh` now generates a self-signed Community
  license, an Ed25519 JWT signing keypair, a mandatory gRPC TLS
  certificate, and initializes the Dolt anti-tamper commit log on first
  install, then writes the complete, correctly-named set of `DELTIX_*`
  environment variables the server actually requires to boot (see
  `src/shared/env.ts`). Previously it wrote an unrelated set of `APP_*`
  variables and none of the required secrets, so every service start
  failed with a configuration validation error.
- **Added:** `scripts/generate-community-license.ts` and
  `scripts/generate-jwt-keypair.ts` — standalone, production-safe
  generators (no test fixtures involved) used by the installer and
  reusable directly by operators who need to rotate keys manually.
- **Fixed:** `scripts/install-windows.ps1` had the same class of bug, plus
  an additional one specific to Windows: the generated `deltix.env` file
  was never actually loaded into the service process (Windows services
  have no equivalent of systemd's `EnvironmentFile=`). The Windows
  installer now generates the same secrets as the Linux installer and its
  service launcher correctly loads every variable — including multi-line
  PEM keys — into the process environment before starting the server.
- **Verification:** re-ran the entire install end to end inside a real,
  disposable systemd-enabled container simulating a clean Ubuntu VM: the
  service starts, the license validates, the gRPC transfer engine and
  Admin UI both come up, and re-running the installer (upgrade path)
  correctly leaves existing secrets untouched instead of regenerating
  them.

## [0.5.1] - 2026-08-28

**In plain terms:** you no longer have to `git clone` the repository or
know the exact GitHub archive URL to install Deltix-Server. Every release
now ships a ready-to-use source package, and a single copy-pasteable
command downloads and installs it end to end — the same pattern tools
like Docker and rustup use. This release also fixes a CI/CD bug from the
last release that could leave a GitHub Release incomplete.

### Added

- `scripts/get-deltix.sh`: a one-line bootstrap installer. Run
  `curl -fsSL .../get-deltix.sh | sudo bash` on a clean machine and it
  resolves the latest release (or a pinned `VERSION=`), downloads the
  source tarball, and runs `scripts/install.sh` automatically. Falls
  back to an unattended install when piped (stdin isn't a real
  terminal in that case); documented the download-then-run alternative
  for the interactive wizard.
- CD now packages the tagged source tree into
  `deltix-server-<version>.tar.gz` (application code only, no
  `node_modules`) and attaches it to the GitHub Release as a real,
  documented download target.
- `INSTALL.md`: documented the one-line bootstrap as the recommended
  install path, alongside the existing `git clone` / direct-download
  alternatives.

### Fixed

- Corrected `INSTALL.md`'s prior "download or clone the release"
  instruction, which pointed at an asset that didn't actually exist on
  the GitHub Release.

### Tests

- This release's tag push is the first real exercise of the CD pipeline
  fix from 0.5.0 (dedicated `ensure-release` job + `fail-fast: false` on
  the TLS cert-tool matrix), and of the new tarball-packaging job.

## [0.5.0] - 2026-08-28

**In plain terms:** installing Deltix-Server on a real machine (not
Docker) used to mean hand-editing configuration files and hoping you
picked the right ports and Dolt version yourself. Now the installer asks
you a handful of plain questions — ports, whether you want HTTPS and how
— and does the rest, including installing the exact, tested version of
Dolt it needs (never whatever happens to be "latest" that week). On top
of that, three separate Admin Web UI annoyances are fixed: action buttons
that used to wrap onto two lines, status messages that never went away,
and a username field that made you guess/type exactly right instead of
suggesting existing users. There's also a new installation guide, and a
CI pipeline problem that was silently blocking every future release has
been fixed.

### Added

- **Interactive installation wizard** in `scripts/install.sh` (Linux) and
  `scripts/install-windows.ps1` (Windows): prompts for the HTTP/gRPC
  ports, TLS mode (none / self-signed / existing certificate), and
  whether to start the service immediately — then generates
  `config.json`/`deltix.env` itself. Fully skippable with `--unattended`
  / `-Unattended` (also auto-detected when stdin isn't a terminal).
- **Dolt auto-install pinned to an exact version** (`DOLT_VERSION` at the
  repo root, currently `2.3.1`) on both installers — Dolt is downloaded
  and installed automatically, and only re-downloaded when that pinned
  version changes, so an upstream Dolt release can never silently break
  a running install.
- `INSTALL.md`: a full, professional installation guide (Linux, Windows,
  and Deltix-Client) covering what each installer creates, the wizard's
  questions, upgrades, and standalone TLS certificate generation.

### Fixed

- Admin Web UI users-table actions (deactivate/reactivate, toggle admin,
  delete) now render as a compact row of icon buttons instead of text
  buttons, so they no longer wrap awkwardly on narrower screens.
- Inline status/success/error messages in the Admin Web UI now
  auto-dismiss (5s for success, 8s for error) instead of staying on
  screen indefinitely until the next form submission.
- The Grant Role form's username field now offers autocomplete
  suggestions from known usernames instead of requiring an exact,
  error-prone manual match.
- Added a global `cache-control: no-store` response header plus explicit
  `cache: 'no-store'` on the repos/users/addon-trust list requests, to
  harden against stale list data being shown in the Admin Web UI after a
  restart or upgrade until a new item happened to be created.
- Resolved pre-existing Biome lint errors on `main` (excessive function
  complexity in the CLI's `exportConfig`/`runCli`, unused imports, and
  formatting) that had started silently failing CI on every subsequent
  push.

### Tests

- Full `bun test` suite re-verified after all changes: 503/505 passing.
  The 2 remaining failures are the already-documented pre-existing
  smoke-test timing flakiness under system load (fixed 800ms boot waits
  in `tests/smoke/*`) — reproduced independently of this release's
  changes and confirmed to pass on an isolated re-run of
  `tests/smoke/` alone.
- `bash -n` on `install.sh` and a real PowerShell 7.4.6 AST parse
  (`[System.Management.Automation.Language.Parser]::ParseFile`) on
  `install-windows.ps1` confirm both installers are syntactically valid.
  Not executed end-to-end in this environment since both scripts are
  destructive (create system users/services/directories).

## [0.4.1] - 2026-08-27

**In plain terms:** you no longer need the server's source code to generate
a production TLS certificate. Previously this required cloning the repo
and running `bun install` first — now a single downloadable file does the
job, or a one-line Docker command if you're already running the server
that way.

### Added

- **Standalone `deltix-gen-cert` binaries** attached to every GitHub
  Release (`deltix-gen-cert-linux-x64` / `-arm64`) — download, `chmod +x`,
  and run directly on the target machine to generate a self-signed
  certificate, no repo or Bun install required.
- **Docker one-liner** documented in the README for generating a cert using
  the already-published server image, for deployments that only use Docker.
- The existing `bun run tls:server-cert` (repo-checkout) path is unchanged
  and still documented as an alternative.

## [0.4.0] - 2026-08-27

**In plain terms:** two fixes bundled with one new feature. First, the Admin
Web UI's login page and JavaScript were never told "don't cache me" — so
after every server upgrade, browsers kept quietly running the *old*
JavaScript from before the fix, even though the server itself was correctly
updated and restarted. That's exactly why the previous release "didn't seem
to do anything": the browser was still executing yesterday's code. Second,
for VMs that don't sit behind a reverse proxy, the server can now terminate
HTTPS directly — a new `deltix-server` script generates a self-signed
certificate for your machine's hostname or IP, and once it's configured the
Admin Web UI and REST API serve over HTTPS with no extra infrastructure.

### Fixed

- **Admin Web UI assets (login page, `app.js`, vendor CSS/JS) were served
  with no cache instructions**, so browsers could keep an old, stale copy
  indefinitely across server upgrades. Every admin-facing response now sets
  `Cache-Control: no-store` so the browser always fetches the current
  version after a restart. **If you're upgrading from an older version and
  still see stale behavior after restarting the server, do one hard refresh
  (Ctrl+Shift+R) in your browser to clear the previously cached copy —
  future upgrades will no longer require this.**

### Added

- **Direct HTTPS termination for the HTTP control plane.** New optional env
  vars `DELTIX_HTTP_TLS_CERT_PATH` / `DELTIX_HTTP_TLS_KEY_PATH` (must be set
  together); when present, the server serves the Admin Web UI and REST API
  over HTTPS directly and marks session cookies `Secure` unconditionally.
  Existing reverse-proxy TLS setups (`x-forwarded-proto`) are unaffected.
- New `bun run tls:server-cert <hostname-or-ip>` script
  (`scripts/generate-server-tls-cert.ts`) that generates a self-signed
  EC P-256 certificate for a given hostname/IP and prints the exact env
  vars to configure. See the README's "HTTPS for the HTTP control plane"
  section for the full walkthrough.

## [0.3.2] - 2026-08-27

**In plain terms:** three real production bugs, all traced to the same root
cause. When the Admin Web UI is accessed over plain HTTP (no TLS — the
normal setup for an internal/air-gapped VM), the browser was silently
throwing away the login session cookie because the server was marking it
"HTTPS only" just because `NODE_ENV=production` was set, regardless of
whether the connection actually used HTTPS. Result: navigating to any admin
page after the initial login (like "User management") bounced back to the
login screen, and the Users/Repositories/Roles panels looked empty even
though the data was really there — the page just couldn't prove who you
were anymore. Also fixed: a global admin can now see and manage roles for
*every* repository, not just ones they happen to already have a personal
role on (previously the Roles panel would show "no repositories" for an
admin who had never been individually granted access to any of them).

### Fixed

- **Session cookie silently dropped over plain HTTP, breaking the Admin
  Web UI after the first page load.** The refresh-token cookie was marked
  `Secure` whenever `NODE_ENV=production`, with no regard for whether the
  request actually arrived over TLS. Browsers refuse to store or send
  `Secure` cookies on a plain-HTTP origin, so any full page reload/navigation
  (e.g. clicking "User management" → `/admin/users`) lost the session
  entirely, even though login itself appeared to work. Now the cookie is
  only marked `Secure` when the request genuinely arrived over HTTPS —
  either directly, or via a reverse proxy setting `x-forwarded-proto:
  https`. Deployments that terminate TLS at a reverse proxy are unaffected;
  deployments that (like most Deltix-Server installs today) serve the
  control plane over plain internal HTTP now keep working sessions.
- **Admin Web UI showed "no repositories"/"no users" for a global admin who
  had no personal role on any repo.** `GET /api/v1/versioning/repos` and the
  repo-roles management endpoints only ever considered a caller's own
  per-repo role, so a global admin who had never been individually granted
  `reader`/`writer`/`admin` on a given repo couldn't see it at all — even
  though the repo existed and other users could access it fine. Global
  admins can now list, grant, and revoke roles on any repo regardless of
  their own per-repo role. This does **not** grant global admins implicit
  read/write access to repo *data* (push, merge, commit, diff, etc. still
  require an explicit per-repo role) — it only unlocks the role-management
  surface the Admin Web UI's Roles panel needs to actually do its job.
- **Silent failures in the Admin Web UI looked identical to "genuinely
  empty".** Users, Repositories/Roles, and Trusted-Addons panels caught
  every fetch error (401/403/network failure) and rendered the same
  "No users created yet." style placeholder as a truly empty list. These
  now show a distinct "Failed to load — your session may have expired, try
  refreshing" message instead, so a broken session is never mistaken for
  missing data again.



**In plain terms:** if you were already running a Deltix-Server before the
global admin feature existed and then upgraded to v0.3.0, your existing
admin account (like `hemiblade`) silently lost admin access to the panel
after the upgrade, with no way to get it back — a real lock-out. Fixed:
the server now automatically restores admin access to the account
configured in `DELTIX_BOOTSTRAP_ADMIN_USERNAME`/`PASSWORD` every time it
starts, if that account exists but isn't currently a global admin.

### Fixed

- **Upgrade lock-out: pre-existing bootstrap admin lost global admin
  after upgrading to v0.3.0.** `ensureBootstrapAdmin()` only ever acted
  when the user database was completely empty (`count === 0`), which is
  only true on a brand-new install. On a server that already had users
  before v0.3.0 (all migrated to `isGlobalAdmin: false` by the schema
  migration), the configured bootstrap account was never re-promoted,
  and — with no other global admin able to grant the role — the Admin
  Web UI became permanently unreachable for that account. Fixed by
  having `ensureBootstrapAdmin()` also check whether the configured
  bootstrap account already exists but isn't a global admin, and
  promoting it in place (its password and every other field are left
  untouched; no duplicate account is created).

### Tests

- New unit tests cover: a pre-existing, non-admin bootstrap account gets
  promoted to global admin on the next boot; an already-admin bootstrap
  account is left untouched (no password change, no duplicate).

## [0.3.0] - 2026-08-27

**In plain terms:** until now, *any* person you created an account for
could open the Admin panel and manage every other user, including
creating new accounts and controlling which community add-ons the server
trusts — there was no way to make someone "just a regular user." Fixed:
there is now a real **global admin** role, separate from per-repository
roles. Only a global admin can open the Admin panel's user/add-on
management screens; everyone else is politely turned away. On top of
that, global admins can now manage **repository roles** (who can read,
write, or administer each individual repo) directly from the Admin panel,
instead of only via the CLI.

### Added

- **Global admin role**, a new account-wide flag separate from per-repo
  roles (`reader`/`writer`/`admin` on one repository). Only accounts with
  global admin can: reach the Admin panel's user list, create/deactivate/
  delete users, grant or revoke global admin from someone else, and
  manage which community add-ons the server trusts. Every non-global-admin
  request to those endpoints now gets a clear `403 Forbidden` instead of
  silently succeeding.
- The very first account created on a fresh install (via the setup wizard
  or the `DELTIX_BOOTSTRAP_ADMIN_*` environment variables) is always made
  a global admin automatically — otherwise nobody could ever grant the
  role to anyone.
- A safeguard prevents the *last remaining* global admin from removing
  their own admin role, so a server can never be accidentally locked out
  of its own admin panel.
- **New Admin panel screen: Repository roles.** Pick a repository, see who
  currently has reader/writer/admin access to it, grant a role to a
  username, or revoke one — all without touching the CLI.
- Non-global-admin users who sign in now see a short, friendly notice
  explaining they don't have admin access, instead of a confusing empty
  or broken screen.

### Security

- **Closed a real privilege gap**: previously, any authenticated user
  account (even one meant to be a read-only collaborator) had unrestricted
  access to user management and add-on trust management. This is a
  meaningful hardening in line with the project's original OWASP
  access-control requirements ("only admin-role accounts may reach the
  Admin panel").

### Tests

- New unit and integration tests cover: granting/revoking global admin,
  the last-admin lockout protection, every gated endpoint rejecting a
  non-admin caller with 403, and the first-boot/bootstrap-admin accounts
  always being created as global admins.
- Manually verified end-to-end in a real headless browser: a global admin
  sees the Users/Roles/Add-ons screens and can grant/revoke a repo role;
  a regular user sees none of those screens and instead sees the
  not-admin notice.

## [0.2.4] - 2026-08-27

**In plain terms:** the Admin panel (`/admin`) was completely unstyled and
broken on any server without internet access, because it was silently
downloading its look-and-feel from the public internet every time someone
opened the page. Fixed: everything it needs now ships inside the server
itself, so the Admin panel works identically whether the server is online
or fully offline (e.g. an internal, air-gapped machine).

### Fixed

- **Admin Web UI failed to render (no CSS, driver.js tour broken) on any
  server without outbound internet access.** `login.html`/`setup.html`
  loaded Tailwind CSS from `cdn.tailwindcss.com` and the `driver.js`
  onboarding-tour library from `cdn.jsdelivr.net` at page-load time. On a
  server with no route to the public internet (a common setup for
  internal/on-prem deployments), both requests fail silently and the page
  renders as unstyled plain HTML with a broken CSP violation in the
  console — this is exactly what was reported. Fixed by vendoring both
  dependencies into the repo (`src/contexts/admin-ui/assets/vendor/`) and
  serving them from the server itself at `/admin/vendor/*`; the CSP no
  longer needs to allow any external script/style origin at all.

### Tests

- Added a smoke test asserting the Admin Web UI HTML never references an
  external CDN and that every asset it links to is actually served by the
  Deltix-Server process itself.
- Manually verified with a headless-browser screenshot against the login
  page and the users/addons dashboard with all CDN hostnames DNS-blocked
  (simulating an air-gapped VM) — renders identically to the
  internet-connected case.

## [0.2.3] - 2026-08-27

**In plain terms:** closed a narrow but real gap where taking away
someone's write access to a repo (`deltix roles revoke`) didn't always
stop a transfer that had already started — it now does, immediately.
Also added a simple `/status` page so anyone can check which version is
running on a server.

### Security

- **HIGH: revoked/downgraded repo roles did not take effect on an
  already-issued transfer ticket.** Ticket *issuance* (`POST
  /api/v1/transfer/push/ticket`, fixed in 0.2.2) correctly checks the
  caller's current repo role, but the ticket itself only proved
  authorization at that one moment. `TicketService.consumeTicket()` (called
  from the gRPC layer's `PushSessionHandler`/`PullSessionHandler` when the
  actual data transfer starts) never re-checked the role — a ticket minted
  while a user was still a `writer` remained honorable at gRPC-consumption
  time even after an admin ran `deltix roles revoke`, for as long as the
  ticket's TTL/heartbeat window stayed open (`DELTIX_TICKET_TTL_SECONDS`,
  sliding window). Fixed by threading a `RepoRoleVerifier` (backed by
  `AuthService.getRepoRole()`) into `TicketService`, re-checked
  fail-closed (`TicketRoleRevokedError`) both at ticket consumption
  (`consumeTicket`, pre-activation) and on every heartbeat renewal
  (`renewTicket`) — so a revoke now cuts off even a long-running,
  already-in-flight transfer, not just future ticket issuance.

### Added

- `GET /status`: public, unauthenticated endpoint reporting build metadata
  (`version` from `package.json`, `commit` resolved from
  `DELTIX_BUILD_COMMIT` at build time or `git rev-parse` locally, and
  `nodeEnv`). Deliberately minimal — no internal topology, dependency
  versions, or stack traces exposed (OWASP A05: verbose banners aid
  reconnaissance). Also logged once at boot for startup diagnostics.

### Tests

- Added unit coverage in `ticket.service.test.ts` for the consumption-time
  and heartbeat-time role re-verification (revoked, downgraded, and
  still-sufficient role scenarios).
- Added a smoke test asserting `GET /status` returns valid version/commit/
  nodeEnv metadata against a real booted subprocess.

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
