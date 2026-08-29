/**
 * Fase 5.2: records a real, immutable Dolt commit for a repo that has
 * just received a successfully-staged push. Deliberately narrow in scope
 * for this sub-phase: it does NOT yet apply the transferred payload as
 * actual application-schema Dolt table rows (that requires a real
 * schema/data import format, planned for a later sub-phase per the ADR).
 * Instead, `runDoltCommit` (the real CLI implementation, see
 * `dolt-cli.ts`) upserts a row into a `deltix_push_log` table that lives
 * INSIDE the repo's own Dolt database and commits that change — so every
 * push produces a real, queryable (`dolt sql -q "select * from
 * deltix_push_log"`), tamper-evident `dolt log` entry, not just an empty
 * commit message.
 *
 * Silently a no-op for a `repo` that was never provisioned via Fase 5.1
 * (`RepoStore.get()` returns null) — pushing to a repoId that has no Dolt
 * repo behind it is legal (backward-compatible with the Fase 3/4
 * NAS-sim-only flow) and simply does not produce a commit.
 */
import { CommitFailedError } from './errors';
import type { RepoStore } from './repo-store';

export interface PushCommitParams {
  repo: string;
  username: string;
  jobId: string;
  checksum: string;
  /** Resolved table set from sync-prefs FK closure, if any. */
  resolvedTables?: string[];
}

export type RunDoltCommit = (params: {
  doltPath: string;
  authorName: string;
  jobId: string;
  checksum: string;
  tables?: string[];
}) => Promise<string>;

export class CommitService {
  constructor(
    private readonly store: RepoStore,
    private readonly runDoltCommit: RunDoltCommit,
  ) {}

  /**
   * Returns the new commit hash, or `null` if `repo` has no provisioned
   * Dolt repository (nothing to commit to).
   */
  async recordPush(params: PushCommitParams): Promise<string | null> {
    const record = await this.store.get(params.repo);
    if (!record) {
      return null;
    }

    try {
      return await this.runDoltCommit({
        doltPath: record.doltPath,
        authorName: params.username,
        jobId: params.jobId,
        checksum: params.checksum,
        tables: params.resolvedTables,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CommitFailedError(
        `Failed to record Dolt commit for repo "${params.repo}": ${message}`,
      );
    }
  }
}
