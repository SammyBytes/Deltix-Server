# Copilot Instructions — Deltix-Server

Deltix-Server is the **Control Plane** for Deltix, a Git-style version-control system for
relational database schemas and data. This file is the authoritative engineering contract for
any human or AI agent (including GitHub Copilot) writing code in this repository. When in doubt,
prefer the rule stated here over a generic "best practice" you might otherwise apply.

Licensed under the **Business Source License 1.1** (source-available, converts to Apache-2.0 on
2030-01-01). See [`LICENSE`](../LICENSE).

---

## 1. Product guardrails (non-negotiable)

These come directly from the product/technical specification and override any convenience
shortcut a future task might suggest:

1. **Dolt is a black-box binary.** NEVER clone, vendor, patch, or recompile Dolt's Go source.
   It is consumed exclusively as a precompiled executable, invoked via its CLI/API surface.
2. **Never write directly to the NAS.** All gRPC transfers land in a local SSD staging area
   first; sync to `/mnt/nas/...` happens asynchronously, out-of-band from the client request.
3. **Sessions expire by inactivity (sliding window), never by a hard absolute TTL.** A
   heartbeat/keep-alive loop extends the window; there is no "session dies at T+2min no matter
   what" behavior.
4. **Zero bundled/required MySQL service on the host.** The server must not assume or depend on
   a pre-installed MySQL instance.
5. **License validation never depends on internet access.** The server must work fully
   air-gapped. Do not add telemetry/phone-home calls to the licensing path.
6. **Fail closed on Add-ons.** If the active license does not explicitly authorize an Add-on,
   its code must never be `import()`-ed into memory, and it must never be reachable as an HTTP
   endpoint. Gate the `import()` call itself — do not import-then-check.
7. **Anti-tamper is backed by Dolt's own immutable commit graph (`dolt_log`), never by state
   this process can edit itself** (not libSQL, not a local file). If the operating system clock
   is behind the latest recorded Dolt commit, boot must be refused immediately (fail-closed,
   non-zero exit) — no silent degradation, no automatic retry loop.

---

## 2. Architecture: modular monolith, NOT clean/hexagonal architecture

- This is deliberately a **modular monolith** organized by **bounded contexts** under
  `src/contexts/*` (`licensing`, `auth`, `transfer`, `storage`, `addons`, ...). Do not introduce
  ports/adapters layers, use-case/interactor classes, or repository-pattern abstractions unless
  a context genuinely needs to swap an implementation (and even then, prefer the smallest
  possible seam).
- **Each context exposes exactly one public surface: its `index.ts` barrel.** Nothing outside a
  context may import from `contexts/<name>/<anything-else>`. This is the ACL (anti-corruption
  layer) boundary — enforced by convention and code review, not by a build-time firewall.
- **Cross-context or cross-system integration goes through `src/acl/`.** If context A needs
  something from context B, or from an external system (the `dolt` binary, a future add-on,
  the Deltix-Client over the network), write a small, boring adapter in `src/acl/` that
  translates shapes at the boundary. Business logic never lives in an ACL adapter.
- **`src/shared/`** holds only truly cross-cutting, context-agnostic code: env validation,
  logger factory, generic config. If a helper is only used by one context, it belongs inside
  that context, not in `shared/`.
- No dependency cycles between contexts. If two contexts need each other, one of them is
  probably the wrong boundary — stop and reconsider the split rather than adding a cycle.

## 3. What NOT to do

- No speculative abstractions: no interface with a single implementation "in case we need to
  swap it later," no generic `Repository<T>`/`Service<T>` base classes, no dependency-injection
  container for a monolith this size.
- No god objects/services that reach across multiple contexts' responsibilities.
- No business logic inside HTTP routers/controllers (future phases) — routers parse/validate
  input, call into a context's public API, and shape the response. Nothing else.
- No line-by-line comments explaining what the code obviously does. Comment only the *why* when
  it is non-obvious (a security decision, a workaround for a Dolt CLI quirk, a legal/licensing
  constraint). Prefer a clear function/variable name over a comment.
- No hardcoded secrets, keys, or environment-specific values anywhere in source, including test
  fixtures that resemble real license keys. Test-only keypairs must be generated at test time.
- No premature performance micro-optimization that adds complexity without a measured need —
  but also no needlessly blocking/synchronous I/O in a hot path (see §6).
