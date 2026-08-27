import type { AddonTrustRecord } from './types';

/**
 * Persistence port for TOFU (Trust-On-First-Use) addon author keys.
 * See `types.ts` for the trust model rationale.
 */
export interface AddonTrustStore {
  /** Registers or replaces the trusted key for an addon name. */
  trust(record: AddonTrustRecord): Promise<void>;

  /** Returns the trusted key record for an addon, or `null` if never trusted. */
  getTrustedKey(addonName: string): Promise<AddonTrustRecord | null>;

  /** Revokes trust for an addon (e.g. the admin suspects key compromise). */
  revokeTrust(addonName: string): Promise<void>;

  /** Lists all currently-trusted addon names (used to enforce maxCommunityAddons). */
  listTrusted(): Promise<AddonTrustRecord[]>;
}
