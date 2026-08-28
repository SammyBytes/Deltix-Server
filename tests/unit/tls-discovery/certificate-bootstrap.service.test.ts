import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CertificateBootstrapService } from '../../../src/contexts/tls-discovery/certificate-bootstrap.service';
import { generateSelfSignedCert } from '../../fixtures/tls-fixtures';

describe('bootstrap/certificate-bootstrap.service', () => {
  let dir: string;
  let grpcCertPem: string;
  let httpCertPem: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'deltix-bootstrap-test-'));
    const grpc = await generateSelfSignedCert(dir);
    grpcCertPem = await Bun.file(grpc.certPath).text();

    const httpDir = mkdtempSync(join(tmpdir(), 'deltix-bootstrap-http-test-'));
    const http = await generateSelfSignedCert(httpDir);
    httpCertPem = await Bun.file(http.certPath).text();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exposes the gRPC certificate PEM and a computed SHA-256 fingerprint', () => {
    const service = new CertificateBootstrapService({ grpcCertPem });
    const { grpc, http } = service.getCertificates();

    expect(grpc.pem).toBe(grpcCertPem);
    expect(grpc.sha256Fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(http).toBeUndefined();
  });

  it('exposes the HTTP certificate separately when configured, with its own fingerprint', () => {
    const service = new CertificateBootstrapService({ grpcCertPem, httpCertPem });
    const { grpc, http } = service.getCertificates();

    expect(http?.pem).toBe(httpCertPem);
    expect(http?.sha256Fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    // Different certs (different keys/serials) must yield different fingerprints.
    expect(http?.sha256Fingerprint).not.toBe(grpc.sha256Fingerprint);
  });

  it('produces a stable, deterministic fingerprint for the same certificate', () => {
    const a = new CertificateBootstrapService({ grpcCertPem });
    const b = new CertificateBootstrapService({ grpcCertPem });

    expect(a.getCertificates().grpc.sha256Fingerprint).toBe(
      b.getCertificates().grpc.sha256Fingerprint,
    );
  });

  it('never includes any private key material in its output shape', () => {
    const service = new CertificateBootstrapService({ grpcCertPem, httpCertPem });
    const serialized = JSON.stringify(service.getCertificates());

    expect(serialized).not.toContain('PRIVATE KEY');
  });
});
