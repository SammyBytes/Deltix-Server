/**
 * Short-lived access token (JWT/EdDSA) issuance and verification.
 *
 * Signed with Ed25519 (EdDSA), the same asymmetric-key discipline used in
 * `contexts/licensing/ed25519.ts` — never a shared HMAC secret (the
 * technical spec's example `jwt_secret = "ENTERPRISE_SECRET_KEY..."` is
 * exactly the anti-pattern this avoids). The private key signs; only the
 * public key is needed to verify, so it can be distributed to future
 * services without exposing signing capability.
 */
import { importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose';
import type { AccessTokenClaims } from './types';

const ALGORITHM = 'EdDSA';

export async function issueAccessToken(
  username: string,
  privateKeyPem: string,
  ttlSeconds: number,
): Promise<string> {
  const privateKey = await importPKCS8(privateKeyPem, ALGORITHM);
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(username)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(privateKey);
}

export async function verifyAccessToken(
  token: string,
  publicKeyPem: string,
): Promise<AccessTokenClaims> {
  const publicKey = await importSPKI(publicKeyPem, ALGORITHM);
  const { payload } = await jwtVerify(token, publicKey, { algorithms: [ALGORITHM] });

  if (!payload.sub || typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
    throw new Error('Access token is missing required claims');
  }

  return { sub: payload.sub, iat: payload.iat, exp: payload.exp };
}
