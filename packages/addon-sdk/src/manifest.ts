import { z } from 'zod';
import { ADDON_CAPABILITIES } from './capabilities';

/**
 * Schema for `addon.manifest.json`. `tier` determines which signature
 * verification path applies (official: Deltix key, community: TOFU trust
 * store) — see ADR 0001 §9.3.
 */
export const addonManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  tier: z.enum(['official', 'community']),
  entrypoint: z.string().min(1),
  capabilities: z.array(z.enum(ADDON_CAPABILITIES)),
  authorPublicKey: z.string().min(1).optional(),
});

export type AddonManifest = z.infer<typeof addonManifestSchema>;
