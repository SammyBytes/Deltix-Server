import { describe, expect, it } from 'bun:test';
import { BootstrapRateLimiter } from '../../../src/contexts/tls-discovery/bootstrap-rate-limiter';

describe('bootstrap/bootstrap-rate-limiter', () => {
  it('allows requests under the configured threshold', () => {
    const now = 0;
    const limiter = new BootstrapRateLimiter(3, 60_000, () => now);

    for (let i = 0; i < 3; i++) {
      expect(limiter.isAllowed('1.2.3.4')).toBe(true);
      limiter.recordAttempt('1.2.3.4');
    }
  });

  it('blocks further requests once the threshold is exceeded within the window', () => {
    const now = 0;
    const limiter = new BootstrapRateLimiter(2, 60_000, () => now);

    limiter.recordAttempt('1.2.3.4');
    limiter.recordAttempt('1.2.3.4');

    expect(limiter.isAllowed('1.2.3.4')).toBe(false);
  });

  it('tracks each key independently', () => {
    const now = 0;
    const limiter = new BootstrapRateLimiter(1, 60_000, () => now);

    limiter.recordAttempt('1.2.3.4');
    expect(limiter.isAllowed('1.2.3.4')).toBe(false);
    expect(limiter.isAllowed('5.6.7.8')).toBe(true);
  });

  it('resets the count once the window elapses', () => {
    let now = 0;
    const limiter = new BootstrapRateLimiter(1, 60_000, () => now);

    limiter.recordAttempt('1.2.3.4');
    expect(limiter.isAllowed('1.2.3.4')).toBe(false);

    now += 60_001;
    expect(limiter.isAllowed('1.2.3.4')).toBe(true);
  });
});
