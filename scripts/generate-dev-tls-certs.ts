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
  process.exit(1);
}
