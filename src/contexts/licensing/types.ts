/**
 * Shape of the signed license payload and the outcome of validating it.
 * Kept intentionally small for Fase 1 — grows in later phases as licensing
 * requirements expand (e.g. org identifiers, LDAP/OIDC scopes).
 */
export interface LicensePayload {
  licensee: string;
  tier: 'community' | 'enterprise';
  seats: number;
  /**
   * Addon authorization rules for this license (Fase 4, ADR 0001). Optional
   * for backward compatibility with payloads issued before Fase 4 — absence
   * fails closed (no official addons beyond the free tier, no community
   * addons), never open by default.
   */
  addons?: LicenseAddonsConfig;
  /** ISO 8601 timestamp. */
  issuedAt: string;
  /** ISO 8601 timestamp. Absent means the license does not expire. */
  expiresAt?: string;
  /** Unique-per-license random value, allows distinguishing reissued licenses. */
  nonce: string;
}

export interface LicenseAddonsConfig {
  /** Paid official addon names this license unlocks (e.g. "sso-saml"). Free official addons are always available regardless of this list. */
  official: string[];
  /** Whether this instance may load ANY community (third-party) addon at all. */
  communityAddonsEnabled: boolean;
  /** Max community addons loadable at boot. `null` means unlimited (Enterprise tier). */
  maxCommunityAddons: number | null;
}

export type LicenseValidationResult =
  | { valid: true; license: LicensePayload }
  | { valid: false; reason: string };
