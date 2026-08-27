import { beforeEach, describe, expect, it } from 'bun:test';
import { __resetEnvCacheForTests, loadEnv } from '../../../src/shared/env';

const VALID_ENV = {
  DELTIX_LICENSE_PUBLIC_KEY: 'test-public-key',
  DELTIX_LICENSE_KEY: 'test-license-key',
  DELTIX_DOLT_REPO_PATH: '/tmp/deltix-dolt-repo',
  DELTIX_JWT_PRIVATE_KEY: 'test-jwt-private-key',
  DELTIX_JWT_PUBLIC_KEY: 'test-jwt-public-key',
  DELTIX_LOCAL_USERS: JSON.stringify([{ username: 'alice', passwordHash: 'hash' }]),
  DELTIX_SESSION_DB_PATH: '/tmp/deltix-sessions.db',
  DELTIX_GRPC_TLS_CERT_PATH: '/tmp/deltix-grpc-cert.pem',
  DELTIX_GRPC_TLS_KEY_PATH: '/tmp/deltix-grpc-key.pem',
};

describe('shared/env', () => {
  beforeEach(() => {
    __resetEnvCacheForTests();
  });

  it('parses a valid environment and applies defaults', () => {
    const env = loadEnv(VALID_ENV);

    expect(env.DELTIX_LICENSE_PUBLIC_KEY).toBe('test-public-key');
    expect(env.DELTIX_CLOCK_TOLERANCE_MS).toBe(5000);
    expect(env.NODE_ENV).toBe('development');
  });

  it('fails fast when a required security-sensitive variable is missing', () => {
    const { DELTIX_LICENSE_PUBLIC_KEY: _omit, ...incomplete } = VALID_ENV;

    expect(() => loadEnv(incomplete)).toThrow();
  });

  it('coerces DELTIX_CLOCK_TOLERANCE_MS from a string env value', () => {
    const env = loadEnv({
      ...VALID_ENV,
      DELTIX_CLOCK_TOLERANCE_MS: '10000',
    });

    expect(env.DELTIX_CLOCK_TOLERANCE_MS).toBe(10000);
  });

  it('parses DELTIX_LOCAL_USERS from JSON into a typed array', () => {
    const env = loadEnv(VALID_ENV);

    expect(env.DELTIX_LOCAL_USERS).toEqual([{ username: 'alice', passwordHash: 'hash' }]);
  });

  it('rejects DELTIX_LOCAL_USERS that is not valid JSON', () => {
    expect(() => loadEnv({ ...VALID_ENV, DELTIX_LOCAL_USERS: 'not-json' })).toThrow();
  });

  it('rejects DELTIX_LOCAL_USERS with more than 3 seats (local-only tier limit)', () => {
    const tooMany = JSON.stringify(
      Array.from({ length: 4 }, (_, i) => ({ username: `user${i}`, passwordHash: 'hash' })),
    );

    expect(() => loadEnv({ ...VALID_ENV, DELTIX_LOCAL_USERS: tooMany })).toThrow();
  });

  it('defaults DELTIX_ADMIN_UI_ENABLED to false when unset', () => {
    const env = loadEnv(VALID_ENV);

    expect(env.DELTIX_ADMIN_UI_ENABLED).toBe(false);
  });

  it('coerces DELTIX_ADMIN_UI_ENABLED=true from a string env value', () => {
    const env = loadEnv({ ...VALID_ENV, DELTIX_ADMIN_UI_ENABLED: 'true' });

    expect(env.DELTIX_ADMIN_UI_ENABLED).toBe(true);
  });
});
