/**
 * Canonical byte-signing scheme for addon packages.
 *
 * The signature covers BOTH the manifest and the entrypoint file bytes,
 * concatenated with a fixed separator — this binds a manifest's declared
 * capabilities/tier to the exact code that will be `import()`-ed, so an
 * attacker can't swap a benign manifest onto malicious code (or vice versa)
 * without invalidating the signature.
 */
const SEPARATOR = Buffer.from('\u0000DELTIX-ADDON\u0000', 'utf8');

export function buildSignedPayload(manifestBytes: Uint8Array, entrypointBytes: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(manifestBytes), SEPARATOR, Buffer.from(entrypointBytes)]);
}
