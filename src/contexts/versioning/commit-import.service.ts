/**
 * Fase 4b: Imports commits from a client push into the server-side Dolt
 * repo. Each commit contains table data (CSV) that gets imported and
 * committed with the original message and author.
 *
 * This replaces the old file-transfer gRPC push with a structured
 * commit-based protocol over REST JSON.
 */
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
  ) {}

  /**
   * Imports a batch of commits into the server-side Dolt repo.
   * Returns the commit hash of the last imported commit.
   */
  async importCommits(repoId: string, commits: ImportedCommit[]): Promise<CommitImportResult> {
    const record = await this.store.get(repoId);
    if (!record) {
      throw new CommitImportError('lookup', `Repo "${repoId}" not found`);
    }

    if (commits.length === 0) {
      throw new CommitImportError('validation', 'No commits to import');
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
