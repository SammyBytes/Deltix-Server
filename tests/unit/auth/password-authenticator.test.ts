import { describe, expect, it } from 'bun:test';
import { InvalidCredentialsError } from '../../../src/contexts/auth/errors';
import { hashPassword, verifyCredentials } from '../../../src/contexts/auth/password-authenticator';
import type { LocalUser } from '../../../src/contexts/auth/types';

describe('auth/password-authenticator', () => {
  it('accepts the correct password for a known user', async () => {
    const passwordHash = await hashPassword('correct-horse-battery-staple');
    const users: LocalUser[] = [{ username: 'alice', passwordHash }];

    await expect(verifyCredentials('alice', 'correct-horse-battery-staple', users)).resolves.toBe(
      'alice',
    );
  });

  it('rejects an incorrect password', async () => {
    const passwordHash = await hashPassword('correct-horse-battery-staple');
    const users: LocalUser[] = [{ username: 'alice', passwordHash }];

    await expect(verifyCredentials('alice', 'wrong-password', users)).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it('rejects an unknown username without leaking whether the user exists (constant work)', async () => {
    const users: LocalUser[] = [{ username: 'alice', passwordHash: await hashPassword('x') }];

    await expect(verifyCredentials('bob', 'whatever', users)).rejects.toThrow(
      InvalidCredentialsError,
    );
  });
});
