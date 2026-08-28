#!/usr/bin/env bun
/**
 * Generates a real (production-grade, non-test-fixture) Ed25519 keypair
 * for signing/verifying Deltix-Server access tokens (DELTIX_JWT_PRIVATE_KEY
 * / DELTIX_JWT_PUBLIC_KEY).
 *
 * This is intentionally separate from tests/fixtures/license-fixtures.ts,
 * which is explicitly test-only and must never be imported outside tests.
 *
 * Usage:
 *   bun run scripts/generate-jwt-keypair.ts
 *
 * Prints DELTIX_JWT_PRIVATE_KEY and DELTIX_JWT_PUBLIC_KEY as `key=value`
 * lines, each with the raw multi-line PEM wrapped in double quotes.
 * systemd's EnvironmentFile format supports a quoted value that spans
 * multiple physical lines (verified: the embedded real newline is kept
 * as part of the value, unlike a literal `\n` escape sequence, which
 * systemd does NOT unescape) -- so callers can drop this output directly
 * into deltix.env as-is.
 */
import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');

const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString().trim();
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString().trim();

console.log(`DELTIX_JWT_PRIVATE_KEY="${privateKeyPem}"`);
console.log(`DELTIX_JWT_PUBLIC_KEY="${publicKeyPem}"`);
