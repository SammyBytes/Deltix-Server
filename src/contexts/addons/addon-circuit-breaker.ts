/**
 * Runtime isolation for addon-registered HTTP routes: wraps every handler
 * so an unhandled exception inside an addon never propagates into (or
 * crashes) the host control plane. Tracks consecutive failures per addon;
 * after `maxConsecutiveFailures`, the addon is disabled in memory for the
 * remainder of the process's lifetime (a restart is required to re-enable
 * it — intentionally simple for the Fase 4 MVP, see ADR 0001 §9.5).
 */
import type { AddonRouteHandler } from '@deltix/addon-sdk';

export interface AddonCircuitBreakerOptions {
  maxConsecutiveFailures: number;
  onDisabled?: (addonName: string) => void;
}

export class AddonCircuitBreaker {
  private readonly failureCounts = new Map<string, number>();
  private readonly disabled = new Set<string>();

  constructor(private readonly options: AddonCircuitBreakerOptions) {}

  isDisabled(addonName: string): boolean {
    return this.disabled.has(addonName);
  }

  /** Wraps a single addon route handler with the error boundary + breaker. */
  wrap(addonName: string, handler: AddonRouteHandler): AddonRouteHandler {
    return async (request: Request): Promise<Response> => {
      if (this.disabled.has(addonName)) {
        return new Response('Addon disabled after repeated failures', { status: 503 });
      }
      try {
        const response = await handler(request);
        this.failureCounts.set(addonName, 0);
        return response;
      } catch {
        this.recordFailure(addonName);
        return new Response('Addon route handler failed', { status: 500 });
      }
    };
  }

  private recordFailure(addonName: string): void {
    const count = (this.failureCounts.get(addonName) ?? 0) + 1;
    this.failureCounts.set(addonName, count);
    if (count >= this.options.maxConsecutiveFailures) {
      this.disabled.add(addonName);
      this.options.onDisabled?.(addonName);
    }
  }
}
