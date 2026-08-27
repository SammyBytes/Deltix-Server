import {
  BranchNotFoundError,
  InvalidBranchNameError,
  MergeConflictError,
  RepoNotFoundError,
} from './errors';
import { type RepoBranchMutex, sharedRepoBranchMutex } from './repo-branch-mutex';
import type { RepoStore } from './repo-store';
import type { MergeConflictTable, MergeResult } from './types';

const VALID_REPO_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const VALID_BRANCH = /^[A-Za-z0-9_][A-Za-z0-9_.\-/]{0,127}$/;

interface MergeCli {
  runDoltMerge(params: {
    doltPath: string;
    sourceBranch: string;
    targetBranch?: string;
  }): Promise<{ exitCode: number; stdout: string; stderr: string; currentBranch: string }>;
  runDoltMergeAbort(params: { doltPath: string }): Promise<void>;
  runDoltReadConflicts(params: { doltPath: string }): Promise<MergeConflictTable[]>;
  runDoltLatestCommitHash(params: { doltPath: string }): Promise<string>;
  runDoltCurrentBranch(params: { doltPath: string }): Promise<string>;
}

export class MergeService {
  constructor(
    private readonly store: RepoStore,
    private readonly cli: MergeCli,
    private readonly mutex: RepoBranchMutex = sharedRepoBranchMutex,
  ) {}

  async merge(repoId: string, sourceBranch: string, targetBranch?: string): Promise<MergeResult> {
    this.assertBranchName(sourceBranch);
    if (targetBranch) {
      this.assertBranchName(targetBranch);
    }
    const repo = await this.requireRepo(repoId);
    return this.mutex.runExclusive(repoId, async () => {
      const intendedTarget = targetBranch
        ? targetBranch
        : await this.translateErrors(() =>
            this.cli.runDoltCurrentBranch({ doltPath: repo.doltPath }),
          );
      const mergeParams = targetBranch
        ? { doltPath: repo.doltPath, sourceBranch, targetBranch }
        : { doltPath: repo.doltPath, sourceBranch };
      const result = await this.translateErrors(() => this.cli.runDoltMerge(mergeParams));
      const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
      if (result.exitCode === 0) {
        if (combined.includes('up to date')) {
          return {
            status: 'up_to_date',
            targetBranch: intendedTarget,
            sourceBranch,
            message: result.stdout || 'Already up to date.',
          } satisfies MergeResult;
        }
        const commitHash = await this.cli.runDoltLatestCommitHash({ doltPath: repo.doltPath });
        return {
          status: 'merged',
          targetBranch: intendedTarget,
          sourceBranch,
          commitHash,
          fastForward: combined.includes('fast-forward'),
          message: result.stdout || 'Merge completed successfully.',
        } satisfies MergeResult;
      }
      if (combined.includes('conflict')) {
        const conflicts = await this.cli.runDoltReadConflicts({ doltPath: repo.doltPath });
        await this.cli.runDoltMergeAbort({ doltPath: repo.doltPath });
        throw new MergeConflictError(
          `Merge conflict while merging "${sourceBranch}" into "${intendedTarget}"`,
          conflicts,
          { sourceBranch, targetBranch: intendedTarget },
        );
      }
      throw new Error(result.stderr || result.stdout || 'dolt merge failed');
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
      if (lower.includes('not found') || lower.includes('unknown branch')) {
        throw new BranchNotFoundError(message);
      }
      throw err;
    }
  }
}
