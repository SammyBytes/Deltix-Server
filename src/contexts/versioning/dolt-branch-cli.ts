import { $ } from 'bun';
import type { BranchSummary } from './types';

interface DoltPathParams {
  doltPath: string;
}

interface DoltBranchParams extends DoltPathParams {
  branchName: string;
}

function trimStdErr(result: { stderr: Blob | Buffer | string }): string {
  return result.stderr.toString().trim();
}

async function readCurrentBranchName(doltPath: string): Promise<string> {
  const result = await $`dolt --data-dir ${doltPath} branch`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`dolt current branch lookup failed: ${trimStdErr(result)}`);
  }
  const current = result.stdout
    .toString()
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('* '));
  if (!current) {
    throw new Error('Could not determine current branch from dolt branch output');
  }
  return current.slice(2).trim();
}

export async function runDoltListBranches({ doltPath }: DoltPathParams): Promise<BranchSummary[]> {
  const listResult =
    await $`dolt --data-dir ${doltPath} sql -q ${'SELECT name FROM dolt_branches ORDER BY name'} -r csv`
      .quiet()
      .nothrow();
  if (listResult.exitCode !== 0) {
    throw new Error(`dolt branch list failed: ${trimStdErr(listResult)}`);
  }

  const currentBranch = await readCurrentBranchName(doltPath);
  const lines = listResult.stdout
    .toString()
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);
  return lines.slice(1).map((line) => {
    const name = line.trim();
    return { name, isCurrent: name === currentBranch } satisfies BranchSummary;
  });
}

export async function runDoltCurrentBranch({ doltPath }: DoltPathParams): Promise<string> {
  return readCurrentBranchName(doltPath);
}

export async function runDoltCreateBranch({
  doltPath,
  branchName,
}: DoltBranchParams): Promise<void> {
  const result = await $`dolt --data-dir ${doltPath} branch ${branchName}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`dolt branch create failed: ${trimStdErr(result)}`);
  }
}

export async function runDoltCheckoutBranch({
  doltPath,
  branchName,
}: DoltBranchParams): Promise<void> {
  const result = await $`dolt --data-dir ${doltPath} checkout ${branchName}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`dolt checkout failed: ${trimStdErr(result)}`);
  }
}

export async function runDoltDeleteBranch({
  doltPath,
  branchName,
}: DoltBranchParams): Promise<void> {
  const result = await $`dolt --data-dir ${doltPath} branch -d ${branchName}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`dolt branch delete failed: ${trimStdErr(result)}`);
  }
}
