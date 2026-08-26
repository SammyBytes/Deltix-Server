# Context: admin-ui

Minimal, pragmatic Admin Web UI served directly by Deltix-Server's HTTP control plane
(same process, same port as the REST API — no separate build pipeline, no bundler, no
frontend framework).

## Stack (deliberately lightweight)

- Plain HTML + vanilla JS, no build step (kept as static assets under `assets/`).
- Tailwind CSS via CDN (`cdn.tailwindcss.com`) for utility-first styling.
- Fluent UI System Icons via CDN (`@fluentui/svg-icons` through a static CDN) for a
  consistent, accessible icon set.
- [driver.js](https://driverjs.com) via CDN for a lightweight first-run onboarding tour
  (highlighting the login form and session status panel).
- No client-side framework (React/Vue/etc.) — the UI is small enough (login + session
  status) that one is not justified per the "no speculative abstractions" rule.

## What it does

- Serves a single login page at `GET /admin` (logic in `GET /admin/app.js`, an
  external same-origin script — never inline, so the strict CSP below can omit
  `unsafe-inline` for scripts) that calls the existing `/api/v1/auth/login` /
  `/api/v1/auth/logout` / `/api/v1/auth/keep-alive` / `/api/v1/auth/refresh`
  endpoints — no separate/duplicated auth logic. The UI is a thin client of the
  same auth context used by `deltix login`.
- Stores the access token in memory (a JS variable, not `localStorage`) for the
  lifetime of the tab, to reduce XSS token-theft blast radius.
- Persists the *session* (not the access token) across page reloads via an
  `httpOnly`, `SameSite=Strict` refresh-token cookie set by the server on
  login/refresh. On every page load the script calls `POST /api/v1/auth/refresh`
  (cookie sent automatically by the browser, never read by JS) to silently
  restore the session and mint a fresh access token — so a reload does NOT force
  a fresh login, while the refresh token itself is still never exposed to
  JavaScript at any point. `secure` on the cookie is only forced in
  `NODE_ENV=production` (browsers reject `Secure` cookies over plain HTTP, and
  dev/test commonly run this server over HTTP on localhost).

## What it explicitly does NOT do

- No separate/duplicated auth logic — it is a thin client of the exact same
  `AuthService` the CLI uses, plus one additional endpoint (`/refresh`) that
  only re-issues an access token for an already-valid session; there is still
  only one authentication code path to secure and audit.
- No new dependency on a frontend build tool — CDN-hosted, zero-build assets only.
- Not mounted unless `DELTIX_ADMIN_UI_ENABLED=true` (default `false`) — reduces attack
  surface for deployments that don't need it (e.g. CI-driven headless usage).
