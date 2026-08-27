import { BranchNotFoundError, InvalidCommitReferenceError, RepoNotFoundError } from './errors';
import type { RepoStore } from './repo-store';
import type { DiffResult } from './types';

const VALID_REPO_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const VALID_BRANCH = /^[A-Za-z0-9_][A-Za-z0-9_.\-/]{0,127}$/;
const VALID_COMMIT_HASH = /^[0-9a-z]{32}$/;

interface DiffCli {
  runDoltReadDiff(params: {
    doltPath: string;
    fromRef: string;
    toRef: string;
  }): Promise<DiffResult>;
}

export class DiffService {
  constructor(
    private readonly store: RepoStore,
    private readonly cli: DiffCli,
  ) {}

  async read(repoId: string, fromRef: string, toRef: string): Promise<DiffResult> {
    this.assertRef(fromRef);
    this.assertRef(toRef);
    const repo = await this.requireRepo(repoId);
    return this.translateErrors(() =>
      this.cli.runDoltReadDiff({ doltPath: repo.doltPath, fromRef, toRef }),
    );
  }

  private assertRef(ref: string): void {
    const normalized = ref.trim();
    const validBranch =
      VALID_BRANCH.test(ref) &&
      ref === ref.toLowerCase() &&
      !ref.includes('..') &&
      !ref.startsWith('/') &&
      !ref.endsWith('/');
    const validCommit = VALID_COMMIT_HASH.test(ref) && ref === ref.toLowerCase();
    if (normalized.length === 0 || normalized !== ref || (!validBranch && !validCommit)) {
      throw new InvalidCommitReferenceError(
        `Invalid commit reference "${ref}": expected a safe branch name or a 32-character lowercase Dolt commit hash`,
      );
    }
  }

  private assertRepoId(repoId: string): void {
    if (!VALID_REPO_ID.test(repoId)) {
      throw new RepoNotFoundError(`Repo not found: ${repoId}`);
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
      if (
        lower.includes('not found') ||
        lower.includes('unknown branch') ||
        lower.includes('branch not found')
      ) {
        throw new BranchNotFoundError(message);
      }
      if (lower.includes('unsafe ref') || lower.includes('commit') || lower.includes('hash')) {
        throw new InvalidCommitReferenceError(message);
      }
      throw err;
    }
  }
}
