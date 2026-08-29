/**
 * Dolt CLI implementation for importing commits from client pushes (Fase 4b).
 * For each commit: imports table data via SQL INSERT, runs dolt add + commit.
 *
 * Table data is expected as CSV. Each table gets truncated before import
 * to ensure the server state matches the client state exactly.
 *
 * All values are passed via argv arrays (OWASP A03 — no shell interpolation).
 */
import { $ } from 'bun';
import type { RunDoltCommitImport } from './commit-import.service';

// Defense-in-depth (OWASP A03): authorName is sanitized to prevent
// CLI argument injection when interpolated into --author flag.
function sanitizeAuthorName(username: string): string {
  return username.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

// Table names must be safe SQL identifiers (already validated by the
// sync-prefs layer, but we double-check here as defense-in-depth).
const SAFE_TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertSafeTableName(name: string): void {
  if (!SAFE_TABLE_RE.test(name)) {
    throw new Error(`Refusing to import: table name "${name}" has an unexpected shape`);
  }
}

export const runDoltCommitImport: RunDoltCommitImport = async ({
  doltPath,
  authorName,
  message,
  tables,
}) => {
  const safeAuthor = sanitizeAuthorName(authorName);
  const authorFlag = `${safeAuthor} <${safeAuthor}@deltix.local>`;

  // Import each table's data via dolt sql
  for (const table of tables) {
    assertSafeTableName(table.name);

    // Truncate the table first to match client state
    const truncate = await $`dolt --data-dir ${doltPath} sql -q ${`TRUNCATE TABLE ${table.name}`}`
      .quiet()
      .nothrow();
    if (truncate.exitCode !== 0) {
      throw new Error(
        `dolt sql (truncate ${table.name}) failed: ${truncate.stderr.toString().trim()}`,
      );
    }

    // Import CSV data via LOAD DATA or individual INSERTs
    // Using dolt table import for CSV data
    const importResult =
      await $`dolt --data-dir ${doltPath} table import -c -f ${table.name} ${`/dev/stdin`}`
        .quiet()
        .nothrow()
        .stdin(table.data);

    // Fallback: if table import doesn't work with stdin, use SQL INSERTs
    if (importResult.exitCode !== 0) {
      // Parse CSV and create INSERT statements
      const lines = table.data.trim().split('\n');
      if (lines.length > 1) {
        // Skip header row, insert data rows
        const columns = parseCsvLine(lines[0] ?? '');
        for (let i = 1; i < lines.length; i++) {
          const values = parseCsvLine(lines[i] ?? '');
          if (values.length !== columns.length) {
            continue;
          }
          const escapedValues = values.map((v) => `'${v.replace(/'/g, "''")}'`);
          const insertSql = `INSERT INTO ${table.name} (${columns.join(', ')}) VALUES (${escapedValues.join(', ')})`;
          const insertResult = await $`dolt --data-dir ${doltPath} sql -q ${insertSql}`
            .quiet()
            .nothrow();
          if (insertResult.exitCode !== 0) {
            throw new Error(
              `dolt sql (insert into ${table.name}) failed: ${insertResult.stderr.toString().trim()}`,
            );
          }
        }
      }
    }
  }

  // Stage all imported tables
  const tableNames = tables.map((t) => t.name);
  const add = await $`dolt --data-dir ${doltPath} add ${tableNames}`.quiet().nothrow();
  if (add.exitCode !== 0) {
    throw new Error(`dolt add failed: ${add.stderr.toString().trim()}`);
  }

  // Commit with original message and author
  const commit = await $`dolt --data-dir ${doltPath} commit --author=${authorFlag} -m ${message}`
    .quiet()
    .nothrow();
  if (commit.exitCode !== 0) {
    throw new Error(`dolt commit failed: ${commit.stderr.toString().trim()}`);
  }

  // Read the new commit hash
  const hash =
    await $`dolt --data-dir ${doltPath} sql -q ${'SELECT commit_hash FROM dolt_log ORDER BY date DESC LIMIT 1'} -r csv`
      .quiet()
      .nothrow();
  if (hash.exitCode !== 0) {
    throw new Error(`dolt log lookup failed: ${hash.stderr.toString().trim()}`);
  }
  const lines = hash.stdout.toString().trim().split('\n');
  const commitHash = lines[lines.length - 1]?.trim();
  if (!commitHash) {
    throw new Error('Could not determine new commit hash after dolt commit');
  }

  return commitHash;
};

/**
 * Parse a single CSV line, handling quoted fields.
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i] ?? '';
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
  }
  result.push(current);
  return result;
}