- No adding a dependency "just in case." Every dependency must justify its existence and pass
  the vetting process in §7.

## 4. Security — OWASP Top 10 (2021) & OWASP ASVS

Target baseline: **ASVS Level 2** for the control plane. Map every security-relevant change to
these categories and address them explicitly in code review:

- **A01 Broken Access Control**: the server is the sole authority on permissions. Never trust a
  claim from the client (Deltix-Client or any Add-on) about what it's allowed to do — always
  re-verify server-side against the license/session state.
- **A02 Cryptographic Failures**: use `node:crypto`'s native Ed25519 support for all signature
  verification. No home-grown crypto. Public keys are supplied via environment variables,
  never hardcoded (see `DELTIX_LICENSE_PUBLIC_KEY` in `.env.example`).
- **A03 Injection**: any SQL/queries against libSQL (future phases) must be parameterized.
  Never string-interpolate user- or license-derived data into a query or shell command. When
  shelling out to the `dolt` CLI, pass arguments as an argv array (via `Bun.$` tagged templates
  or an explicit args array) — never build a shell string by concatenation.
- **A04 Insecure Design**: fail-closed by default. If validation is ambiguous or a dependency
  (Dolt CLI, filesystem, network) is unavailable, refuse the operation rather than proceeding
  optimistically.
- **A05 Security Misconfiguration**: `.env.example` ships with empty/placeholder values only.
  Validate all config at boot (see `src/shared/env.ts`) and crash with a clear error rather than
  running with an incomplete/insecure configuration.
- **A06 Vulnerable and Outdated Components**: see §7 (dependency vetting).
- **A07 Identification and Authentication Failures**: sessions/tickets use sliding-window
  expiration renewed by heartbeat, never a fixed hard TTL (see §1.3).
- **A08 Software and Data Integrity Failures**: never trust an unverified payload. The license
  key's signature must be verified before any field of its payload is read/trusted. Same
  principle applies to Add-on packages in Fase 4.
- **A09 Security Logging and Monitoring Failures**: log every license validation attempt
  (success/failure/rollback-detected) with enough context to investigate incidents, but never
  log the raw license key, signature, or any secret in clear text (see §8, redaction).
- **A10 Server-Side Request Forgery**: any outbound HTTP call introduced in later phases
  (OIDC/LDAP add-ons, S3 backup) must validate/allow-list its target; never forward a
  user-supplied URL verbatim to an HTTP client.

## 5. Privacy-by-design

- **Data minimization**: only log/persist what is operationally necessary. Do not log full
  license payloads, tokens, or file contents "for debugging" — log identifiers and outcomes.
- **No PII in logs**: avoid logging end-user personal data; when unavoidable (future auth
  phases), redact or hash it.
- **Least privilege on the filesystem**: staging/NAS paths should be created with restrictive
  permissions; do not widen permissions to work around an error.
- **Encryption in transit** is mandatory for any network-facing feature introduced in later
  phases (REST/gRPC).

## 6. Performance

- Avoid synchronous, blocking I/O in request/response hot paths; prefer Bun's async APIs
  (`Bun.file`, async `fs` equivalents).
- Prefer streaming over buffering the whole payload in memory for large data transfers
  (Fase 3 gRPC engine).
- Measure before optimizing — do not add caching, pooling, or batching layers speculatively.
- Keep the licensing validation path cheap: it runs at boot and periodically, not per-request.

## 7. Dependency management — mandatory vulnerability vetting

Before adding **any** dependency:

1. Check it against a vulnerability database (OSV.dev API or GitHub Advisory Database) for the
   **exact version** you intend to pin.
2. Pin the **exact version** in `package.json` — no `^`/`~` ranges. Exact versions make
   `bun audit` results reproducible and prevent silent transitive upgrades.
3. Record the check (package, version, result) in the PR/commit description that introduces it.
4. Run `bun audit` (and `bun audit --fix` if it reports something fixable) before merging any
   change that touches `package.json`.

Currently vetted dependencies (0 known vulnerabilities as of introduction):

| Package | Exact version | Purpose |
|---|---|---|
| `zod` | `4.4.3` | Runtime validation of env vars/config at boot |
| `pino` | `10.3.1` | Structured logging |
| `pino-pretty` (dev) | `13.1.3` | Human-readable logs in local development |
| `@biomejs/biome` (dev) | `2.5.10` | Lint + format |

