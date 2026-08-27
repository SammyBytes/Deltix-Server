import type { TransferJob } from './types';

/**
 * Persistence port for transfer jobs (SSD staging -> NAS sync pipeline).
 * Same discipline as `contexts/transfer/ticket-store.ts`: every state
 * transition MUST be a single atomic conditional write (`UPDATE ... WHERE
 * status = '<expected>'`) — never read-then-write — so that concurrent
 * sync workers can never double-process (or lose) the same job.
 */
export interface TransferJobStore {
  /** Inserts a brand-new job in the `staged` state. */
  create(job: TransferJob): Promise<void>;

  get(jobId: string): Promise<TransferJob | null>;

  /**
   * Atomically claims ONE job that is eligible to sync right now — either
   * freshly `staged`, or `sync_failed` with `nextRetryAt <= now` — and
   * transitions it to `syncing`. Returns the claimed job, or `null` if none
   * are eligible. Must be implemented so that concurrent callers racing
   * this method can never claim the same row (e.g. an atomic UPDATE ...
   * RETURNING, or UPDATE-by-id-then-verify-rowsAffected keyed off a prior
   * SELECT ... LIMIT 1 that is safe because only one worker's UPDATE can
   * match a given still-staged/still-sync_failed row).
   */
  claimNextEligible(now: number): Promise<TransferJob | null>;

  /** Atomically transitions `syncing` -> `synced`. Returns true iff it won. */
  markSynced(jobId: string): Promise<boolean>;

  /**
   * Atomically transitions `syncing` -> `sync_failed` (if retries remain)
   * or `syncing` -> `dead_letter` (if `retryCount` has reached
   * `maxRetries`), recording the error and, for the retry case, the next
   * eligible retry time. Returns true iff it won the transition.
   */
  markFailed(jobId: string, error: string, nextRetryAt: number): Promise<boolean>;

  /**
   * Manual operator action: atomically transitions `dead_letter` -> `staged`
   * (re-enters the pipeline from the top, retryCount reset to 0) so it can
   * be picked up by `claimNextEligible` again.
   */
  requeueDeadLetter(jobId: string): Promise<boolean>;

  /** Lists jobs currently in `dead_letter`, for manual review/API/UI. */
  listDeadLetter(): Promise<TransferJob[]>;
}
