import { describe, expect, it } from 'bun:test';
import { createLogger } from '../../src/shared/logger';

describe('scaffolding smoke test', () => {
  it('creates a scoped logger without throwing', () => {
    process.env.DELTIX_LICENSE_PUBLIC_KEY ??= 'test-placeholder';
    process.env.DELTIX_LICENSE_KEY ??= 'test-placeholder';
    process.env.DELTIX_DOLT_REPO_PATH ??= '/tmp/deltix-scaffold-smoke';

    const logger = createLogger('smoke');
    expect(logger).toBeDefined();
    expect(() => logger.info('scaffold boots correctly')).not.toThrow();
  });
});
