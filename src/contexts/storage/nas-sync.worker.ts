/**
 * Polling worker loop for `NasSyncService`. Runs `processNext()` on a
 * fixed interval, draining ALL currently-eligible jobs each tick (not just
 * one) before sleeping again, so a burst of staged jobs doesn't wait
 * multiple intervals to start syncing. Deliberately simple (no external
 * job-queue dependency) — acceptable for MVP scale; the atomic claim
 * semantics in `TransferJobStore` are what actually keep this safe under
 * concurrency, not the scheduling mechanism.
 */
import type { NasSyncService } from './nas-sync.service';

export class NasSyncWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private draining = false;

  constructor(
    private readonly service: NasSyncService,
    private readonly intervalMs: number,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.drainOnce();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Drains all currently-eligible jobs. Exposed for tests/manual ticks. */
  async drainOnce(): Promise<void> {
    // Reentrancy guard: if a previous tick is still draining a long backlog
    // when the next interval fires, skip — never run two drains at once
    // from the SAME worker instance (multiple worker instances/processes
    // racing each other is fine and expected; it's the store's atomic
    // claim that guarantees safety there).
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      let processed = await this.service.processNext();
      while (processed) {
        processed = await this.service.processNext();
      }
    } catch (err) {
      this.onError(err);
    } finally {
      this.draining = false;
    }
  }
}
