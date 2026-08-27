import { z } from 'zod';
import { ADDON_CAPABILITIES } from './capabilities';

/**
 * Reserved name prefixes for the "official" brand. A community-tier addon
 * may NEVER use one of these prefixes in its name, regardless of what it
 * claims — this is enforced independently of (and in addition to) the
 * cryptographic signature check, because branding impersonation is a
 * social-engineering risk even when the signature already prevents an
 * actual authority bypass. See ADR 0001 §9.6 (naming/anti-impersonation).
 */
export const RESERVED_OFFICIAL_NAME_PREFIXES = ['deltix-', 'official-'] as const;

/**
 * Schema for `addon.manifest.json`. `tier` determines which signature
 * verification path applies (official: Deltix key, community: TOFU trust
 * store) — see ADR 0001 §9.3.
 */
export const addonManifestSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    tier: z.enum(['official', 'community']),
    entrypoint: z.string().min(1),
    capabilities: z.array(z.enum(ADDON_CAPABILITIES)),
    authorPublicKey: z.string().min(1).optional(),
  })
  .refine(
    (manifest) =>
      manifest.tier === 'official' ||
      !RESERVED_OFFICIAL_NAME_PREFIXES.some((prefix) => manifest.name.startsWith(prefix)),
    {
      message: `Community addons may not use a reserved official-looking name prefix (${RESERVED_OFFICIAL_NAME_PREFIXES.join(', ')})`,
      path: ['name'],
    },
  );

export type AddonManifest = z.infer<typeof addonManifestSchema>;
