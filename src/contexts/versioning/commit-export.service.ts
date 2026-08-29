/**
 * Fase 5.9 (pull, server half): exports commits from a repo's Dolt history so
 * a client can `deltix pull` them. This is the read-side mirror of
 * `commit.service.ts`/`dolt-commit-cli.ts`: it enumerates the commits on a
 * branch that a client hasn't seen yet (`from` hash) and, for each, the CSV
 * snapshot of every table it changed — the exact structure `push-commits`
 * accepts in reverse.
 *
 * Deliberately yields an async generator (not a materialized array) so the
 * HTTP layer can stream NDJSON commit-by-commit: a first-time clone of a large
 * repo stays flat in memory on both ends.
 */
import { RepoNotFoundError } from './errors';
import type { RepoStore } from './repo-store';

export interface ExportedTable {
  name: string;
  data: string;
}

export interface ExportedCommit {
  hash: string;
  message: string;
  author: string;
  tables: ExportedTable[];
}

export interface RepoRef {
  branch: string;
  hash: string;
}

export type RunDoltCommitExport = (params: {
  doltPath: string;
  branch: string;
  fromHash: string | null;
}) => AsyncGenerator<ExportedCommit>;

export type RunDoltBranchHead = (params: {
  doltPath: string;
  branch: string;
}) => Promise<string | null>;

export type RunDoltListRefs = (params: { doltPath: string }) => Promise<RepoRef[]>;

export class CommitExportService {
  constructor(
    private readonly store: RepoStore,
    private readonly runExport: RunDoltCommitExport,
    private readonly runBranchHead: RunDoltBranchHead,
    private readonly runListRefs: RunDoltListRefs,
  ) {}

  /** Current head hash of a branch (or `null` if the repo/branch is unknown). */
  async getBranchHead(repoId: string, branch = 'main'): Promise<string | null> {
    const record = await this.requireRepo(repoId);
    return this.runBranchHead({ doltPath: record.doltPath, branch });
  }

  /** All branch name -> head pairs, for a client's `fetch` negotiation. */
  async listRefs(repoId: string): Promise<RepoRef[]> {
    const record = await this.requireRepo(repoId);
    return this.runListRefs({ doltPath: record.doltPath });
  }

  /**
   * Yields commits on `branch` reachable since `fromHash` (oldest-first), each
   * carrying the CSV data of the tables it changed. When `fromHash` is null the
   * full history is exported (a first clone). The `dolt init` commit (empty
   * diff) is omitted.
   */
  async *streamCommits(
    repoId: string,
    branch = 'main',
    fromHash?: string | null,
  ): AsyncGenerator<ExportedCommit> {
    const record = await this.requireRepo(repoId);
    for await (const commit of this.runExport({
      doltPath: record.doltPath,
      branch,
      fromHash: fromHash ?? null,
    })) {
      yield commit;
    }
  }

  private async requireRepo(repoId: string) {
    const record = await this.store.get(repoId);
    if (!record) {
      throw new RepoNotFoundError(`Repo not found: ${repoId}`);
    }
    return record;
  }
}
