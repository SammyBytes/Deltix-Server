/**
 * Generates an Ed25519 keypair for signing community addon packages
 * (author-side tooling, NOT part of the server runtime).
 *
 * Prints the private key PEM to a local file (never to stdout — it must
 * never end up in shell history or CI logs) and prints the **public key**
 * to stdout in a single-line, base64, copy-paste-friendly format — this is
 * exactly the string an admin pastes into the Admin Web UI's "Trust a
 * community addon" form, or passes to `POST /api/v1/addons/trust`.
 *
 * Usage: bun run scripts/generate-addon-author-keypair.ts [outDir]
 * Defaults outDir to ./addon-author-keys (gitignored — NEVER commit this).
 */

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve(process.argv[2] ?? './addon-author-keys');
mkdirSync(outDir, { recursive: true });

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
// Raw Ed25519 public key is the last 32 bytes of the 44-byte SPKI DER encoding
// — this is the exact format the addon trust store expects (matches the
// server's own DELTIX_LICENSE_PUBLIC_KEY convention for consistency).
const rawPublicKeyBase64 = publicKeyDer.subarray(publicKeyDer.length - 32).toString('base64');

const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const privateKeyPath = resolve(outDir, 'addon-author-private-key.pem');

if (existsSync(privateKeyPath)) {
  console.error(`Refusing to overwrite existing private key at ${privateKeyPath}`);
  process.exit(1);
}
writeFileSync(privateKeyPath, privateKeyPem, { mode: 0o600 });

console.log('Addon author keypair generated.\n');
console.log(`Private key (KEEP SECRET, never commit): ${privateKeyPath}`);
console.log('\nPublic key (share this with any Deltix-Server admin who will trust your addon):\n');
console.log(rawPublicKeyBase64);
console.log(
  '\nAdmins register this exact string via the Admin Web UI (Addons > Trust a community ' +
    'addon) or POST /api/v1/addons/trust.',
);
