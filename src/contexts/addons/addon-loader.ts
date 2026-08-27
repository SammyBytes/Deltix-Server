/**
 * Fail-closed dynamic addon loader (Fase 4).
 *
 * Boot-time pipeline for every discovered addon, in this exact order — any
 * failure at any step aborts loading THAT addon (never the whole process;
 * one bad addon must not take down the control plane):
 *
 *   1. Read + validate `addon.manifest.json` against the SDK schema.
 *   2. Reject any capability outside the closed 4-item list (defense in
 *      depth: the SDK schema already enforces this, but a stale/forked SDK
 *      copy must not silently widen what's accepted).
 *   3. Verify the package signature:
 *        - official  -> Deltix's own Ed25519 key (same key family as
 *          license signing, `contexts/licensing/ed25519.ts`).
 *        - community -> the TOFU-trusted key from `AddonTrustStore`; an
 *          addon with no trust record, or a signature that doesn't match
 *          the stored key, is refused.
 *   4. Enforce the license payload's addon rules (tier defaults resolved
 *      via `resolveLicenseAddonsConfig`): official addons must be in the
 *      free-or-licensed set; community addons require
 *      `communityAddonsEnabled` and must not exceed `maxCommunityAddons`.
 *   5. Only then `import()` the entrypoint and call `activate()`.
 *
 * `import()` NEVER happens before all of the above pass for that addon.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddonContext, AddonManifest, AddonModule } from '@deltix/addon-sdk';
import { type AddonCapability, addonManifestSchema, isAddonCapability } from '@deltix/addon-sdk';
import type { LicenseAddonsConfig } from '../licensing';
import { verifyEd25519Signature } from '../licensing';
import { buildSignedPayload } from './addon-signature';
import type { AddonTrustStore } from './addon-trust-store';
import {
  AddonCapabilityDeniedError,
  AddonLicenseDeniedError,
  AddonLimitExceededError,
  AddonManifestInvalidError,
  AddonNotTrustedError,
  AddonSignatureInvalidError,
} from './errors';

export interface AddonLoadDeps {
  /** Deltix's own Ed25519 public key, used to verify official addons. */
  officialPublicKey: string;
  trustStore: AddonTrustStore;
  addonsConfig: LicenseAddonsConfig;
  /** Names of official addons that are always free (never gated by the license payload). */
  freeOfficialAddons: readonly string[];
  buildContext: (addonName: string, granted: readonly AddonCapability[]) => AddonContext;
}

export interface LoadedAddon {
  manifest: AddonManifest;
  module: AddonModule;
}

/**
 * Loads a single addon package rooted at `addonDir` (must contain
 * `addon.manifest.json` and the entrypoint it references). Throws one of
 * this context's typed errors on any fail-closed rejection; never returns a
 * partially-loaded addon.
 */
export async function loadAddon(addonDir: string, deps: AddonLoadDeps): Promise<LoadedAddon> {
  const manifest = await readAndValidateManifest(addonDir);
  assertClosedCapabilities(manifest);

  const manifestBytes = await readFile(join(addonDir, 'addon.manifest.json'));
  const entrypointPath = join(addonDir, manifest.entrypoint);
  const entrypointBytes = await readFile(entrypointPath);

  await verifySignature(manifest, manifestBytes, entrypointBytes, addonDir, deps);
  enforceLicenseRules(manifest, deps);

  const imported = (await import(entrypointPath)) as { default?: AddonModule };
  if (!imported.default || typeof imported.default.activate !== 'function') {
    throw new AddonManifestInvalidError(
      `Addon "${manifest.name}" entrypoint must default-export an object with an activate() function`,
    );
  }

  return { manifest, module: imported.default };
}

