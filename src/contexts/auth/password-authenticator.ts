/**
 * Password hashing/verification for local users (Fase 2 — up to 3 seats per
 * the technical spec; LDAP/OIDC identity providers are an Enterprise add-on
 * scheduled for a later phase).
 *
 * Uses `Bun.password` (argon2id by default) — never a hand-rolled hash.
 * Comparison is always run, even for an unknown username, to avoid leaking
 * "username exists" via response-time side channels (OWASP A07).
 */
import { InvalidCredentialsError } from './errors';
import type { LocalUser } from './types';

const DUMMY_HASH_FOR_TIMING_PARITY =
  '$argon2id$v=19$m=65536,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export async function hashPassword(plainPassword: string): Promise<string> {
  return Bun.password.hash(plainPassword, { algorithm: 'argon2id' });
}

/**
 * Verifies credentials against the configured local users, returning the
 * matched username on success. Always performs a hash comparison — even
 * when the username isn't found — so failure timing doesn't reveal whether
 * the username exists.
 */
export async function verifyCredentials(
  username: string,
  plainPassword: string,
  users: LocalUser[],
): Promise<string> {
  const user = users.find((candidate) => candidate.username === username);
  const hashToCompare = user?.passwordHash ?? DUMMY_HASH_FOR_TIMING_PARITY;

  const isValid = await Bun.password.verify(plainPassword, hashToCompare);
  if (!user || !isValid) {
    throw new InvalidCredentialsError();
  }

  return user.username;
}
