/**
 * Anti-tamper / anti-clock-rollback check.
 *
 * The server's own operating-system clock cannot be trusted in isolation —
 * an operator could wind it back to make an expired or revoked license
 * appear valid again. Instead, we compare "now" against the timestamp of the
 * most recent commit in Dolt's own immutable commit graph (`dolt_log`),
 * which this process cannot itself rewrite. If "now" is behind that
 * timestamp by more than the configured tolerance, boot must be refused.
 *
 * This function is deliberately pure and synchronous — no I/O — so it can be
 * unit-tested without a real Dolt repository. Reading the actual timestamp
 * is `dolt-commit-log.reader.ts`'s job.
 */
import { ClockRollbackDetectedError } from './errors';

export function assertNoClockRollback(
  now: Date,
  latestCommitTimestamp: Date | null,
  toleranceMs: number,
): void {
  if (latestCommitTimestamp === null) {
    // No commit history yet — nothing to compare against.
    return;
  }

  const driftMs = latestCommitTimestamp.getTime() - now.getTime();
  if (driftMs > toleranceMs) {
    throw new ClockRollbackDetectedError(
      `System clock (${now.toISOString()}) is behind the latest Dolt commit ` +
        `(${latestCommitTimestamp.toISOString()}) by ${driftMs}ms, exceeding the allowed ` +
        `tolerance of ${toleranceMs}ms. Refusing to boot (possible clock manipulation).`,
    );
  }
}
