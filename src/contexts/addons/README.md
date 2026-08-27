# Context: addons

Status: Fase 4 in progress (dynamic Add-on loading via `import()`, gated by
the active license). See
`docs/decisions/0001-addon-licensing-and-business-model.md` for the full
design.

Implemented so far:
- `AddonTrustStore` / `LibsqlAddonTrustStore`: TOFU (Trust-On-First-Use)
  persistence for community addon author Ed25519 public keys
  (`addon_trust_store` table). The admin registers a key once per addon
  name; every subsequent boot re-verifies the addon package's signature
  against the SAME stored key — a mismatch fails closed.

Still to come in this Fase:
- The fail-closed dynamic loader: signature verification -> manifest
  capability check (against the closed 4-capability list from
  `@deltix/addon-sdk`) -> license payload check (tier, communityAddonsEnabled,
  maxCommunityAddons) -> `import()`.
- Runtime error-boundary + circuit breaker wrapping addon-registered routes.

Only `index.ts` from this folder may be imported by other contexts (ACL boundary).
