/**
 * Closed list of capabilities an addon manifest may request. This list is
 * intentionally NOT extensible at runtime — see ADR 0001 §9.4. Requesting
 * any capability outside this list aborts boot-time loading of the addon.
 */
export const ADDON_CAPABILITIES = ['http:route', 'db:read', 'db:write', 'nas:read'] as const;

export type AddonCapability = (typeof ADDON_CAPABILITIES)[number];

export function isAddonCapability(value: string): value is AddonCapability {
  return (ADDON_CAPABILITIES as readonly string[]).includes(value);
}
