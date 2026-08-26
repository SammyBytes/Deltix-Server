import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { issueAccessToken, verifyAccessToken } from '../../../src/contexts/auth/jwt-issuer';

function generateTestEd25519KeyPairPem(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

describe('auth/jwt-issuer', () => {
  it('issues a JWT that verifies successfully with the matching public key', async () => {
    const { privateKeyPem, publicKeyPem } = generateTestEd25519KeyPairPem();

    const token = await issueAccessToken('alice', privateKeyPem, 900);
    const claims = await verifyAccessToken(token, publicKeyPem);

    expect(claims.sub).toBe('alice');
  });

  it('rejects a token signed with a different private key', async () => {
    const { privateKeyPem } = generateTestEd25519KeyPairPem();
    const { publicKeyPem: wrongPublicKeyPem } = generateTestEd25519KeyPairPem();

    const token = await issueAccessToken('alice', privateKeyPem, 900);

    await expect(verifyAccessToken(token, wrongPublicKeyPem)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const { privateKeyPem, publicKeyPem } = generateTestEd25519KeyPairPem();

    // -1 second TTL: token is already expired the instant it's issued.
    const token = await issueAccessToken('alice', privateKeyPem, -1);

    await expect(verifyAccessToken(token, publicKeyPem)).rejects.toThrow();
  });
});
