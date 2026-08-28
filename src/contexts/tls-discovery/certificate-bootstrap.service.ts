/**
 * Certificate bootstrap service: lets an operator opt in to exposing the
 * server's own TLS certificate fingerprint (and, optionally, the full PEM)
 * over an unauthenticated endpoint, so a Deltix-Client can automatically
 * discover and confirm trust for a self-signed certificate — the same
 * Trust-On-First-Use model SSH uses for host keys — instead of requiring
 * an operator to manually copy a `.crt` file off the server (which in
 * practice hits wrong-path assumptions and `sudo`-needs-a-TTY friction over
 * SSH).
 *
 * Privacy/security-by-design constraints (non-negotiable):
 * - NEVER reads or exposes a private key. This service is constructed only
 *   from already-public certificate PEM files — the same bytes a browser
 *   or `openssl s_client` already receives during any normal TLS
 *   handshake against this server. Nothing here is a secret; a
 *   certificate's whole purpose is to be shown to any client that
 *   connects. What IS sensitive is bulk, unauthenticated, trivially
 *   scriptable disclosure — this service treats the exposure itself as a
 *   resource to control, not the data.
 * - **Fail-closed opt-in**: disabled by default. An operator must
 *   explicitly enable it (`DELTIX_CERT_BOOTSTRAP_ENABLED=true`) — no
 *   implicit "TLS is on, so this turns on too" behavior.
 * - Only serves the certificate(s) the server was already configured to
 *   use for its own HTTP/gRPC TLS listeners; it can never be pointed at an
 *   arbitrary file path via request input.
 * - Rate-limited per source IP (see `certificate-bootstrap.router.ts`) to
 *   prevent this endpoint from being used as a trivial recon/enumeration
 *   vector against the deployment.
 */
import { createHash } from 'node:crypto';

export interface CertificateBootstrapConfig {
  /** PEM-encoded certificate served for the HTTP control plane, if configured. */
  httpCertPem?: string | undefined;
  /** PEM-encoded certificate served for the gRPC transfer engine. Always present — gRPC TLS is mandatory. */
  grpcCertPem: string;
}

export interface CertificateInfo {
  /** PEM-encoded certificate (public data only — never a private key). */
  pem: string;
  /** SHA-256 fingerprint of the DER-encoded certificate, colon-separated hex, for TOFU confirmation. */
  sha256Fingerprint: string;
}

export interface BootstrapCertificates {
  http?: CertificateInfo | undefined;
  grpc: CertificateInfo;
}

function pemToFingerprint(pem: string): string {
  const der = pemToDer(pem);
  const digest = createHash('sha256').update(new Uint8Array(der)).digest('hex').toUpperCase();
  return (digest.match(/.{1,2}/g) ?? []).join(':');
}

function pemToDer(pem: string): Buffer {
  const base64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  return Buffer.from(base64, 'base64');
}

export class CertificateBootstrapService {
  private readonly certificates: BootstrapCertificates;

  constructor(config: CertificateBootstrapConfig) {
    this.certificates = {
      http: config.httpCertPem
        ? { pem: config.httpCertPem, sha256Fingerprint: pemToFingerprint(config.httpCertPem) }
        : undefined,
      grpc: { pem: config.grpcCertPem, sha256Fingerprint: pemToFingerprint(config.grpcCertPem) },
    };
  }

  /** Returns fingerprints (and PEM bodies) for the certificates this server presents. Never includes a private key. */
  getCertificates(): BootstrapCertificates {
    return this.certificates;
  }
}
