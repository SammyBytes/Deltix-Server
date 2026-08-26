/**
 * Generates a self-signed TLS certificate + private key for the LOCAL
 * DEVELOPMENT gRPC transfer server (Fase 3, port 50051).
 *
 * THIS IS DEV-ONLY. It exists purely so a contributor can run the gRPC
 * engine locally without owning a real CA-signed certificate. Production
 * deployments MUST supply their own CA-signed certificate via
 * DELTIX_GRPC_TLS_CERT_PATH / DELTIX_GRPC_TLS_KEY_PATH — the gRPC server
 * never generates or manages certificates itself.
 *
 * Usage: bun run scripts/generate-dev-tls-certs.ts [outDir]
 * Defaults outDir to ./certs/dev (gitignored).
 */

import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve(process.argv[2] ?? './certs/dev');
mkdirSync(outDir, { recursive: true });

const keyPath = resolve(outDir, 'server.key');
const certPath = resolve(outDir, 'server.crt');

if (existsSync(keyPath) || existsSync(certPath)) {
  console.log(`[deltix] Dev TLS cert already exists at ${outDir} — skipping generation.`);
  console.log('[deltix] Delete the files there if you want to regenerate them.');
  process.exit(0);
}

// One self-contained openssl invocation: generates an EC (P-256) key and a
// self-signed cert valid for 825 days, covering localhost + 127.0.0.1 via
// a Subject Alternative Name so Node/Bun TLS clients accept it without
// hostname-mismatch errors.
const subj = '/C=US/O=Deltix Dev/CN=localhost';
const san = 'subjectAltName=DNS:localhost,IP:127.0.0.1';

const proc = Bun.spawnSync([
  'openssl',
  'req',
  '-x509',
  '-newkey',
  'ec',
  '-pkeyopt',
  'ec_paramgen_curve:P-256',
  '-nodes',
  '-keyout',
  keyPath,
  '-out',
  certPath,
  '-days',
  '825',
  '-subj',
  subj,
  '-addext',
  san,
]);

if (proc.exitCode !== 0) {
  console.error('[deltix] openssl failed to generate the dev TLS certificate:');
  console.error(proc.stderr.toString());
  process.exit(1);
}

console.log('[deltix] Self-signed DEV-ONLY TLS certificate generated:');
console.log(`  key:  ${keyPath}`);
console.log(`  cert: ${certPath}`);
console.log('');
console.log('Set these env vars to use it with the gRPC transfer server:');
console.log(`  DELTIX_GRPC_TLS_CERT_PATH=${certPath}`);
console.log(`  DELTIX_GRPC_TLS_KEY_PATH=${keyPath}`);
console.log('');
console.log('WARNING: self-signed cert. NEVER use this in production. Clients');
console.log('connecting to a real deployment must validate a real CA chain.');
