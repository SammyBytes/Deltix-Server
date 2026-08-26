/**
 * Shape of the signed license payload and the outcome of validating it.
 * Kept intentionally small for Fase 1 — grows in later phases as licensing
 * requirements expand (e.g. org identifiers, LDAP/OIDC scopes).
 */
export interface LicensePayload {
  licensee: string;
  tier: 'community' | 'enterprise';
  seats: number;
  /** Enterprise Add-ons this license authorizes (e.g. "auth-ldap", "storage-s3-backup"). */
  addons: string[];
  /** ISO 8601 timestamp. */
  issuedAt: string;
  /** ISO 8601 timestamp. Absent means the license does not expire. */
  expiresAt?: string;
  /** Unique-per-license random value, allows distinguishing reissued licenses. */
  nonce: string;
}

export type LicenseValidationResult =
  | { valid: true; license: LicensePayload }
  | { valid: false; reason: string };
