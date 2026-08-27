# Context: addons

Status: **Fase 4 complete.** Full fail-closed dynamic addon system: manifest
validation, signature verification (official + community/TOFU), license
enforcement, isolated `import()`, and a runtime circuit breaker. See
`docs/decisions/0001-addon-licensing-and-business-model.md` for the full
business/security design and rationale (read that first if you need "why",
not just "how").

Only `index.ts` from this folder may be imported by other contexts (ACL
boundary) — never import `addon-loader.ts`, `addons.router.ts`, etc.
directly from outside this context.

## What lives here

| File | Responsibility |
|---|---|
| `addon-loader.ts` | Fail-closed pipeline for a single addon: manifest -> capability check -> signature -> license rules -> `import()`. |
| `addon-discovery.ts` | Boot-time orchestrator: discovers addon directories from `DELTIX_ADDON_PATHS`, loads each independently (one bad addon never aborts the batch or the process). |
| `addon-signature.ts` | Builds the exact byte payload that gets signed/verified (manifest + entrypoint bytes, canonical order). |
| `addon-circuit-breaker.ts` | Wraps addon-registered HTTP handlers; disables an addon in-memory after N consecutive runtime failures. |
| `addon-trust-store.ts` / `libsql-addon-trust-store.ts` | TOFU persistence for community addon author Ed25519 public keys (`addon_trust_store` table, libSQL). |
| `addons.router.ts` | REST API (`GET/POST /api/v1/addons/trust`, `POST /api/v1/addons/revoke`) so an admin can manage TOFU trust without touching the DB directly. |
| `create-addon-trust-store.ts` | Composition-root factory wiring the trust store from env — nothing else should construct `LibsqlAddonTrustStore` directly. |
| `errors.ts` | Typed fail-closed errors (`AddonManifestInvalidError`, `AddonSignatureInvalidError`, `AddonNotTrustedError`, `AddonLicenseDeniedError`, `AddonLimitExceededError`, `AddonCapabilityDeniedError`). |

The addon **contract** (types, manifest schema, closed capability list) lives
outside this context, in the MIT-licensed `packages/addon-sdk` workspace —
this context depends on it, never the other way around.

## Boot-time pipeline (what happens to every discovered addon)

1. Read + validate `addon.manifest.json` against `@deltix/addon-sdk`'s zod
   schema (name, version, tier, entrypoint, capabilities, anti-impersonation
   naming rule).
2. Reject any capability outside the closed 4-item list (`http:route`,
   `db:read`, `db:write`, `nas:read`) — defense in depth even though the SDK
   schema already enforces this.
3. Verify the detached signature (`addon.sig`) over the manifest + entrypoint
   bytes:
   - **official** tier -> verified against Deltix's own Ed25519 public key
     (`DELTIX_LICENSE_PUBLIC_KEY`, same key family as license signing).
   - **community** tier -> verified against the TOFU-trusted key for that
     addon name (`AddonTrustStore.getTrustedKey`). No trust record, or a
     signature that doesn't match the stored key -> refused.
4. Enforce the license payload's addon rules (`resolveLicenseAddonsConfig`):
   official addons must be in the free-or-licensed set; community addons
   require `communityAddonsEnabled: true` and must not exceed
   `maxCommunityAddons`.
5. **Only after all four steps pass** does the loader `import()` the
   entrypoint and call its default export's `activate()`.

Any failure at any step aborts loading **that addon only** — never the whole
batch or the control plane boot (`addon-discovery.ts` collects failures and
logs them; `src/index.ts` continues booting regardless).

## Operator runbook: trusting a community addon (TOFU)

1. The addon author generates a keypair and shares the printed public key:
   ```
   bun run scripts/generate-addon-author-keypair.ts ./my-addon-keys
   ```
2. The admin registers that exact public key once, either via the Admin Web
   UI ("Community addon trust (TOFU)" panel) or the REST API:
   ```
   curl -X POST https://<server>/api/v1/addons/trust \
     -H "authorization: Bearer $ACCESS_TOKEN" \
     -H 'content-type: application/json' \
     -d '{"addonName":"my-addon","authorPublicKey":"<base64 public key>"}'
   ```
3. The author signs their package (manifest + entrypoint bytes, see
   `addon-signature.ts` for the exact byte layout) with the matching private
   key and ships `addon.manifest.json` + entrypoint + `addon.sig` as a
   directory.
4. The admin adds that directory to `DELTIX_ADDON_PATHS` (comma-separated)
   and restarts the server. TOFU trust changes and `DELTIX_ADDON_PATHS`
   changes both take effect **only on the next restart** — there is no live
   reload in this Fase (see ADR 0001 §9.7, explicit non-goal).
5. Re-trusting the same addon name replaces the stored key (key rotation).
   `POST /api/v1/addons/revoke` removes a trust record entirely.

## Runtime isolation

Every HTTP route an addon registers via `ctx.http.register()` is wrapped by
`AddonCircuitBreaker`. If an addon's handler throws `DELTIX_ADDON_MAX_CONSECUTIVE_FAILURES`
times in a row (default 5), the breaker disables that addon **in memory
only** until the next process restart — the control plane and every other
addon keep running unaffected.

## Verifying this locally (real subprocess, no mocks)

`tests/smoke/addons-boot.smoke.test.ts` boots the actual server binary with
real signed addon packages on disk and a real libSQL trust store, and proves
over real HTTP that:
- a trusted community addon's route answers,
- an official addon's route answers,
- an **untrusted** community addon's route never gets registered, without
  crashing the control plane.

Run it directly with `bun test tests/smoke/addons-boot.smoke.test.ts`.
