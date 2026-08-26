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

- Serves a single login page at `GET /admin` that calls the existing
  `/api/v1/auth/login` / `/api/v1/auth/logout` / `/api/v1/auth/keep-alive` endpoints —
  no separate/duplicated auth logic. The UI is a thin client of the same auth context
  used by `deltix login`.
- Stores the access token in memory (a JS variable, not `localStorage`) for the
  lifetime of the tab, to reduce XSS token-theft blast radius; a page reload requires
  logging in again (acceptable for an admin console used occasionally, not the primary
  auth surface for automated clients).

## What it explicitly does NOT do

- No server-side session/cookie auth — it uses the exact same bearer-token flow as
  `deltix login`, so there is only one authentication code path to secure and audit.
- No new dependency on a frontend build tool — CDN-hosted, zero-build assets only.
- Not mounted unless `DELTIX_ADMIN_UI_ENABLED=true` (default `false`) — reduces attack
  surface for deployments that don't need it (e.g. CI-driven headless usage).
