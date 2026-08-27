import { $ } from 'bun';
import type { ForeignKeyEdge } from './sync-preference-types';

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertSafeTableName(tableName: string): void {
  if (!IDENTIFIER_RE.test(tableName)) {
    throw new Error(`Unsafe table name: ${tableName}`);
  }
}

export async function readForeignKeyEdges(doltPath: string): Promise<ForeignKeyEdge[]> {
  const query =
    'SELECT TABLE_NAME, REFERENCED_TABLE_NAME, CONSTRAINT_NAME ' +
    'FROM information_schema.KEY_COLUMN_USAGE ' +
    'WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL ' +
    'GROUP BY TABLE_NAME, REFERENCED_TABLE_NAME, CONSTRAINT_NAME ' +
    'ORDER BY TABLE_NAME, REFERENCED_TABLE_NAME, CONSTRAINT_NAME';
  const result = await $`dolt --data-dir ${doltPath} sql -q ${query} -r csv`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`dolt sql (foreign keys) failed: ${result.stderr.toString().trim()}`);
  }
  const lines = result.stdout.toString().trim().split('\n').filter(Boolean);
  if (lines.length <= 1) {
    return [];
  }
  return lines.slice(1).map((line) => {
    const [tableName, referencedTableName, constraintName] = line
      .split(',')
      .map((part) => part.trim());
    if (!tableName || !referencedTableName || !constraintName) {
      throw new Error('Unexpected foreign key catalog row returned by dolt sql');
    }
    assertSafeTableName(tableName);
    assertSafeTableName(referencedTableName);
    return { tableName, referencedTableName, constraintName };
  });
}
