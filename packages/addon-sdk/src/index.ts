export { ADDON_CAPABILITIES, type AddonCapability, isAddonCapability } from './capabilities';
export type {
  AddonContext,
  AddonDbReader,
  AddonDbWriter,
  AddonHttpRegistrar,
  AddonModule,
  AddonNasReader,
  AddonRouteHandler,
} from './lifecycle';
export {
  type AddonManifest,
  addonManifestSchema,
  RESERVED_OFFICIAL_NAME_PREFIXES,
} from './manifest';
