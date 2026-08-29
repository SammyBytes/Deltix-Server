/**
 * Generates a self-signed TLS certificate + private key for a PRODUCTION
 * Deltix-Server deployment that serves the HTTP control plane (Admin Web UI
 * + REST API) and/or the gRPC transfer engine directly over TLS, with no
 * reverse proxy in front of it.
 *
 * This exists because the most common Deltix-Server deployment shape is an
 * internal/air-gapped VM with a bare IP address and no CA-signed cert or
 * reverse proxy available -- without this script, operators either run
 * everything over plain HTTP (breaking Secure cookies / browser trust) or
 * have to hand-roll an openssl invocation themselves. A self-signed cert is
 * NOT as good as a real CA-signed one (browsers will show a trust warning
 * on first visit -- that's expected and fine to click through once, or
 * import the cert into the client machine's trust store for a clean UX)
 * but it is a real, correct TLS certificate: same cipher suites, same
 * protocol, same protection against passive network eavesdropping as any
 * other cert -- it only differs in what already trusts its issuer.
 *
 * Usage:
 *   bun run scripts/generate-server-tls-cert.ts <hostname-or-ip> [moreNames...] [outDir]
 *
 * Examples:
 *   bun run scripts/generate-server-tls-cert.ts 10.1.10.129
 *   bun run scripts/generate-server-tls-cert.ts deltix.internal.corp 10.1.10.129 127.0.0.1
 *
 * Defaults outDir to ./certs/server (gitignored). Prints the exact env vars
 * to add to your server.env once done.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { resolve } from 'node:path';

function isIpAddress(value: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(value) || value.includes(':');
}

/**
 * When all requested identities are bare IPs, this script auto-derives a
 * machine-specific DNS-style name (this host's FQDN, falling back to the
 * short hostname) and adds it to the certificate's SAN. Node/gRPC and Bun
 * refuse to verify a bare IP as a TLS server name, so clients connecting to
 * the IP need a real, unique, non-IP name to present — which they can get
 * from the server operator/install summary without hard-coding any one
 * vendor's address. An explicit DNS argument (e.g. a FQDN the company knows
 * for this box) always wins over this auto-derivation.
 */
function deriveHostDnsName(): string {
  const fqdn = process.env.HOSTNAME_FQDN;
  if (fqdn && !isIpAddress(fqdn)) return fqdn;
  const hostname = osHostname();
  if (hostname && !isIpAddress(hostname)) return hostname;
  return 'deltix-server';
}

function usageAndExit(): never {
  console.error(
    'Usage: bun run scripts/generate-server-tls-cert.ts <hostname-or-ip> [moreNames...] [outDir]',
  );
  console.error('Example: bun run scripts/generate-server-tls-cert.ts 10.1.10.129');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  usageAndExit();
}

// The last argument is treated as outDir only if it looks like a path
// (contains a `/`) -- otherwise every argument is a SAN entry and we use
// the default outDir. This keeps the common case (`... <ip>`) simple while
// still allowing an explicit outDir override.
let outDirArg = './certs/server';
let sanEntries = args;
const last = args[args.length - 1];
if (last?.includes('/')) {
  outDirArg = last;
  sanEntries = args.slice(0, -1);
}
if (sanEntries.length === 0) {
  usageAndExit();
}

const outDir = resolve(outDirArg);
mkdirSync(outDir, { recursive: true });

const keyPath = resolve(outDir, 'server.key');
const certPath = resolve(outDir, 'server.crt');

if (existsSync(keyPath) || existsSync(certPath)) {
  console.error(
    `Refusing to overwrite existing certificate/key in ${outDir}. Remove them first if you ` +
      'really want to regenerate (this will invalidate any client that has pinned the old cert).',
  );
  process.exit(1);
}

const primaryName = sanEntries[0] as string;

// If every requested SAN is an IP address (the common "bare IP server" case),
// Node/gRPC and Bun refuse to use an IP as a TLS ServerName / SNI value (they
// throw `ERR_INVALID_ARG_VALUE: Setting the TLS ServerName to an IP address
// is not permitted`), so a CLI pointed at the IP could never verify the cert.
// Auto-derive this host's DNS-style name and add it to the SAN so there's
// always a real, machine-unique hostname a client can present as its
// server-name override, while still keeping the real IP so direct-IP
// connections also match.
const allAreIps = sanEntries.length > 0 && sanEntries.every(isIpAddress);
const autoDnsName = allAreIps ? deriveHostDnsName() : undefined;
const sanEntriesWithDns = allAreIps
  ? [autoDnsName as string, ...sanEntries]
  : sanEntries;

const sanList = sanEntriesWithDns
  .map((name) => (isIpAddress(name) ? `IP:${name}` : `DNS:${name}`))
  // Always also cover 127.0.0.1/localhost so local health checks and
  // loopback tooling work regardless of what the operator passed in.
  .concat(['DNS:localhost', 'IP:127.0.0.1'])
  .filter((entry, index, all) => all.indexOf(entry) === index)
  .join(',');

const subj = `/C=US/O=Deltix Self-Hosted/CN=${primaryName}`;
const san = `subjectAltName=${sanList}`;

console.log(`Generating a self-signed TLS certificate for: ${sanEntries.join(', ')}`);

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
  console.error(proc.stderr?.toString() ?? 'openssl failed with no stderr output');
  process.exit(1);
}

console.log(`\nCertificate written to: ${certPath}`);
console.log(`Private key written to: ${keyPath}`);
console.log('\nAdd these to your server.env to serve the HTTP control plane over HTTPS:');
console.log(`  DELTIX_HTTP_TLS_CERT_PATH=${certPath}`);
console.log(`  DELTIX_HTTP_TLS_KEY_PATH=${keyPath}`);
console.log(
  '\nThis is a self-signed certificate: browsers and the Deltix CLI will warn about an ' +
    'untrusted issuer on first connection. That warning is expected -- it does not mean the ' +
    'connection is insecure, only that this specific certificate was not signed by a public ' +
    'CA. For the CLI, point DELTIX_GRPC_TLS_CA_PATH (or the equivalent HTTPS CA trust option) ' +
    `at ${certPath} on each machine that needs to connect without a manual prompt.`,
);

if (allAreIps) {
  console.log(
    `\nYou requested an IP address, so this certificate also includes DNS:${autoDnsName} ` +
      '(Node/gRPC cannot verify a bare IP as a TLS server name). On each CLI client, set the ' +
      `server-name override to \`${autoDnsName}\` when the server is reached by its IP.`,
  );
}
