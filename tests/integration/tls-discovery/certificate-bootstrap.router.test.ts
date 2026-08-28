import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCertificateBootstrapRouter } from '../../../src/contexts/tls-discovery/certificate-bootstrap.router';
import { CertificateBootstrapService } from '../../../src/contexts/tls-discovery/certificate-bootstrap.service';
import { generateSelfSignedCert } from '../../fixtures/tls-fixtures';

describe('bootstrap/certificate-bootstrap.router (integration)', () => {
  let dir: string;
  let grpcCertPem: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'deltix-bootstrap-router-test-'));
    const grpc = await generateSelfSignedCert(dir);
    grpcCertPem = await Bun.file(grpc.certPath).text();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the gRPC certificate PEM and fingerprint over a real HTTP request', async () => {
    const service = new CertificateBootstrapService({ grpcCertPem });
    const router = createCertificateBootstrapRouter(service);

    const response = await router.request('/certificate');
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.grpc.pem).toBe(grpcCertPem);
    expect(body.grpc.sha256Fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(body.http).toBeNull();
    expect(typeof body.warning).toBe('string');
  });

  it('rate-limits repeated requests from the same source IP', async () => {
    const service = new CertificateBootstrapService({ grpcCertPem });
    const router = createCertificateBootstrapRouter(service);

    const headers = { 'x-forwarded-for': '203.0.113.9' };
    let lastStatus = 0;
    for (let i = 0; i < 25; i++) {
      const response = await router.request('/certificate', { headers });
      lastStatus = response.status;
    }

    expect(lastStatus).toBe(429);
  });

  it('does not leak private key material in the response body', async () => {
    const service = new CertificateBootstrapService({ grpcCertPem });
    const router = createCertificateBootstrapRouter(service);

    const response = await router.request('/certificate');
    const text = await response.text();

    expect(text).not.toContain('PRIVATE KEY');
  });
});
