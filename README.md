# Deltix-Server

[![CI](https://github.com/SammyBytes/Deltix-Server/actions/workflows/ci.yml/badge.svg)](https://github.com/SammyBytes/Deltix-Server/actions/workflows/ci.yml)
[![CD](https://github.com/SammyBytes/Deltix-Server/actions/workflows/cd.yml/badge.svg)](https://github.com/SammyBytes/Deltix-Server/actions/workflows/cd.yml)
[![License: BSL 1.1](https://img.shields.io/badge/license-BSL%201.1-blue.svg)](./LICENSE)

The enterprise **control plane** for [Deltix](https://github.com/SammyBytes/Deltix-Client) —
Git-style version control for relational databases. Built with [Bun](https://bun.sh) +
[Hono](https://hono.dev), backed by [Dolt](https://www.dolthub.com/) as the immutable,
versioned storage engine.

> **Business Source License 1.1** (source-available). Free for up to 3 concurrent active
> seats; larger deployments or Enterprise add-ons need a commercial license. Converts to
> Apache-2.0 on 2030-01-01. See [`LICENSE`](./LICENSE).

---

## What it does

- **Versioning API** — per-repo Dolt repositories with real commits, branches, merges,
  log/diff, and commit-based **push/pull** (the client sends/receives structured commits,
  not loose files).
- **Authentication & access control** — Argon2id local users, Ed25519 JWT sessions, and
  per-repo roles (`reader`/`writer`/`admin`). Repo creation is gated by a `canCreateRepos`
  permission (global admins always pass).
- **Licensing** — validates the Ed25519-signed license at boot and periodically, gating
  seats/tier/add-ons server-side, with anti-tamper backed by Dolt's own `dolt_log`.
- **Add-ons** — dynamically loads signature-verified (Ed25519/TOFU), manifest-validated
  Community/Enterprise add-ons behind a per-add-on circuit breaker.
- **Admin Web UI** — same-origin, CSP-locked panel for user management and add-on trust.
- **Transfer engine** — mTLS gRPC for streaming pulls and staging→NAS sync.

It consumes Dolt strictly as a black-box binary (never vendored or recompiled), never writes
NAS directly (everything goes through local SSD staging), and validates licenses fully
air-gapped.

---

## Run it

The supported production path is the installer or Docker. Full step-by-step (including
generating real license/JWT material and TLS) is in
[`docs/INSTALL-GUIDE.md`](./docs/INSTALL-GUIDE.md) and [`docs/pilot-plan.md`](./docs/pilot-plan.md).

```bash
# Docker (image built by cd.yml on every tag):
docker pull ghcr.io/sammybytes/deltix-server:latest
docker run -p 9090:9090 -p 50051:50051 \
  -v deltix-data:/app/data ghcr.io/sammybytes/deltix-server:latest
```

The container exposes `9090` (HTTP control plane) and `50051` (gRPC transfer). Persistent
state to back up: `/app/data` plus your mounted Dolt repository path.

### TLS

By default the HTTP plane serves plain HTTP (fine behind a TLS-terminating proxy). To serve
HTTPS directly on a bare VM/IP, generate a self-signed cert and set
`DELTIX_HTTP_TLS_CERT_PATH` + `DELTIX_HTTP_TLS_KEY_PATH`. The generator ships as a standalone
binary in each release (`deltix-gen-cert-linux-x64`) and as `bun run tls:server-cert` from a
checkout — see the install guide. When the server is reached by IP, the cert auto-names itself
with the machine hostname so clients verify without disabling TLS.

---

## API surface

All endpoints are under `/api/v1` and require a `Bearer` token except `/auth/login`,
`/auth/refresh`, `/auth/setup*` and `/status`.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login` · `/auth/refresh` · `/auth/logout` · `GET /auth/users` · role/permission toggles |
| Repos | `POST /versioning/repos` · `GET /versioning/repos[/:repoId]` |
| Branches | `GET/POST/DELETE /versioning/repos/:repoId/branches[/:name]` |
| History | `GET /versioning/repos/:repoId/log` · `/diff` |
| Sync | `GET/PUT/POST /versioning/repos/:repoId/sync-preferences[/dry-run]` |
| Push (commits) | `POST /versioning/repos/:repoId/push-commits` |
| Pull (commits) | `GET /versioning/repos/:repoId/refs` · `GET /versioning/repos/:repoId/pull-commits` (NDJSON) |
| Roles | `GET/POST/DELETE /versioning/repos/:repoId/roles[/:username]` |
| Transfer | `POST /push/ticket` (gRPC push/pull authorization) |

The matching client commands live in
[the Deltix-Client README](https://github.com/SammyBytes/Deltix-Client#commands).

---

## Architecture

A modular monolith organized by **bounded contexts** under `src/contexts/*` (no hexagonal
layering). External processes are shelled out only through argv arrays (no shell strings);
Dolt is always a verified black-box binary. Full rules:
[`.github/copilot-instructions.md`](./.github/copilot-instructions.md).

| Context | Responsibility |
|---|---|
| `licensing` | Ed25519 signature verification + Dolt-log-backed anti-tamper. |
| `auth` | Local users, Argon2id hashing, JWT sessions, per-repo roles, `canCreateRepos`. |
| `versioning` | Repo provisioning, commits, branches, merge, log/diff, sync-prefs, push/pull-commits. |
| `transfer`, `storage` | Ephemeral tickets, gRPC Push/Pull/Heartbeat, SSD→NAS staging. |
| `addons` | Addon SDK contracts, TOFU trust store, fail-closed loader, circuit breaker. |
| `admin-ui` | Static Admin Web UI (login, users, add-on trust), CSP-locked. |
| `tls-discovery` | Certificate bootstrap so clients can trust a self-signed server. |

---

## Roadmap

1. ✅ Cryptography & licensing (Ed25519 + anti-tamper)
2. ✅ REST control plane & authentication
3. ✅ Ephemeral tickets (2m TTL) & gRPC engine (mTLS)
4. ✅ Dynamic add-on loading (TOFU, closed capability list, circuit breaker)
5. ✅ Real Dolt versioning, user management & sync preferences — see
   [`docs/decisions/0002-phase-5-versioning-and-user-management.md`](./docs/decisions/0002-phase-5-versioning-and-user-management.md)
   (5.1 provisioning · 5.2 commits · 5.3 branching · 5.4 merge/conflicts · 5.5 log/diff ·
   5.6 per-repo ACL · 5.7 admin UI · 5.8 sync-prefs + FK closure · 5.9 commit-based
   push/pull + `canCreateRepos` + auto-create-on-first-push)

Branching model: **trunk-based**, one branch per phase, merged to `main` once unit +
integration + smoke are green.

---

## Development

Requires [Bun](https://bun.sh) `>=1.4`.

```bash
bun install
cp .env.example .env      # fill in DELTIX_* vars (see .env.example)

bun run lint              # Biome
bun run test:unit         # fast, no external processes
bun run test:integration  # spins up a real temporary Dolt repository
bun run test:smoke        # boots the module end-to-end
bun audit                 # dependency scan (also in CI)
```

Local demo with throwaway fixtures (**never** for production):

```bash
bun run scripts/setup-local-demo.ts && bun run dev
```

## Security

See [`SECURITY.md`](./SECURITY.md) for the supported-version policy, private vulnerability
reporting (GitHub Security Advisories), and the security baseline (OWASP Top 10 / ASVS,
fail-closed licensing and add-on loading, no hardcoded secrets, Dependabot + `bun audit` in CI).
