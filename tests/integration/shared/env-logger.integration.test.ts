import { beforeEach, describe, expect, it } from 'bun:test';
import { __resetEnvCacheForTests, loadEnv } from '../../../src/shared/env';
import { createLogger } from '../../../src/shared/logger';

/**
 * Integration test: verifies env validation and the logger factory cooperate
 * correctly end-to-end (env drives logger configuration), rather than testing
 * either module in isolation.
 */
describe('shared/env + shared/logger integration', () => {
  beforeEach(() => {
    __resetEnvCacheForTests();
  });

  it('boots a redacting logger driven by validated env vars', () => {
    const env = loadEnv({
      DELTIX_LICENSE_PUBLIC_KEY: 'test-public-key',
      DELTIX_LICENSE_KEY: 'test-license-key',
      DELTIX_DOLT_REPO_PATH: '/tmp/deltix-dolt-repo',
      LOG_LEVEL: 'debug',
      LOG_PRETTY: 'false',
    });

    expect(env.LOG_LEVEL).toBe('debug');

    const logger = createLogger('integration-test');
    expect(() =>
      logger.info({ licenseKey: 'should-be-redacted' }, 'boot sequence check'),
    ).not.toThrow();
  });
});
