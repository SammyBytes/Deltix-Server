import {
  BranchNotFoundError,
  InvalidBranchNameError,
  InvalidCommitReferenceError,
  InvalidPaginationLimitError,
  RepoNotFoundError,
} from './errors';
import type { RepoStore } from './repo-store';
import type { LogCommitEntry } from './types';

const VALID_REPO_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const VALID_BRANCH = /^[A-Za-z0-9_][A-Za-z0-9_.\-/]{0,127}$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface LogCli {
  runDoltReadLog(params: {
    doltPath: string;
    branchName?: string;
    limit: number;
  }): Promise<LogCommitEntry[]>;
}

export class LogService {
  constructor(
    private readonly store: RepoStore,
    private readonly cli: LogCli,
  ) {}

  async list(
    repoId: string,
    options: { branch?: string; limit?: number },
  ): Promise<LogCommitEntry[]> {
    const repo = await this.requireRepo(repoId);
    if (options.branch) {
      this.assertBranchName(options.branch);
    }
    const limit = this.normalizeLimit(options.limit);
    return this.translateErrors(() =>
      this.cli.runDoltReadLog({
        doltPath: repo.doltPath,
        ...(options.branch ? { branchName: options.branch } : {}),
        limit,
      }),
    );
  }

  private normalizeLimit(limit?: number): number {
    if (limit === undefined) {
      return DEFAULT_LIMIT;
    }
    if (!Number.isInteger(limit) || limit < 1) {
      throw new InvalidPaginationLimitError(
        `Invalid limit "${String(limit)}": must be an integer between 1 and ${MAX_LIMIT}`,
      );
    }
    return Math.min(limit, MAX_LIMIT);
  }

  private assertRepoId(repoId: string): void {
    if (!VALID_REPO_ID.test(repoId)) {
      throw new RepoNotFoundError(`Repo not found: ${repoId}`);
    }
  }

  private assertBranchName(branchName: string): void {
    const normalized = branchName.trim();
    if (
      normalized.length === 0 ||
      normalized !== branchName ||
      !VALID_BRANCH.test(branchName) ||
      branchName.includes('..') ||
      branchName.startsWith('/') ||
      branchName.endsWith('/')
    ) {
      throw new InvalidBranchNameError(
        `Invalid branch name "${branchName}": must match ${VALID_BRANCH} and must not contain spaces, shell metacharacters, or path traversal sequences`,
      );
    }
  }

  private async requireRepo(repoId: string) {
    this.assertRepoId(repoId);
    const repo = await this.store.get(repoId);
    if (!repo) {
      throw new RepoNotFoundError(`Repo not found: ${repoId}`);
    }
    return repo;
  }

  private async translateErrors<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const lower = message.toLowerCase();
      if (lower.includes('not found') || lower.includes('unknown branch')) {
        throw new BranchNotFoundError(message);
      }
      if (lower.includes('unsafe commit hash')) {
        throw new InvalidCommitReferenceError(message);
      }
      throw err;
    }
  }
}
