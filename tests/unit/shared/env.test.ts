import { beforeEach, describe, expect, it } from 'bun:test';
import { __resetEnvCacheForTests, loadEnv } from '../../../src/shared/env';

const VALID_ENV = {
  DELTIX_LICENSE_PUBLIC_KEY: 'test-public-key',
  DELTIX_LICENSE_KEY: 'test-license-key',
  DELTIX_DOLT_REPO_PATH: '/tmp/deltix-dolt-repo',
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
});
