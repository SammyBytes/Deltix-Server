/**
 * Placeholder for the "licensing" bounded context.
 *
 * This is the ONLY file other contexts/modules are allowed to import from
 * (ACL boundary). Internals of this context must never be imported directly
 * from outside (e.g. `contexts/licensing/some-internal-file`).
 *
 * Real implementation (Ed25519 signature verification + Dolt-log-backed
 * anti-tamper) lives on the `phase-1-crypto-licensing` branch. See README.md
 * in this folder and .github/copilot-instructions.md for architecture rules.
 */
export {};
