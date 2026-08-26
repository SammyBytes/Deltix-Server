/**
 * Public types for the "storage" bounded context (Fase 3 continued:
 * SSD staging -> NAS sync pipeline).
 *
 * A transfer job is a SEPARATE entity from a transfer ticket
 * (`contexts/transfer`). A ticket authorizes a gRPC session to move bytes;
 * a job tracks what happens to those bytes AFTER they land on local SSD
 * staging — promoting them to NAS is a distinct, independently-retryable
 * concern with its own failure modes (NAS unreachable, disk full, checksum
 * mismatch) that must not block or be conflated with the ticket lifecycle.
 *
 * Job state machine:
 *   STAGED -> SYNCING -> SYNCED               (happy path)
 *   STAGED -> SYNCING -> SYNC_FAILED -> SYNCING (retry, up to maxRetries)
 *   SYNC_FAILED -> DEAD_LETTER                  (retries exhausted; requires
 *                                                manual operator action)
 *   DEAD_LETTER -> SYNCING                      (manual retry via API)
 */

export type TransferJobStatus = 'staged' | 'syncing' | 'synced' | 'sync_failed' | 'dead_letter';

export interface TransferJob {
  id: string;
  repo: string;
  /** Absolute path of the staged file on local SSD. */
  stagingPath: string;
  /** SHA-256 checksum computed at staging time, verified again post-copy. */
  checksum: string;
  status: TransferJobStatus;
  retryCount: number;
  maxRetries: number;
  /** Epoch ms; when a SYNC_FAILED job becomes eligible for the next retry. */
  nextRetryAt: number;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
}