`@libsql/client` is intentionally **not** a dependency yet — it will be added, with the same
vetting process, only when a later phase needs persistent control-plane state (sessions,
tickets). It is explicitly **not** used for anti-tamper (see §1.7).

## 8. Logging (Pino)

- Use `createLogger(contextName)` from `src/shared/logger.ts` — never instantiate Pino
  directly elsewhere, and never use `console.log` in application code (Biome's `noConsole`
  rule flags this).
- One child logger per bounded context (`createLogger('licensing')`, `createLogger('http')`,
  ...) so every line is traceable to its origin without manual tagging.
- **Configurable via env, validated by `src/shared/env.ts`**:
  - `LOG_LEVEL` — `trace|debug|info|warn|error|fatal`, default `info`.
  - `LOG_PRETTY` — `true` renders colorized, human-friendly output for local dev
    (`pino-pretty`); `false`/unset emits structured JSON for production log aggregation.
- **Redaction is automatic** for known sensitive field names (`licenseKey`, `signature`,
  `publicKey`, `privateKey`, `token`, `password`, and their nested `*.field` forms). Never
  bypass redaction by renaming a sensitive field to dodge the list — extend the redact list
  in `src/shared/logger.ts` instead.
- Log messages should be structured objects + a short human message
  (`logger.warn({ reason }, 'license validation failed')`), not concatenated strings.

## 9. Bun-specific conventions

- Target Bun `>=1.3`, adopting Bun 1.4+ features as they become relevant (this repo is
  developed against Bun 1.4.0).
- Use `bun:test` for all tests (no Jest/Vitest). Use `Bun.file`/`Bun.$` instead of Node's `fs`
  and `child_process` where a Bun-native API exists.
- Final packaging uses `bun build --compile` to produce a single native binary (Fase 5) —
  keep the entrypoint (`src/index.ts`) side-effect-light so it stays compile-friendly.
- Prefer `node:crypto` (Bun implements the Node-compatible API, including native Ed25519
  verify) over adding a third-party crypto library.

## 10. Testing — TDD is mandatory, three tiers

- **Red-green-refactor**: write the failing test first, implement the minimum to pass it, then
  refactor with the test as a safety net. Do not write production code without a preceding
  failing test, except for pure scaffolding/plumbing with no behavior to assert on.
- Three test tiers, all using `bun:test`:
  - `tests/unit/**`: fast, no external processes, no network, no real `dolt` binary calls —
    mock/inject those boundaries.
  - `tests/integration/**`: exercises real collaborators where it matters (e.g., a real
    temporary Dolt repository for the licensing anti-tamper logic).
  - `tests/smoke/**`: boots the actual module/process end-to-end and asserts observable
    behavior (e.g., correct exit code on a rejected boot).
- A phase branch does not merge into `main` unless `bun run test:unit`, `test:integration`, and
  `test:smoke` are all green, and `bun run lint` / `bun audit` report no new issues.

## 11. Licensing hygiene

- This repository is BSL 1.1. **Never copy code from Deltix-Client (MIT) or vice versa** —
  the only integration point between the two is the network contract (REST/gRPC), never shared
  source files or a shared package.
- Keep the `Additional Use Grant`, `Change Date`, and `Change License` in `LICENSE` untouched
  unless the Licensor explicitly changes licensing terms.
- Do not add code whose upstream license is incompatible with BSL 1.1 distribution without
  explicit sign-off.

## 12. Add-on orientation (Fase 4 forward)

- Every Add-on implements a stable, versioned contract (interface) defined in
  `contexts/addons`. Add-ons must not reach into another context's internals — only its
  `index.ts`.
- The license gate must run **before** the dynamic `import()` call for an Add-on, not after.
  An unauthorized Add-on's code must never execute or occupy memory.

## 13. Branching model

- **Trunk-based.** `main` always holds a working, tested state.
- One branch per roadmap phase (e.g. `phase-1-crypto-licensing`, `phase-2-rest-auth`, ...),
  merged into `main` only when its full test suite is green.
- Roadmap: (1) Cryptography & Licensing → (2) REST Control Plane & Auth (HonoJS) → (3) Ephemeral
  Tickets & gRPC Engine (:50051) → (4) Dynamic Add-on Loading → (5) Enterprise Packaging
  (Podman + single binary).
