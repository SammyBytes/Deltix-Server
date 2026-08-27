import {
  BranchAlreadyExistsError,
  BranchNotFoundError,
  InvalidBranchNameError,
  ProtectedBranchError,
  RepoNotFoundError,
} from './errors';
import type { RepoStore } from './repo-store';
import type { BranchSummary } from './types';

const VALID_REPO_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const VALID_BRANCH = /^[A-Za-z0-9_][A-Za-z0-9_.\-/]{0,127}$/;
const DEFAULT_PROTECTED_BRANCHES = new Set(['main']);

interface BranchCli {
  runDoltListBranches(params: { doltPath: string }): Promise<BranchSummary[]>;
  runDoltCurrentBranch(params: { doltPath: string }): Promise<string>;
  runDoltCreateBranch(params: { doltPath: string; branchName: string }): Promise<void>;
  runDoltCheckoutBranch(params: { doltPath: string; branchName: string }): Promise<void>;
  runDoltDeleteBranch(params: { doltPath: string; branchName: string }): Promise<void>;
}

class RepoBranchMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(repoId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(repoId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(
      repoId,
      previous.then(() => current),
    );
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.tails.get(repoId) === current) {
        this.tails.delete(repoId);
      }
    }
  }
}

const sharedMutex = new RepoBranchMutex();

export class BranchService {
  constructor(
    private readonly store: RepoStore,
    private readonly cli: BranchCli,
    private readonly mutex: RepoBranchMutex = sharedMutex,
  ) {}

  async list(repoId: string): Promise<BranchSummary[]> {
    const repo = await this.requireRepo(repoId);
    return this.translateErrors(() => this.cli.runDoltListBranches({ doltPath: repo.doltPath }));
  }

  async current(repoId: string): Promise<string> {
    const repo = await this.requireRepo(repoId);
    return this.translateErrors(() => this.cli.runDoltCurrentBranch({ doltPath: repo.doltPath }));
  }

  async create(
    repoId: string,
    branchName: string,
  ): Promise<{ currentBranch: string; createdBranch: string }> {
    this.assertBranchName(branchName);
    const repo = await this.requireRepo(repoId);
    return this.mutex.runExclusive(repoId, async () => {
      await this.translateErrors(() =>
        this.cli.runDoltCreateBranch({ doltPath: repo.doltPath, branchName }),
      );
      const currentBranch = await this.translateErrors(() =>
        this.cli.runDoltCurrentBranch({ doltPath: repo.doltPath }),
      );
      return { currentBranch, createdBranch: branchName };
    });
  }

  async checkout(repoId: string, branchName: string): Promise<{ currentBranch: string }> {
    this.assertBranchName(branchName);
    const repo = await this.requireRepo(repoId);
    return this.mutex.runExclusive(repoId, async () => {
      await this.translateErrors(() =>
        this.cli.runDoltCheckoutBranch({ doltPath: repo.doltPath, branchName }),
      );
      return { currentBranch: branchName };
    });
  }

  async delete(repoId: string, branchName: string): Promise<void> {
    this.assertBranchName(branchName);
    const repo = await this.requireRepo(repoId);
    await this.mutex.runExclusive(repoId, async () => {
      const currentBranch = await this.translateErrors(() =>
        this.cli.runDoltCurrentBranch({ doltPath: repo.doltPath }),
      );
      if (currentBranch === branchName) {
        throw new ProtectedBranchError(
          `Cannot delete the currently checked-out branch "${branchName}"`,
        );
      }
      if (DEFAULT_PROTECTED_BRANCHES.has(branchName)) {
        throw new ProtectedBranchError(`Cannot delete protected branch "${branchName}"`);
      }
      await this.translateErrors(() =>
        this.cli.runDoltDeleteBranch({ doltPath: repo.doltPath, branchName }),
      );
    });
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
      if (lower.includes('already exists')) {
        throw new BranchAlreadyExistsError(message);
      }
      if (lower.includes('not found') || lower.includes('unknown branch')) {
        throw new BranchNotFoundError(message);
      }
      throw err;
    }
  }
}
