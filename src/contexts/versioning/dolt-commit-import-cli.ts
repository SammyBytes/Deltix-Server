/**
 * Dolt CLI implementation for importing commits from client pushes (Fase 4b).
 * For each commit, per table: recreate the schema from the client's DDL
 * (create, or truncate if it already exists), then reload every row from the
 * CSV. Schema comes as DDL — not inferred from CSV — so primary keys and
 * column types survive the round trip exactly. Then `dolt add` + `dolt commit`
 * with the original message and author.
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

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export const runDoltCommitImport: RunDoltCommitImport = async ({
  doltPath,
  authorName,
  message,
  tables,
}) => {
  const safeAuthor = sanitizeAuthorName(authorName);
  const authorFlag = `${safeAuthor} <${safeAuthor}@deltix.local>`;

  for (const table of tables) {
    assertSafeTableName(table.name);

    // Recreate the schema. `dolt schema export` emits a plain CREATE TABLE, so
    // on a re-push the table already exists — fall back to TRUNCATE in that
    // case (the schema is unchanged); any other DDL failure is fatal.
    const create = await $`dolt --data-dir ${doltPath} sql -q ${table.schema}`.quiet().nothrow();
    if (create.exitCode !== 0) {
      if (!create.stderr.toString().toLowerCase().includes('already exists')) {
        throw new Error(
          `dolt sql (create ${table.name}) failed: ${create.stderr.toString().trim()}`,
        );
      }
      const truncate = await $`dolt --data-dir ${doltPath} sql -q ${`TRUNCATE TABLE ${table.name}`}`
        .quiet()
        .nothrow();
      if (truncate.exitCode !== 0) {
        throw new Error(
          `dolt sql (truncate ${table.name}) failed: ${truncate.stderr.toString().trim()}`,
        );
      }
    }

    // Reload rows from the CSV (first line is the header).
    const lines = table.data
      .replace(/\r/g, '')
      .split('\n')
      .filter((line) => line.length > 0);
    if (lines.length <= 1) {
      continue; // header only (or empty) → table exists, no rows to insert
    }
    const columns = parseCsvLine(lines[0] ?? '');
    for (let i = 1; i < lines.length; i++) {
      const values = parseCsvLine(lines[i] ?? '');
      if (values.length !== columns.length) {
        throw new Error(
          `dolt import ${table.name}: row ${i} has ${values.length} cols, expected ${columns.length}`,
        );
      }
      const cols = columns.map((c) => `\`${c}\``).join(', ');
      const vals = values.map(sqlLiteral).join(', ');
      const insert =
        await $`dolt --data-dir ${doltPath} sql -q ${`INSERT INTO ${table.name} (${cols}) VALUES (${vals})`}`
          .quiet()
          .nothrow();
      if (insert.exitCode !== 0) {
        throw new Error(
          `dolt sql (insert into ${table.name}) failed: ${insert.stderr.toString().trim()}`,
        );
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
