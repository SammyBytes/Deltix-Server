# Deltix-Server

[![CI](https://github.com/SammyBytes/Deltix-Server/actions/workflows/ci.yml/badge.svg)](https://github.com/SammyBytes/Deltix-Server/actions/workflows/ci.yml)
[![CD](https://github.com/SammyBytes/Deltix-Server/actions/workflows/cd.yml/badge.svg)](https://github.com/SammyBytes/Deltix-Server/actions/workflows/cd.yml)
[![License: BSL 1.1](https://img.shields.io/badge/license-BSL%201.1-blue.svg)](./LICENSE)

Enterprise control plane for **Deltix** — Git-style version control for relational database
schemas and data (branch, merge, and pull-request your database before it hits production).
Built with [Bun](https://bun.sh) + [HonoJS](https://hono.dev), backed by [Dolt](https://www.dolthub.com/)
as the immutable, versioned storage engine.

> Licensed under the **Business Source License 1.1** (source-available). See [`LICENSE`](./LICENSE).
> Production use is free for up to 3 concurrent active seats; larger deployments or use of
> Enterprise Add-ons require a commercial license. Converts to Apache-2.0 on 2030-01-01.

## What this is

Deltix-Server is the control plane that:
- Validates the Ed25519-signed license key at boot and periodically thereafter, gating features
  (seat count, tier, addon entitlements) strictly server-side.
- Enforces anti-tamper protection against operating-system clock manipulation, backed by
  Dolt's own immutable commit graph (`dolt_log`) — never by data this process can edit itself.
- Exposes a REST API (HonoJS) for authentication, session management, and repository operations,
  plus an optional Admin Web UI for TOFU addon trust management.
- Dynamically loads Community and Enterprise Add-ons — signature-verified (Ed25519, Trust-On-First-Use
  for community authors), manifest-validated against a closed capability list, and sandboxed behind
  a circuit breaker — only when the active license explicitly authorizes them.
- Brokers gRPC (mTLS) data transfers into a local SSD staging area before asynchronously syncing to NAS.

## What this is NOT

- It does **not** vendor, clone, or recompile Dolt's Go source. Dolt is consumed strictly as a
  precompiled black-box binary, invoked via its CLI.
- It does **not** write directly to NAS storage — every transfer passes through local SSD staging.
- It does **not** require internet access to validate licenses (fully air-gapped capable).
- It does **not** expose or load an Add-on into memory unless the license explicitly grants it,
  its manifest only requests capabilities from the closed permission list, and (for community
  addons) its author key is explicitly trusted by an admin.

## Architecture

Modular monolith organized by **bounded contexts** under `src/contexts/*`. There is no clean/hexagonal
layering — see [`.github/copilot-instructions.md`](./.github/copilot-instructions.md) for the full
set of engineering rules (architecture, security, licensing, testing, logging) that govern this repo.

Contexts (all implemented through Fase 4):
- `licensing`: Ed25519 signature verification + Dolt-log-backed anti-tamper.
- `auth`: local users, Argon2id password hashing, JWT (Ed25519) session issuance.
- `transfer`: ephemeral transfer tickets, gRPC Push/Pull/Heartbeat, SSD→NAS staging sync.
- `addons`: `@deltix/addon-sdk` (MIT, `packages/addon-sdk`) contracts, TOFU trust store, fail-closed
  dynamic loader, per-addon circuit breaker.
- `admin-ui`: static Admin Web UI (login + addon trust panel), served same-origin, CSP-locked.

## Roadmap

1. ✅ Cryptography & Licensing (Ed25519 + Anti-Tamper)
2. ✅ REST Control Plane & Authentication (HonoJS)
3. ✅ Ephemeral Tickets (2m TTL) & gRPC Engine (:50051, mTLS)
4. ✅ Dynamic Add-on Loading (TOFU trust, closed capability list, circuit breaker)
5. ✅ Real Dolt Versioning, Admin User Management & Sync Preferences — complete,
   see [`docs/decisions/0002-phase-5-versioning-and-user-management.md`](./docs/decisions/0002-phase-5-versioning-and-user-management.md).
   Sub-phases: 5.1 ✅ per-repo Dolt provisioning, 5.2 ✅ real commits on push, 5.3 ✅ branching,
   5.4 ✅ merge/conflicts, 5.5 ✅ log/diff, 5.6 ✅ per-repo authorization (`reader`/`writer`/`admin` via auth-owned ACL), 5.7 ✅ Admin Web UI
   user management (libSQL-backed users, guided first-boot admin setup, create/deactivate/delete, active-session/seat analytics), 5.8 ✅ sync preferences (per-repo persistence, schema-only vs schema+data, selective
   table sync with server-side FK-closure validation and dry-run preview).

Branching model: **trunk-based**, one branch per roadmap phase, merged into `main` once its
test suite (unit + integration + smoke) is green.

## Development

Requires [Bun](https://bun.sh) `>=1.4`.

```bash
bun install
cp .env.example .env   # fill in every DELTIX_* var — see .env.example for the full list

bun run lint            # Biome
bun test                 # all tiers
bun run test:unit        # fast, no external process/binaries
bun run test:integration # spins up a real temporary Dolt repository
bun run test:smoke       # boots the module end-to-end, asserts process behavior
bun audit                 # dependency vulnerability scan (also runs in CI)
```

Local demo (throwaway test fixtures — **never use in production/pilot**):
```bash
bun run scripts/setup-local-demo.ts
bun run dev
```

## Deployment (Docker)

A production-oriented multi-stage `Dockerfile` is included (Bun runtime + a real Dolt CLI
installed in the image — required at runtime, not vendored). See [`docs/pilot-plan.md`](./docs/pilot-plan.md)
for the full step-by-step guide to running a controlled pilot deployment, including how to
generate real (non-test-fixture) license and JWT material.

```bash
docker build -t deltix-server .
# or pull a published image (built by .github/workflows/cd.yml on tag push):
docker pull ghcr.io/sammybytes/deltix-server:latest
```

The image exposes port `9090` (HTTP control plane) and `50051` (gRPC transfer engine, mTLS),
and declares `/app/data` + your mounted Dolt repo path as the persistent state to back up.

### HTTPS for the HTTP control plane (Admin Web UI + REST API)

By default the HTTP control plane (port `9090`) serves plain HTTP, which is fine when a
reverse proxy in front of it terminates TLS. If you're deploying directly onto a bare
VM/IP with no reverse proxy (the common case for an internal/air-gapped pilot), generate a
self-signed certificate and point the server at it:

```bash
bun run tls:server-cert 10.1.10.129   # replace with your server's hostname or IP
```

This writes `./certs/server/server.crt` + `server.key` and prints the two env vars to add:

```
DELTIX_HTTP_TLS_CERT_PATH=/path/to/certs/server/server.crt
DELTIX_HTTP_TLS_KEY_PATH=/path/to/certs/server/server.key
```

Once both are set, the server automatically serves the Admin Web UI and REST API over HTTPS
and marks session cookies `Secure`. Without either of these set, the server stays on plain
HTTP and cookies are only marked `Secure` when a reverse proxy in front of it sets
`x-forwarded-proto: https`. Browsers/CLI will warn about an untrusted issuer for a
self-signed cert on first connection — expected, and safe to accept, since the connection
itself is still fully encrypted; it's only not signed by a public CA.

## Security

See [`SECURITY.md`](./SECURITY.md) for the supported version policy, vulnerability reporting
process (private, via GitHub Security Advisories), and this project's security baseline
(OWASP Top 10 / ASVS, fail-closed licensing and addon loading, no hardcoded secrets, automated
dependency scanning via Dependabot + `bun audit` in CI).

## Testing philosophy

TDD is mandatory: write the failing test first, then the minimal implementation, then refactor.
No phase branch merges into `main` without unit, integration, and smoke tests passing.
