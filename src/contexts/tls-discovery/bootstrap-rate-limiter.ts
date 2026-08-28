/**
 * Fixed-window per-source-IP limiter for the unauthenticated certificate
 * bootstrap endpoint. Mirrors `contexts/auth/login-rate-limiter.ts`'s
 * design (in-memory, single-process — appropriate at this MVP scale) but
 * is a separate, self-contained copy: contexts must never import each
 * other's internals (see .github/copilot-instructions.md §2 ACL rule).
 *
 * This exists because the bootstrap endpoint is intentionally
 * unauthenticated (a client has no credentials yet when it needs the
 * server's certificate) — rate limiting is the primary control against
 * it being abused as a scripted enumeration/recon vector.
 */
export class BootstrapRateLimiter {
  private readonly attempts = new Map<string, { count: number; windowStartedAt: number }>();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  isAllowed(key: string): boolean {
    const state = this.attempts.get(key);
    if (!state) return true;
    if (this.now() - state.windowStartedAt >= this.windowMs) {
      this.attempts.delete(key);
      return true;
    }
    return state.count < this.maxAttempts;
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
