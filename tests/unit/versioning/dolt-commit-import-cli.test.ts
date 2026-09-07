import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import {
  isMissingBranchCheckoutError,
  runDoltCommitImport,
} from '../../../src/contexts/versioning/dolt-commit-import-cli';

const hasDolt = await (async () => {
  try {
    const probe = await $`which dolt`.quiet().nothrow();
    return probe.exitCode === 0;
  } catch {
    return false;
  }
})();

describe('versioning/isMissingBranchCheckoutError', () => {
  it('detects the stderr dolt emits for a branch that does not exist yet', () => {
    expect(
      isMissingBranchCheckoutError(
        "error: tablespec 'nope' did not match any table(s) known to dolt",
      ),
    ).toBe(true);
  });

  it('treats unrelated checkout failures (and empty output) as fatal', () => {
    expect(isMissingBranchCheckoutError('fatal: A branch named main already exists')).toBe(false);
    expect(isMissingBranchCheckoutError('cannot checkout branch, working set has conflicts')).toBe(
      false,
    );
    expect(isMissingBranchCheckoutError('')).toBe(false);
  });
});

// Integration-ish coverage of the git `push -u` semantics: a client pushing to
// a branch that has never existed server-side triggers auto-creation. Runs
// only when a real dolt binary is available on PATH.
describe.skipIf(!hasDolt)('versioning/runDoltCommitImport (first push to a new branch)', () => {
  it('creates the branch from the current head and commits the pushed work onto it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deltix-import-branch-test-'));
    try {
      const init = await $`dolt --data-dir ${dir} init`.quiet().nothrow();
      expect(init.exitCode).toBe(0);

      const hash = await runDoltCommitImport({
        doltPath: dir,
        authorName: 'alice',
        message: 'feat: add orders',
        branch: 'sync-develop',
        tables: [
          {
            name: 'orders',
            schema: 'CREATE TABLE orders (id INT PRIMARY KEY)',
            data: 'id\n1',
          },
        ],
      });
      expect(hash.length).toBeGreaterThan(0);

      const branches = await $`dolt --data-dir ${dir} branch -a`.quiet().nothrow();
      expect(branches.stdout.toString()).toContain('sync-develop');

      const active = await $`dolt --data-dir ${dir} sql -q 'SELECT active_branch()' -r csv`
        .quiet()
        .nothrow();
      expect(active.stdout.toString()).toContain('sync-develop');

      const log = await $`dolt --data-dir ${dir} log sync-develop --oneline`.quiet().nothrow();
      expect(log.stdout.toString()).toContain('feat: add orders');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still imports onto an existing branch without recreating it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deltix-import-branch-test-'));
    try {
      await $`dolt --data-dir ${dir} init`.quiet().nothrow();

      await runDoltCommitImport({
        doltPath: dir,
        authorName: 'alice',
        message: 'first',
        branch: 'main',
        tables: [{ name: 't', schema: 'CREATE TABLE t (id INT PRIMARY KEY)', data: 'id\n1' }],
      });

      const hash = await runDoltCommitImport({
        doltPath: dir,
        authorName: 'alice',
        message: 'second',
        branch: 'main',
        tables: [{ name: 't', schema: 'CREATE TABLE t (id INT PRIMARY KEY)', data: 'id\n1\n2' }],
      });
      expect(hash.length).toBeGreaterThan(0);

      const log = await $`dolt --data-dir ${dir} log main --oneline`.quiet().nothrow();
      expect(log.stdout.toString()).toContain('second');
      expect(log.stdout.toString()).toContain('first');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
