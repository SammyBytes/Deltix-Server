import { describe, expect, it } from 'bun:test';
import { sign } from 'node:crypto';
import {
  loadEd25519PublicKey,
  verifyEd25519Signature,
} from '../../../src/contexts/licensing/ed25519';
import { generateTestKeypair } from '../../fixtures/license-fixtures';

describe('licensing/ed25519', () => {
  it('verifies a signature produced with the matching private key', () => {
    const { publicKeyBase64, privateKeyPem } = generateTestKeypair();
    const message = Buffer.from('hello deltix', 'utf8');
    const signature = sign(null, message, privateKeyPem);

    expect(verifyEd25519Signature(message, signature, publicKeyBase64)).toBe(true);
  });

  it('rejects a signature when the payload has been tampered with', () => {
    const { publicKeyBase64, privateKeyPem } = generateTestKeypair();
    const message = Buffer.from('hello deltix', 'utf8');
    const signature = sign(null, message, privateKeyPem);
    const tamperedMessage = Buffer.from('hello deltux', 'utf8');

    expect(verifyEd25519Signature(tamperedMessage, signature, publicKeyBase64)).toBe(false);
  });

  it('rejects a signature verified against the wrong public key', () => {
    const signer = generateTestKeypair();
    const attacker = generateTestKeypair();
    const message = Buffer.from('hello deltix', 'utf8');
    const signature = sign(null, message, signer.privateKeyPem);

    expect(verifyEd25519Signature(message, signature, attacker.publicKeyBase64)).toBe(false);
  });

  it('rejects a public key with an invalid raw length', () => {
    expect(() => loadEd25519PublicKey(Buffer.from('too-short').toString('base64'))).toThrow();
  });

  it('accepts a PEM-encoded SPKI public key as an alternative format', () => {
    const { publicKeyBase64, privateKeyPem } = generateTestKeypair();
    const key = loadEd25519PublicKey(publicKeyBase64);
    const pem = key.export({ type: 'spki', format: 'pem' }).toString();

    const message = Buffer.from('hello deltix', 'utf8');
    const signature = sign(null, message, privateKeyPem);

    expect(verifyEd25519Signature(message, signature, pem)).toBe(true);
  });
});
