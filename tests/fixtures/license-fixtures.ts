/**
 * Test-only helpers to generate Ed25519 keypairs and signed license keys.
 * NEVER reuse these helpers or their output outside of tests — production
 * keys must come from the real Licensor key management process.
 */
import { generateKeyPairSync, sign } from 'node:crypto';

export interface TestLicensePayload {
  licensee: string;
  tier: 'community' | 'enterprise';
  seats: number;
  addons: string[];
  issuedAt: string;
  expiresAt?: string;
  nonce: string;
}

export interface TestKeypair {
  /** Raw 32-byte Ed25519 public key, base64-encoded — the env var format. */
  publicKeyBase64: string;
  privateKeyPem: string;
}

export function generateTestKeypair(): TestKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');

  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  // Raw Ed25519 public key is the last 32 bytes of the 44-byte SPKI DER encoding.
  const rawPublicKey = publicKeyDer.subarray(publicKeyDer.length - 32);

  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  return { publicKeyBase64: rawPublicKey.toString('base64'), privateKeyPem };
}

export function buildDefaultPayload(
  overrides: Partial<TestLicensePayload> = {},
): TestLicensePayload {
  return {
    licensee: 'Acme Corp',
    tier: 'enterprise',
    seats: 10,
    addons: ['auth-ldap'],
    issuedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    nonce: 'test-nonce-1',
    ...overrides,
  };
}

/** Signs a payload and returns the `base64url(payload).base64url(signature)` license key string. */
export function signLicensePayload(payload: TestLicensePayload, privateKeyPem: string): string {
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = sign(null, payloadBytes, privateKeyPem);

  return `${payloadBytes.toString('base64url')}.${signature.toString('base64url')}`;
}

export interface TestJwtKeypairPem {
  privateKeyPem: string;
  publicKeyPem: string;
}

/** Generates a fresh Ed25519 PEM keypair for signing/verifying JWTs in tests. */
export function generateTestJwtKeypairPem(): TestJwtKeypairPem {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}
