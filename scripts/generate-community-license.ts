#!/usr/bin/env bun
/**
 * Generates a real (production-grade, non-test-fixture) self-signed
 * Community-tier license: a fresh Ed25519 keypair plus a signed license
 * payload for it.
 *
 * Why self-signing is correct here: Deltix never depends on an internet
 * connection or an external licensing server to validate a license (see
 * README's "does not require internet access to validate licenses"
 * design principle). For the free, self-hosted Community tier, the
 * operator IS the licensor — this script lets them locally mint their own
 * valid license instead of hand-writing an Ed25519 signature. Enterprise
 * tier licenses (paid, seat-limited, SSO/RBAC) still come from Deltix's
 * real licensing process; this script only ever emits `tier: "community"`.
 *
 * This is intentionally separate from tests/fixtures/license-fixtures.ts,
 * which is explicitly test-only and must never be imported outside tests.
 *
 * Usage:
 *   bun run scripts/generate-community-license.ts [licensee] [seats]
 *
 * Prints DELTIX_LICENSE_PUBLIC_KEY and DELTIX_LICENSE_KEY as `key=value`
 * lines on stdout so callers (including scripts/install.sh) can capture
 * them without parsing human-readable text.
 */
import { generateKeyPairSync, sign } from 'node:crypto';

const licensee = process.argv[2] ?? 'Self-Hosted Community Install';
const seats = Number.parseInt(process.argv[3] ?? '3', 10);

if (!Number.isFinite(seats) || seats < 1) {
  console.error('seats must be a positive integer');
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
// Raw Ed25519 public key is the last 32 bytes of the 44-byte SPKI DER encoding
// (see src/contexts/licensing/ed25519.ts for the accepted encodings).
const rawPublicKey = publicKeyDer.subarray(publicKeyDer.length - 32);
const publicKeyBase64 = rawPublicKey.toString('base64');

const payload = {
  licensee,
  tier: 'community' as const,
  seats,
  addons: { official: [], communityAddonsEnabled: true, maxCommunityAddons: 10 },
  issuedAt: new Date().toISOString(),
  nonce: crypto.randomUUID(),
};

const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
const signature = sign(null, payloadBytes, privateKey);
const licenseKey = `${payloadBytes.toString('base64url')}.${signature.toString('base64url')}`;

// The private key never needs to be stored anywhere: it only exists long
// enough to produce this one signature. Losing it is harmless — re-run
// this script to mint a fresh license if one is ever needed again.
console.log(`DELTIX_LICENSE_PUBLIC_KEY=${publicKeyBase64}`);
console.log(`DELTIX_LICENSE_KEY=${licenseKey}`);
