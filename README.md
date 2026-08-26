# Deltix-Server

Enterprise Control Plane for **Deltix** — Git-style version control for relational database
schemas and data (branch, merge, and pull-request your database before it hits production).

> Licensed under the **Business Source License 1.1** (source-available). See [`LICENSE`](./LICENSE).
> Production use is free for up to 3 concurrent active seats; larger deployments or use of
> Enterprise Add-ons require a commercial license. Converts to Apache-2.0 on 2030-01-01.

## What this is

Deltix-Server is the control plane that:
- Validates the Ed25519-signed license key at boot and periodically thereafter.
- Enforces anti-tamper protection against operating-system clock manipulation, backed by
  Dolt's own immutable commit graph (`dolt_log`) — never by data this process can edit itself.
- Exposes a REST API (HonoJS, later phases) for authentication and repository management.
- Dynamically loads Enterprise Add-ons (`auth-ldap`, `auth-oidc`, `storage-s3-backup`, ...) only
  when the active license explicitly authorizes them.
- Brokers gRPC data transfers into a local SSD staging area before asynchronously syncing to NAS.

## What this is NOT

- It does **not** vendor, clone, or recompile Dolt's Go source. Dolt is consumed strictly as a
  precompiled black-box binary, invoked via its CLI.
- It does **not** write directly to NAS storage — every transfer passes through local SSD staging.
- It does **not** require internet access to validate licenses (fully air-gapped capable).
- It does **not** expose or load an Add-on into memory unless the license explicitly grants it.

## Architecture

Modular monolith organized by **bounded contexts** under `src/contexts/*`. There is no clean/hexagonal
layering — see [`.github/copilot-instructions.md`](./.github/copilot-instructions.md) for the full
set of engineering rules (architecture, security, licensing, testing, logging) that govern this repo.

Current contexts:
- `licensing` (Fase 1 — implemented): Ed25519 signature verification + Dolt-log-backed anti-tamper.
- `auth`, `transfer`, `storage`, `addons`: placeholders for later roadmap phases.

## Roadmap

1. Cryptography & Licensing (Ed25519 + Anti-Tamper) — **this repo, `phase-1-crypto-licensing`**
2. REST Control Plane & Authentication (HonoJS)
3. Ephemeral Tickets (2m TTL) & gRPC Engine (:50051)
4. Dynamic Add-on Loading (`import()` gated by license)
5. Enterprise Packaging (Podman + single binary)

Branching model: **trunk-based**, one branch per roadmap phase, merged into `main` once its
test suite (unit + integration + smoke) is green.

## Development

Requires [Bun](https://bun.sh) `>=1.3`.

```bash
bun install
cp .env.example .env   # fill in DELTIX_LICENSE_PUBLIC_KEY, DELTIX_LICENSE_KEY, DELTIX_DOLT_REPO_PATH

bun run lint            # Biome
bun test                 # all tiers
bun run test:unit        # fast, no external process/binaries
bun run test:integration # spins up a real temporary Dolt repository
bun run test:smoke       # boots the module end-to-end, asserts process behavior
```

## Testing philosophy

TDD is mandatory: write the failing test first, then the minimal implementation, then refactor.
No phase branch merges into `main` without unit, integration, and smoke tests passing.
