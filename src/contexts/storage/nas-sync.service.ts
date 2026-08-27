/**
 * Orchestrates the staging -> NAS sync pipeline as two independent stages
 * joined by job state, NOT a single monolithic pipeline function: staging
 * (writing to local SSD) already happened by the time a `TransferJob`
 * exists; this service only owns the SYNCING stage — claim a job, copy to
 * NAS via `NasAdapter`, verify checksum, mark synced — with automatic
 * capped-retry-with-backoff on failure and a manual dead-letter escape
 * hatch for when retries are exhausted (an operator must act, we never
 * silently drop data).
 *
 * `now` is injectable for deterministic tests (same convention as
 * `TicketService`/`SlidingWindowSessionManager`).
 */
import { ChecksumMismatchError } from './errors';
import type { NasAdapter } from './nas-adapter';
import type { TransferJobStore } from './transfer-job-store';

/** Exponential backoff, capped, jittered lightly is out of scope for MVP;
 *  deterministic exponential is sufficient and easiest to test/reason about. */
function computeBackoffMs(retryCount: number, baseMs: number, maxMs: number): number {
  const delay = baseMs * 2 ** retryCount;
  return Math.min(delay, maxMs);
}

export class NasSyncService {
  constructor(
    private readonly store: TransferJobStore,
    private readonly nas: NasAdapter,
    private readonly options: {
      backoffBaseMs?: number;
      backoffMaxMs?: number;
    } = {},
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Attempts to sync exactly one eligible job (freshly staged, or a
   * sync_failed job whose backoff window has elapsed). Returns `false` if
   * there was nothing eligible to do (caller should back off / wait for
   * the next tick), `true` if a job was processed (synced or failed —
   * check job state afterwards for the outcome).
   */
  async processNext(): Promise<boolean> {
    const job = await this.store.claimNextEligible(this.now());
    if (!job) {
      return false;
    }

    try {
      const { checksum } = await this.nas.copyToNas(job.stagingPath, job.repo);
      if (checksum !== job.checksum) {
        throw new ChecksumMismatchError();
      }
      await this.store.markSynced(job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const backoffMs = computeBackoffMs(
        job.retryCount,
        this.options.backoffBaseMs ?? 1000,
        this.options.backoffMaxMs ?? 60_000,
      );
      await this.store.markFailed(job.id, message, this.now() + backoffMs);
    }
    return true;
  }

  /** Manual operator action: re-enters a dead-letter job into the pipeline. */
  async retryDeadLetter(jobId: string): Promise<boolean> {
    return this.store.requeueDeadLetter(jobId);
  }

  async listDeadLetter() {
    return this.store.listDeadLetter();
  }
}
