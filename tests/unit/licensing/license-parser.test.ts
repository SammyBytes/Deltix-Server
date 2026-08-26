import { describe, expect, it } from 'bun:test';
import { LicenseMalformedError } from '../../../src/contexts/licensing/errors';
import { parseLicenseKey } from '../../../src/contexts/licensing/license-parser';
import {
  buildDefaultPayload,
  generateTestKeypair,
  signLicensePayload,
} from '../../fixtures/license-fixtures';

describe('licensing/license-parser', () => {
  it('parses a well-formed license key into payload + signature bytes', () => {
    const { privateKeyPem } = generateTestKeypair();
    const payload = buildDefaultPayload();
    const licenseKey = signLicensePayload(payload, privateKeyPem);

    const parsed = parseLicenseKey(licenseKey);

    expect(parsed.payload.licensee).toBe('Acme Corp');
    expect(parsed.payload.tier).toBe('enterprise');
    expect(parsed.payload.seats).toBe(10);
    expect(parsed.payload.addons).toEqual(['auth-ldap']);
    expect(parsed.signature.length).toBeGreaterThan(0);
  });

  it('rejects a license key without exactly one separator', () => {
    expect(() => parseLicenseKey('no-separator-here')).toThrow(LicenseMalformedError);
    expect(() => parseLicenseKey('too.many.dots.here')).toThrow(LicenseMalformedError);
  });

  it('rejects segments that are not valid base64url', () => {
    expect(() => parseLicenseKey('not valid base64url!.also-not-valid!')).toThrow(
      LicenseMalformedError,
    );
  });

  it('rejects a payload that is not valid JSON', () => {
    const notJson = Buffer.from('this is not json', 'utf8').toString('base64url');
    const fakeSignature = Buffer.from('sig', 'utf8').toString('base64url');
    expect(() => parseLicenseKey(`${notJson}.${fakeSignature}`)).toThrow(LicenseMalformedError);
  });

  it('rejects a payload missing required fields', () => {
    const incomplete = Buffer.from(JSON.stringify({ licensee: 'Acme' }), 'utf8').toString(
      'base64url',
    );
    const fakeSignature = Buffer.from('sig', 'utf8').toString('base64url');
    expect(() => parseLicenseKey(`${incomplete}.${fakeSignature}`)).toThrow(LicenseMalformedError);
  });

  it('rejects a payload with an invalid tier value', () => {
    const payload = buildDefaultPayload({ tier: 'gold' as never });
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const fakeSignature = Buffer.from('sig', 'utf8').toString('base64url');
    expect(() => parseLicenseKey(`${encoded}.${fakeSignature}`)).toThrow(LicenseMalformedError);
  });
});
