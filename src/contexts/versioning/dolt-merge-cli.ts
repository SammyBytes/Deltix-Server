import { $ } from 'bun';
import type { MergeConflictRow, MergeConflictTable } from './types';

const VALID_BRANCH = /^[A-Za-z0-9_][A-Za-z0-9_.\-/]{0,127}$/;
const VALID_TABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface DoltPathParams {
  doltPath: string;
}

interface DoltMergeParams extends DoltPathParams {
  sourceBranch: string;
  targetBranch?: string;
}

function trimStdErr(result: { stderr: Blob | Buffer | string }): string {
  return result.stderr.toString().trim();
}

function trimStdOut(result: { stdout: Blob | Buffer | string }): string {
  return result.stdout.toString().trim();
}

function assertSafeBranchName(branchName: string): void {
  if (
    branchName.trim() !== branchName ||
    !VALID_BRANCH.test(branchName) ||
    branchName.includes('..') ||
    branchName.startsWith('/') ||
    branchName.endsWith('/')
  ) {
    throw new Error(`Unsafe branch name: ${branchName}`);
  }
}

function assertSafeTableName(tableName: string): void {
  if (!VALID_TABLE.test(tableName)) {
    throw new Error(`Unsafe table name: ${tableName}`);
  }
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  values.push(current);
  return values;
}

function parseCsv(stdout: string): Array<Record<string, string>> {
  const lines = stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length <= 1) {
    return [];
  }
  const [headerLine, ...dataLines] = lines;
  if (!headerLine) {
    return [];
  }
  const header = parseCsvLine(headerLine);
  return dataLines.map((line) => {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    header.forEach((key, index) => {
      row[key] = values[index] ?? '';
    });
    return row;
  });
}

function toNullable(value: string | undefined): string | null {
  if (value === undefined || value === '' || value.toUpperCase() === 'NULL') {
    return null;
  }
  return value;
}

function buildConflictRow(detailRow: Record<string, string>): MergeConflictRow {
  const base: Record<string, string | null> = {};
  const ours: Record<string, string | null> = {};
  const theirs: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(detailRow)) {
    if (key.startsWith('base_')) {
      base[key.slice('base_'.length)] = toNullable(value);
      continue;
    }
    if (key.startsWith('our_') && key !== 'our_diff_type') {
      ours[key.slice('our_'.length)] = toNullable(value);
      continue;
    }
    if (key.startsWith('their_') && key !== 'their_diff_type') {
      theirs[key.slice('their_'.length)] = toNullable(value);
    }
  }
  return {
    fromRootIsh: toNullable(detailRow.from_root_ish),
    base,
    ours,
    theirs,
    ourDiffType: toNullable(detailRow.our_diff_type),
    theirDiffType: toNullable(detailRow.their_diff_type),
    conflictId: toNullable(detailRow.dolt_conflict_id),
  };
}

async function readConflictTable(
  doltPath: string,
  tableName: string,
  expectedCount: string | undefined,
): Promise<MergeConflictTable> {
  assertSafeTableName(tableName);
  const detailQuery = `SELECT * FROM dolt_conflicts_${tableName}`;
  const detail = await $`dolt --data-dir ${doltPath} sql -q ${detailQuery} -r csv`
    .quiet()
    .nothrow();
  if (detail.exitCode !== 0) {
    throw new Error(`dolt conflict detail query failed for ${tableName}: ${trimStdErr(detail)}`);
  }
  const conflicts = parseCsv(detail.stdout.toString()).map(buildConflictRow);
  return {
    table: tableName,
    count: Number(expectedCount ?? conflicts.length),
    conflicts,
  };
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

async function readLatestCommitHash(doltPath: string): Promise<string> {
  const hash =
    await $`dolt --data-dir ${doltPath} sql -q ${'SELECT commit_hash FROM dolt_log ORDER BY date DESC LIMIT 1'} -r csv`
      .quiet()
      .nothrow();
  if (hash.exitCode !== 0) {
    throw new Error(`dolt log lookup failed: ${trimStdErr(hash)}`);
  }
  const lines = hash.stdout.toString().trim().split('\n');
  const commitHash = lines[lines.length - 1]?.trim();
  if (!commitHash || commitHash === 'commit_hash') {
    throw new Error('Could not determine latest commit hash from dolt_log');
  }
  return commitHash;
}

export async function runDoltCurrentBranch({ doltPath }: DoltPathParams): Promise<string> {
  return readCurrentBranchName(doltPath);
}

export async function runDoltCheckoutBranch({
  doltPath,
  branchName,
}: {
  doltPath: string;
  branchName: string;
}): Promise<void> {
  assertSafeBranchName(branchName);
  const result = await $`dolt --data-dir ${doltPath} checkout ${branchName}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`dolt checkout failed: ${trimStdErr(result)}`);
  }
}

export async function runDoltMerge({
  doltPath,
  sourceBranch,
  targetBranch,
}: DoltMergeParams): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  currentBranch: string;
}> {
  assertSafeBranchName(sourceBranch);
  if (targetBranch) {
    assertSafeBranchName(targetBranch);
    const currentBranch = await readCurrentBranchName(doltPath);
    if (currentBranch !== targetBranch) {
      await runDoltCheckoutBranch({ doltPath, branchName: targetBranch });
    }
  }
  const currentBranch = await readCurrentBranchName(doltPath);
  const result = await $`dolt --data-dir ${doltPath} merge ${sourceBranch}`.quiet().nothrow();
  return {
    exitCode: result.exitCode,
    stdout: trimStdOut(result),
    stderr: trimStdErr(result),
    currentBranch,
  };
}

export async function runDoltMergeAbort({ doltPath }: DoltPathParams): Promise<void> {
  const result = await $`dolt --data-dir ${doltPath} merge --abort`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`dolt merge --abort failed: ${trimStdErr(result)}`);
  }
}

export async function runDoltReadConflicts({
  doltPath,
}: DoltPathParams): Promise<MergeConflictTable[]> {
  const summary =
    await $`dolt --data-dir ${doltPath} sql -q ${'SELECT `table`, num_conflicts FROM dolt_conflicts ORDER BY `table`'} -r csv`
      .quiet()
      .nothrow();
  if (summary.exitCode !== 0) {
    throw new Error(`dolt conflicts query failed: ${trimStdErr(summary)}`);
  }
  const rows = parseCsv(summary.stdout.toString());
  const tables: MergeConflictTable[] = [];
  for (const row of rows) {
    const tableName = row.table;
    if (!tableName) {
      throw new Error('Unexpected dolt_conflicts row without table name');
    }
    tables.push(await readConflictTable(doltPath, tableName, row.num_conflicts));
  }
  return tables;
}

export async function runDoltLatestCommitHash({ doltPath }: DoltPathParams): Promise<string> {
  return readLatestCommitHash(doltPath);
}
