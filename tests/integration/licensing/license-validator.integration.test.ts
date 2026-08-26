import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { DoltCliCommitLogReader } from '../../../src/contexts/licensing/dolt-commit-log.reader';
import { LicenseValidatorService } from '../../../src/contexts/licensing/license-validator.service';
import {
  buildDefaultPayload,
  generateTestKeypair,
  signLicensePayload,
} from '../../fixtures/license-fixtures';

describe('licensing/license-validator.service (integration, real dolt repo)', () => {
  let repoPath: string;

  beforeAll(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'deltix-dolt-repo-'));
    await $`dolt config --global --add user.name deltix-test`.quiet().nothrow();
    await $`dolt config --global --add user.email deltix-test@example.com`.quiet().nothrow();
    const init = await $`dolt --data-dir ${repoPath} init`.quiet().nothrow();
    if (init.exitCode !== 0) {
      throw new Error(`Failed to init test Dolt repo: ${init.stderr.toString()}`);
    }
  });

  afterAll(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it('validates a well-formed, correctly signed, non-expired license end-to-end', async () => {
    const { publicKeyBase64, privateKeyPem } = generateTestKeypair();
    const payload = buildDefaultPayload();
    const licenseKey = signLicensePayload(payload, privateKeyPem);

    const validator = new LicenseValidatorService({
      licenseKey,
      publicKeyMaterial: publicKeyBase64,
      commitLogReader: new DoltCliCommitLogReader(repoPath),
      clockToleranceMs: 5000,
    });

    const result = await validator.validateOnBoot();

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.license.licensee).toBe('Acme Corp');
    }
  });

  it('rejects a license with a bad signature', async () => {
    const signer = generateTestKeypair();
    const attacker = generateTestKeypair();
    const payload = buildDefaultPayload();
    const licenseKey = signLicensePayload(payload, signer.privateKeyPem);

    const validator = new LicenseValidatorService({
      licenseKey,
      publicKeyMaterial: attacker.publicKeyBase64, // wrong public key
      commitLogReader: new DoltCliCommitLogReader(repoPath),
      clockToleranceMs: 5000,
    });

    const result = await validator.validateOnBoot();
    expect(result.valid).toBe(false);
  });

  it('rejects an expired license', async () => {
    const { publicKeyBase64, privateKeyPem } = generateTestKeypair();
    const payload = buildDefaultPayload({
      expiresAt: new Date('2020-01-01T00:00:00.000Z').toISOString(),
    });
    const licenseKey = signLicensePayload(payload, privateKeyPem);

    const validator = new LicenseValidatorService({
      licenseKey,
      publicKeyMaterial: publicKeyBase64,
      commitLogReader: new DoltCliCommitLogReader(repoPath),
      clockToleranceMs: 5000,
    });

    const result = await validator.validateOnBoot();
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/expired/i);
    }
  });

  it('blocks boot (fail-closed) when the system clock is behind the latest Dolt commit', async () => {
    const { publicKeyBase64, privateKeyPem } = generateTestKeypair();
    const payload = buildDefaultPayload();
    const licenseKey = signLicensePayload(payload, privateKeyPem);

    // Simulate a clock that is far in the past relative to the real commit timestamp.
    const rolledBackNow = () => new Date('2000-01-01T00:00:00.000Z');

    const validator = new LicenseValidatorService({
      licenseKey,
      publicKeyMaterial: publicKeyBase64,
      commitLogReader: new DoltCliCommitLogReader(repoPath),
      clockToleranceMs: 5000,
      now: rolledBackNow,
    });

    const result = await validator.validateOnBoot();
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/clock/i);
    }
  });
});
