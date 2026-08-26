/**
 * Fixed-window per-key login attempt limiter (mitigates brute-force,
 * OWASP A07). In-memory by design — Fase 2 runs as a single control-plane
 * process; a distributed limiter would be premature for this MVP scale.
 */
import { TooManyLoginAttemptsError } from './errors';

interface WindowState {
  count: number;
  windowStartedAt: number;
}

export class LoginRateLimiter {
  private readonly attempts = new Map<string, WindowState>();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  assertAllowed(key: string): void {
    const state = this.attempts.get(key);
    if (!state) {
      return;
    }
    if (this.now() - state.windowStartedAt >= this.windowMs) {
      this.attempts.delete(key);
      return;
    }
    if (state.count >= this.maxAttempts) {
      const retryAfterMs = this.windowMs - (this.now() - state.windowStartedAt);
      throw new TooManyLoginAttemptsError(retryAfterMs);
    }
  }

  recordAttempt(key: string): void {
    const state = this.attempts.get(key);
    const currentNow = this.now();
    if (!state || currentNow - state.windowStartedAt >= this.windowMs) {
      this.attempts.set(key, { count: 1, windowStartedAt: currentNow });
      return;
    }
    state.count += 1;
  }
}