async function readAndValidateManifest(addonDir: string): Promise<AddonManifest> {
  const manifestPath = join(addonDir, 'addon.manifest.json');
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    throw new AddonManifestInvalidError(`Missing addon.manifest.json at ${manifestPath}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new AddonManifestInvalidError(`addon.manifest.json at ${manifestPath} is not valid JSON`);
  }

  const result = addonManifestSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new AddonManifestInvalidError(
      `addon.manifest.json at ${manifestPath} failed validation: ${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * Defense in depth: even though `addonManifestSchema` already restricts
 * `capabilities` to the closed enum, re-check with `isAddonCapability` in
 * case a stale/forked SDK copy loosened the schema. Fail closed on ANY
 * unrecognized capability string.
 */
function assertClosedCapabilities(manifest: AddonManifest): void {
  for (const capability of manifest.capabilities) {
    if (!isAddonCapability(capability)) {
      throw new AddonCapabilityDeniedError(
        `Addon "${manifest.name}" requested unknown capability "${capability}" — refusing to load`,
      );
    }
  }
}

async function verifySignature(
  manifest: AddonManifest,
  manifestBytes: Uint8Array,
  entrypointBytes: Uint8Array,
  addonDir: string,
  deps: AddonLoadDeps,
): Promise<void> {
  const signaturePath = join(addonDir, 'addon.sig');
  const payload = buildSignedPayload(manifestBytes, entrypointBytes);

  if (manifest.tier === 'official') {
    const signature = await readSignatureFile(signaturePath, manifest);
    if (!verifyEd25519Signature(payload, signature, deps.officialPublicKey)) {
      throw new AddonSignatureInvalidError(
        `Official addon "${manifest.name}" failed signature verification against the Deltix key`,
      );
    }
    return;
  }

  const trusted = await deps.trustStore.getTrustedKey(manifest.name);
  if (!trusted) {
    throw new AddonNotTrustedError(
      `Community addon "${manifest.name}" has no TOFU trust record — an admin must register its author's public key before it can load`,
    );
  }
  const signature = await readSignatureFile(signaturePath, manifest);
  if (!verifyEd25519Signature(payload, signature, trusted.authorPublicKey)) {
    throw new AddonSignatureInvalidError(
      `Community addon "${manifest.name}" signature does not match its trusted author key (key rotated without re-trust, or tampered package)`,
    );
  }
}

async function readSignatureFile(signaturePath: string, manifest: AddonManifest): Promise<Buffer> {
  try {
    return await readFile(signaturePath);
  } catch {
    throw new AddonSignatureInvalidError(
      `Addon "${manifest.name}" is missing its signature file at ${signaturePath}`,
    );
  }
}

function enforceLicenseRules(manifest: AddonManifest, deps: AddonLoadDeps): void {
  if (manifest.tier === 'official') {
    const isFree = deps.freeOfficialAddons.includes(manifest.name);
    const isLicensed = deps.addonsConfig.official.includes(manifest.name);
    if (!isFree && !isLicensed) {
      throw new AddonLicenseDeniedError(
        `Official addon "${manifest.name}" is not authorized by this license`,
      );
    }
    return;
  }

  if (!deps.addonsConfig.communityAddonsEnabled) {
    throw new AddonLicenseDeniedError(
      `Community addons are disabled by this license — refusing to load "${manifest.name}"`,
    );
  }
}

/**
 * Enforces `maxCommunityAddons` across a whole discovered set, called by
 * the boot-sequence orchestrator BEFORE attempting to load any addon in the
 * set beyond the limit (fail closed on the count, not on which ones win).
 */
export function assertWithinCommunityAddonLimit(
  communityAddonCount: number,
  addonsConfig: LicenseAddonsConfig,
): void {
  if (
    addonsConfig.maxCommunityAddons !== null &&
    communityAddonCount > addonsConfig.maxCommunityAddons
  ) {
    throw new AddonLimitExceededError(
      `This license allows at most ${addonsConfig.maxCommunityAddons} community addon(s), but ${communityAddonCount} were discovered`,
    );
  }
}
