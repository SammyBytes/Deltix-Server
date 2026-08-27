/**
 * Parses the `base64url(payload_json).base64url(signature)` license key
 * format. This is NOT a JWT — it intentionally avoids that name/format to
 * stay distinct from the developer-session auth tokens introduced in Fase 2.
 *
 * This module only validates *shape* (well-formed base64url, valid JSON,
 * required fields present with the right types). It does NOT verify the
 * cryptographic signature — that is `ed25519.ts`'s job, kept separate so
 * shape validation can fail fast and cheaply before any crypto is attempted.
 */
import { LicenseMalformedError } from './errors';
import type { LicenseAddonsConfig, LicensePayload } from './types';

export interface ParsedLicenseKey {
  payloadBytes: Uint8Array;
  payload: LicensePayload;
  signature: Uint8Array;
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function parseLicenseKey(licenseKey: string): ParsedLicenseKey {
  const parts = licenseKey.split('.');
  if (parts.length !== 2) {
    throw new LicenseMalformedError(
      `License key must have the form "<payload>.<signature>", got ${parts.length} segment(s)`,
    );
  }

  const [payloadPart, signaturePart] = parts as [string, string];
  if (!BASE64URL_PATTERN.test(payloadPart) || !BASE64URL_PATTERN.test(signaturePart)) {
    throw new LicenseMalformedError('License key segments must be valid base64url');
  }

  const payloadBytes = Buffer.from(payloadPart, 'base64url');
  const signature = Buffer.from(signaturePart, 'base64url');

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    throw new LicenseMalformedError('License payload is not valid JSON');
  }

  const payload = assertIsLicensePayload(parsedJson);
  return { payloadBytes, payload, signature };
}

/**
 * Resolves the effective addon rules for a license, applying ADR 0001's
 * tier-based fail-closed defaults when the payload omits `addons` entirely
 * (e.g. licenses issued before Fase 4). Community tier defaults to a
 * generous-but-bounded community addon allowance; Enterprise defaults to
 * unlimited community addons. Both fail closed on official paid addons
 * (empty list) when unspecified.
 */
export function resolveLicenseAddonsConfig(payload: LicensePayload): LicenseAddonsConfig {
  if (payload.addons) {
    return payload.addons;
  }
  if (payload.tier === 'community') {
    return { official: [], communityAddonsEnabled: true, maxCommunityAddons: 10 };
  }
  return { official: [], communityAddonsEnabled: true, maxCommunityAddons: null };
}

function assertIsLicensePayload(value: unknown): LicensePayload {
  if (typeof value !== 'object' || value === null) {
    throw new LicenseMalformedError('License payload must be a JSON object');
  }
  const v = value as Record<string, unknown>;

  assertLicensee(v);
  assertTier(v);
  assertSeats(v);
  assertAddons(v);
  assertIssuedAt(v);
  assertExpiresAt(v);
  assertNonce(v);

  return v as unknown as LicensePayload;
}

function assertLicensee(v: Record<string, unknown>): void {
  if (typeof v.licensee !== 'string' || v.licensee.length === 0) {
    throw new LicenseMalformedError('License payload missing a valid "licensee"');
  }
}

function assertTier(v: Record<string, unknown>): void {
  if (v.tier !== 'community' && v.tier !== 'enterprise') {
    throw new LicenseMalformedError('License payload "tier" must be "community" or "enterprise"');
  }
}

function assertSeats(v: Record<string, unknown>): void {
  if (typeof v.seats !== 'number' || !Number.isFinite(v.seats) || v.seats < 1) {
    throw new LicenseMalformedError('License payload "seats" must be a positive number');
  }
}

function assertAddons(v: Record<string, unknown>): void {
  if (v.addons === undefined) {
    return;
  }
  if (typeof v.addons !== 'object' || v.addons === null || Array.isArray(v.addons)) {
    throw new LicenseMalformedError('License payload "addons" must be an object when present');
  }
  const addons = v.addons as Record<string, unknown>;

  if (
    !Array.isArray(addons.official) ||
    !addons.official.every((name) => typeof name === 'string')
  ) {
    throw new LicenseMalformedError(
      'License payload "addons.official" must be an array of strings',
    );
  }
  if (typeof addons.communityAddonsEnabled !== 'boolean') {
    throw new LicenseMalformedError(
      'License payload "addons.communityAddonsEnabled" must be a boolean',
    );
  }
  const maxCommunityAddons = addons.maxCommunityAddons;
  const isValidMax =
    maxCommunityAddons === null ||
    (typeof maxCommunityAddons === 'number' &&
      Number.isFinite(maxCommunityAddons) &&
      maxCommunityAddons >= 0);
  if (!isValidMax) {
    throw new LicenseMalformedError(
      'License payload "addons.maxCommunityAddons" must be a non-negative number or null',
    );
  }
}

function assertIssuedAt(v: Record<string, unknown>): void {
  if (typeof v.issuedAt !== 'string' || Number.isNaN(Date.parse(v.issuedAt))) {
    throw new LicenseMalformedError('License payload "issuedAt" must be a valid ISO 8601 date');
  }
}

function assertExpiresAt(v: Record<string, unknown>): void {
  if (
    v.expiresAt !== undefined &&
    (typeof v.expiresAt !== 'string' || Number.isNaN(Date.parse(v.expiresAt)))
  ) {
    throw new LicenseMalformedError('License payload "expiresAt" must be a valid ISO 8601 date');
  }
}

function assertNonce(v: Record<string, unknown>): void {
  if (typeof v.nonce !== 'string' || v.nonce.length === 0) {
    throw new LicenseMalformedError('License payload missing a valid "nonce"');
  }
}
