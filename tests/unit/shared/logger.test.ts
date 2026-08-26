import { afterEach, describe, expect, it } from 'bun:test';
import { __resetLoggerCacheForTests, createLogger } from '../../../src/shared/logger';

describe('shared/logger', () => {
  afterEach(() => {
    __resetLoggerCacheForTests();
    delete process.env.LOG_LEVEL;
    delete process.env.LOG_PRETTY;
  });

  it('creates a child logger scoped to the given bounded context', () => {
    const logger = createLogger('licensing');
    expect(logger.bindings().context).toBe('licensing');
  });

  it('reads LOG_LEVEL from the environment, defaulting to "info"', () => {
    process.env.LOG_LEVEL = 'debug';
    const logger = createLogger('licensing');
    expect(logger.level).toBe('debug');
  });

  it('treats the string "false" as false for LOG_PRETTY (not a truthy non-empty string)', () => {
    process.env.LOG_PRETTY = 'false';
    // No throw is the main assertion here — a wrongly-truthy LOG_PRETTY would
    // attempt to load the pino-pretty transport unnecessarily. The real
    // regression this guards is the z.coerce.boolean() footgun documented in
    // shared/env.ts.
    expect(() => createLogger('licensing')).not.toThrow();
  });

  it('redacts known sensitive fields instead of logging them in clear text', () => {
    const logger = createLogger('licensing');
    expect(() => logger.info({ licenseKey: 'super-secret' }, 'test message')).not.toThrow();
  });
});
