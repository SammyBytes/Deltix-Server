import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import {
  runDoltCheckoutBranch,
  runDoltCreateBranch,
  runDoltCurrentBranch,
  runDoltDeleteBranch,
  runDoltListBranches,
} from '../../../src/contexts/versioning/dolt-branch-cli';

describe('versioning/dolt-branch-cli (integration, real dolt binary)', () => {
  let workDir: string;
  let doltPath: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deltix-branch-cli-integration-'));
    doltPath = join(workDir, 'repo');
    await mkdir(doltPath, { recursive: true });
    await $`dolt --data-dir ${doltPath} init`.quiet();
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('lists the current main branch from dolt_branches', async () => {
    const branches = await runDoltListBranches({ doltPath });
    expect(branches.some((branch) => branch.name === 'main')).toBe(true);
    expect(branches.find((branch) => branch.name === 'main')?.isCurrent).toBe(true);
  });

  it('creates a branch and can resolve the current branch', async () => {
    await runDoltCreateBranch({ doltPath, branchName: 'feature/demo' });
    const branches = await runDoltListBranches({ doltPath });

    expect(branches.map((branch) => branch.name)).toContain('feature/demo');
    expect(await runDoltCurrentBranch({ doltPath })).toBe('main');
  });

  it('checks out a created branch and reflects it as current', async () => {
    await runDoltCheckoutBranch({ doltPath, branchName: 'feature/demo' });

    expect(await runDoltCurrentBranch({ doltPath })).toBe('feature/demo');
    const branches = await runDoltListBranches({ doltPath });
    expect(branches.find((branch) => branch.name === 'feature/demo')?.isCurrent).toBe(true);
  });

  it('deletes a non-current branch', async () => {
    await runDoltCreateBranch({ doltPath, branchName: 'feature/delete-me' });
    await runDoltCheckoutBranch({ doltPath, branchName: 'main' });

    await runDoltDeleteBranch({ doltPath, branchName: 'feature/delete-me' });

    const branches = await runDoltListBranches({ doltPath });
    expect(branches.map((branch) => branch.name)).not.toContain('feature/delete-me');
  });
});
