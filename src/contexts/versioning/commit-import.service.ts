/**
 * Fase 4b: Imports commits from a client push into the server-side Dolt
 * repo. Each commit contains table data (CSV) that gets imported and
 * committed with the original message and author.
 *
 * This replaces the old file-transfer gRPC push with a structured
 * commit-based protocol over REST JSON.
 */

import { NonFastForwardError } from './errors';
import type { RepoStore } from './repo-store';

export interface ImportedTable {
  name: string;
  /** CREATE TABLE DDL (from `dolt schema export`) so the table — and its
   * primary key, which a bare CSV cannot carry — is recreated faithfully. */
  schema: string;
  data: string;
}

export interface ImportedCommit {
  message: string;
  author: string;
  tables: ImportedTable[];
}

export interface CommitImportResult {
  commitHash: string;
  repo: string;
}

export type RunDoltCommitImport = (params: {
  doltPath: string;
  authorName: string;
  message: string;
  tables: ImportedTable[];
}) => Promise<string>;

export type RunDoltBranchHead = (params: {
  doltPath: string;
  branch: string;
}) => Promise<string | null>;

/** Branch the server imports pushed commits onto (mirrors the client's default). */
export const DEFAULT_IMPORT_BRANCH = 'main';

export class CommitImportError extends Error {
  constructor(
    readonly command: string,
    readonly stderr: string,
  ) {
    super(`dolt ${command} failed during commit import: ${stderr.trim() || '(no stderr)'}`);
    this.name = 'CommitImportError';
  }
}

export class CommitImportService {
  constructor(
    private readonly store: RepoStore,
    private readonly runDoltCommitImport: RunDoltCommitImport,
    private readonly runDoltBranchHead?: RunDoltBranchHead,
  ) {}

  /**
   * Imports a batch of commits into the server-side Dolt repo.
   * Returns the commit hash of the last imported commit.
   *
   * When `from` is provided (the server head the client last pulled) and a
   * `runDoltBranchHead` reader is wired up, the push is rejected as
   * non-fast-forward unless `from` matches the current remote head — mirroring
   * git's refusal to overwrite/orphan a commit another dev has since pushed.
   */
  async importCommits(
    repoId: string,
    commits: ImportedCommit[],
    from?: string | null,
    branch = DEFAULT_IMPORT_BRANCH,
  ): Promise<CommitImportResult> {
    const record = await this.store.get(repoId);
    if (!record) {
      throw new CommitImportError('lookup', `Repo "${repoId}" not found`);
    }

    if (commits.length === 0) {
      throw new CommitImportError('validation', 'No commits to import');
    }

    if (from && this.runDoltBranchHead) {
      const currentHead = await this.runDoltBranchHead({ doltPath: record.doltPath, branch });
      if (currentHead && currentHead !== from) {
        throw new NonFastForwardError(
          'Remote rejected the push: the remote branch has advanced. Run `deltix pull` first, then push again.',
          from,
          currentHead,
        );
      }
    }

    let lastCommitHash = '';
    for (const commit of commits) {
      if (commit.tables.length === 0) {
        continue;
      }

      const commitHash = await this.runDoltCommitImport({
        doltPath: record.doltPath,
        authorName: commit.author,
        message: commit.message,
        tables: commit.tables,
      });
      lastCommitHash = commitHash;
    }

    if (!lastCommitHash) {
      throw new CommitImportError('import', 'No commits contained table data');
    }

    return { commitHash: lastCommitHash, repo: repoId };
  }
}
