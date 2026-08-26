import { describe, expect, it } from 'bun:test';
import { TooManyLoginAttemptsError } from '../../../src/contexts/auth/errors';
import { LoginRateLimiter } from '../../../src/contexts/auth/login-rate-limiter';

describe('auth/login-rate-limiter', () => {
  it('allows attempts under the configured threshold', () => {
    const now = 0;
    const limiter = new LoginRateLimiter(5, 60_000, () => now);

    for (let i = 0; i < 5; i++) {
      expect(() => limiter.assertAllowed('alice')).not.toThrow();
      limiter.recordAttempt('alice');
    }
  });

  it('blocks further attempts once the threshold is exceeded within the window', () => {
    const now = 0;
    const limiter = new LoginRateLimiter(3, 60_000, () => now);

    for (let i = 0; i < 3; i++) {
      limiter.assertAllowed('alice');
      limiter.recordAttempt('alice');
    }

    expect(() => limiter.assertAllowed('alice')).toThrow(TooManyLoginAttemptsError);
  });

  it('resets the count once the window elapses', () => {
    let now = 0;
    const limiter = new LoginRateLimiter(2, 60_000, () => now);

    limiter.assertAllowed('alice');
    limiter.recordAttempt('alice');
    limiter.assertAllowed('alice');
    limiter.recordAttempt('alice');
    expect(() => limiter.assertAllowed('alice')).toThrow(TooManyLoginAttemptsError);

    now += 60_001;
    expect(() => limiter.assertAllowed('alice')).not.toThrow();
  });

  it('tracks attempts per-key independently (does not lock out other usernames)', () => {
    const now = 0;
    const limiter = new LoginRateLimiter(1, 60_000, () => now);

    limiter.assertAllowed('alice');
    limiter.recordAttempt('alice');
    expect(() => limiter.assertAllowed('alice')).toThrow(TooManyLoginAttemptsError);
    expect(() => limiter.assertAllowed('bob')).not.toThrow();
  });
});
