/**
 * Shared helper for generating throwaway self-signed TLS certs in tests
 * (unit/integration/smoke) that boot the gRPC transfer server, which
 * always requires TLS credentials (never a plaintext code path).
 */
import { join } from 'node:path';

export async function generateSelfSignedCert(
  dir: string,
): Promise<{ certPath: string; keyPath: string }> {
  const certPath = join(dir, 'server.crt');
  const keyPath = join(dir, 'server.key');
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
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);
  if (proc.exitCode !== 0) {
    throw new Error(`openssl failed: ${proc.stderr.toString()}`);
  }
  return { certPath, keyPath };
}
