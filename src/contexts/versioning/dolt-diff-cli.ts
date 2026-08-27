import { $ } from 'bun';
import type { DiffResult, DiffRowChange, DiffTableSummary } from './types';

const VALID_BRANCH = /^[A-Za-z0-9_][A-Za-z0-9_.\-/]{0,127}$/;
const VALID_COMMIT_HASH = /^[0-9a-z]{32}$/;
const VALID_TABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface DoltPathParams {
  doltPath: string;
}

interface DoltDiffParams extends DoltPathParams {
  fromRef: string;
  toRef: string;
}

function trimStdErr(result: { stderr: Blob | Buffer | string }): string {
  return result.stderr.toString().trim();
}

function assertSafeRef(ref: string): void {
  const trimmed = ref.trim();
  if (trimmed !== ref || trimmed.length === 0) {
    throw new Error(`Unsafe ref: ${ref}`);
  }
  const isBranch =
    VALID_BRANCH.test(ref) && !ref.includes('..') && !ref.startsWith('/') && !ref.endsWith('/');
  const isCommit = VALID_COMMIT_HASH.test(ref);
  if (!isBranch && !isCommit) {
    throw new Error(`Unsafe ref: ${ref}`);
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

function toNullable(value: string | undefined): string | null {
  if (value === undefined || value === '' || value.toUpperCase() === 'NULL') {
    return null;
  }
  return value;
}

function mapDiffType(value: string): DiffRowChange['diffType'] {
  if (value === 'added' || value === 'removed' || value === 'modified') {
    return value;
  }
  throw new Error(`Unexpected diff type: ${value}`);
}

function buildRowChange(row: Record<string, string>): DiffRowChange {
  const oldValues: Record<string, string | null> = {};
  const newValues: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('from_') && !['from_commit', 'from_commit_date'].includes(key)) {
      oldValues[key.slice('from_'.length)] = toNullable(value);
      continue;
    }
    if (key.startsWith('to_') && !['to_commit', 'to_commit_date'].includes(key)) {
      newValues[key.slice('to_'.length)] = toNullable(value);
    }
  }
  return {
    diffType: mapDiffType(row.diff_type ?? ''),
    oldValues,
    newValues,
  };
}

export async function runDoltReadDiff({
  doltPath,
  fromRef,
  toRef,
}: DoltDiffParams): Promise<DiffResult> {
  assertSafeRef(fromRef);
  assertSafeRef(toRef);
  const summaryQuery = `SELECT from_table_name, to_table_name, diff_type, data_change, schema_change FROM dolt_diff_summary('${fromRef}', '${toRef}') ORDER BY COALESCE(to_table_name, from_table_name)`;
  const summaryResult = await $`dolt --data-dir ${doltPath} sql -q ${summaryQuery} -r csv`
    .quiet()
    .nothrow();
  if (summaryResult.exitCode !== 0) {
    throw new Error(`dolt diff summary query failed: ${trimStdErr(summaryResult)}`);
  }
  const summaryRows = parseCsv(summaryResult.stdout.toString());
  const tables: DiffTableSummary[] = [];
  for (const row of summaryRows) {
    const tableName = row.to_table_name || row.from_table_name;
    if (!tableName) {
      throw new Error('Unexpected dolt_diff_summary row without table name');
    }
    assertSafeTableName(tableName);
    const detailQuery = `SELECT * FROM dolt_diff('${fromRef}', '${toRef}', '${tableName}')`;
    const detailResult = await $`dolt --data-dir ${doltPath} sql -q ${detailQuery} -r csv`
      .quiet()
      .nothrow();
    if (detailResult.exitCode !== 0) {
      throw new Error(
        `dolt diff detail query failed for ${tableName}: ${trimStdErr(detailResult)}`,
      );
    }
    tables.push({
      table: tableName,
      diffType: row.diff_type ?? 'modified',
      dataChange: row.data_change === 'true',
      schemaChange: row.schema_change === 'true',
      changes: parseCsv(detailResult.stdout.toString()).map(buildRowChange),
    });
  }
  return { fromRef, toRef, tables };
}
