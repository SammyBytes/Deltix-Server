/**
 * Public API of the "addons" bounded context (Fase 4: Dynamic Add-on
 * Loading). This is the ONLY module other contexts are allowed to import
 * from — see .github/copilot-instructions.md for the ACL boundary rule.
 *
 * Implements the fail-closed pipeline from
 * docs/decisions/0001-addon-licensing-and-business-model.md:
 * manifest validation -> closed-capability check -> signature verification
 * (official: Deltix key: community: TOFU trust store) -> license payload
 * check -> `import()`, plus a runtime error-boundary/circuit-breaker for
 * addon-registered routes.
 */
export { AddonCircuitBreaker, type AddonCircuitBreakerOptions } from './addon-circuit-breaker';
export { type AddonDiscoveryResult, discoverAndLoadAddons } from './addon-discovery';
export {
  type AddonLoadDeps,
  assertWithinCommunityAddonLimit,
  type LoadedAddon,
  loadAddon,
} from './addon-loader';
export type { AddonTrustStore } from './addon-trust-store';
export { createAddonTrustStore } from './create-addon-trust-store';
export {
  AddonCapabilityDeniedError,
  AddonLicenseDeniedError,
  AddonLimitExceededError,
  AddonManifestInvalidError,
  AddonNotTrustedError,
  AddonSignatureInvalidError,
} from './errors';
export type { AddonTrustRecord } from './types';
