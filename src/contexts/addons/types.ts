/**
 * Types for addon trust records (TOFU: Trust-On-First-Use).
 *
 * A community addon's package is signed by its own author's Ed25519 key —
 * Deltix does not control that key. The admin registers
 * `(addonName, authorPublicKey)` once ("I trust this key for this addon
 * name"); every subsequent boot re-verifies the addon's signature against
 * the SAME stored key. A mismatch (key rotated without re-trust, or a
 * tampered package) fails closed.
 */
export interface AddonTrustRecord {
  addonName: string;
  /** Base64-encoded raw 32-byte Ed25519 public key of the addon author. */
  authorPublicKey: string;
  /** Epoch milliseconds when this trust was granted. */
  trustedAt: number;
  /** Identity of the admin/operator who granted trust (audit trail). */
  trustedBy: string;
}
