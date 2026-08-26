import { beforeEach, describe, expect, it } from 'bun:test';
import { __resetEnvCacheForTests, loadEnv } from '../../../src/shared/env';
import { __resetLoggerCacheForTests, createLogger } from '../../../src/shared/logger';

/**
 * Integration test: verifies that validating the app's (licensing) env vars
 * and creating a logger both work together during boot, without one module
 * accidentally requiring the other's configuration (see §2 ACL boundary —
 * `shared/logger.ts` is intentionally decoupled from `shared/env.ts`).
 */
describe('shared/env + shared/logger integration', () => {
  beforeEach(() => {
    __resetEnvCacheForTests();
    __resetLoggerCacheForTests();
  });

  it('boots a redacting logger independently of app-specific env validation', () => {
    const env = loadEnv({
      DELTIX_LICENSE_PUBLIC_KEY: 'test-public-key',
      DELTIX_LICENSE_KEY: 'test-license-key',
      DELTIX_DOLT_REPO_PATH: '/tmp/deltix-dolt-repo',
    });

    expect(env.DELTIX_LICENSE_PUBLIC_KEY).toBe('test-public-key');

    const logger = createLogger('integration-test');
    expect(() =>
      logger.info({ licenseKey: 'should-be-redacted' }, 'boot sequence check'),
    ).not.toThrow();
  });
});
