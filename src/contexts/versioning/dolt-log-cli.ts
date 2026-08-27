import { $ } from 'bun';
import type { LogCommitEntry } from './types';

const VALID_BRANCH = /^[A-Za-z0-9_][A-Za-z0-9_.\-/]{0,127}$/;
const VALID_COMMIT_HASH = /^[0-9a-z]{32}$/;

interface DoltPathParams {
  doltPath: string;
}

interface DoltLogParams extends DoltPathParams {
  branchName?: string;
  limit: number;
}

function trimStdErr(result: { stderr: Blob | Buffer | string }): string {
  return result.stderr.toString().trim();
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

function assertSafeCommitHash(commitHash: string): void {
  if (!VALID_COMMIT_HASH.test(commitHash)) {
    throw new Error(`Unsafe commit hash: ${commitHash}`);
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
  const headers = parseCsvLine(headerLine);
  return dataLines.map((line) => {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? '';
    });
    return row;
  });
}

function splitParents(parents: string): string[] {
  return parents
    .split(',')
    .map((parent) => parent.trim())
    .filter((parent) => parent.length > 0);
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function runDoltReadLog({
  doltPath,
  branchName,
  limit,
}: DoltLogParams): Promise<LogCommitEntry[]> {
  if (branchName) {
    assertSafeBranchName(branchName);
  }
  const query = branchName
    ? `SELECT commit_hash, author, author_email, date, message, parents FROM dolt_log AS OF ${quoteSqlString(branchName)} ORDER BY date DESC LIMIT ${limit}`
    : `SELECT commit_hash, author, author_email, date, message, parents FROM dolt_log ORDER BY date DESC LIMIT ${limit}`;
  const result = await $`dolt --data-dir ${doltPath} sql -q ${query} -r csv`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`dolt log query failed: ${trimStdErr(result)}`);
  }
  return parseCsv(result.stdout.toString()).map((row) => {
    const commitHash = row.commit_hash ?? '';
    assertSafeCommitHash(commitHash);
    return {
      commitHash,
      author: row.author ?? '',
      authorEmail: row.author_email ?? '',
      timestamp: row.date ?? '',
      message: row.message ?? '',
      parents: splitParents(row.parents ?? ''),
    } satisfies LogCommitEntry;
  });
}
