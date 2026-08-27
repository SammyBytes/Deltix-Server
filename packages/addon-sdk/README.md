# @deltix/addon-sdk

MIT-licensed contract for building **Deltix-Server** addons.

This package is intentionally minimal: it exports only types, zod schemas and
interfaces. It has **zero** imports from the BSL-licensed core (`src/` in
`Deltix-Server`) — an addon author can build entirely against this package
without ever touching or depending on the proprietary control plane code.

See `docs/decisions/0001-addon-licensing-and-business-model.md` in
`Deltix-Server` for the full addon licensing/loading design this SDK
implements the contract for.

## Exports

- `ADDON_CAPABILITIES` / `isAddonCapability()` — the closed list of
  permissions an addon manifest may request (`http:route`, `db:read`,
  `db:write`, `nas:read`). Requesting anything else is rejected at boot time.
- `addonManifestSchema` / `AddonManifest` — zod schema + type for
  `addon.manifest.json`.
- `AddonContext`, `AddonModule`, `AddonHttpRegistrar`, `AddonDbReader`,
  `AddonDbWriter`, `AddonNasReader` — lifecycle contracts an addon's
  entrypoint module must (partially) implement, depending on the
  capabilities it declares.
