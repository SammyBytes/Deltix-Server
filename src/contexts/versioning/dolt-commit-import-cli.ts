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

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import type { RunDoltCommitImport } from './commit-import.service';
import { isDoltFulltextInternalTable } from './fulltext-tables';

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

  // Recreate the schema, then reload every row. Extracted for cognitive
  // complexity reasons (lint caps the main function at 15).
  const importTables = tables.filter((t) => !isDoltFulltextInternalTable(t.name));
  for (const table of importTables) {
    await importTable(doltPath, table);
  }

  // Stage all imported tables (skipping the hidden FULLTEXT backing tables we
  // did not import — they regenerate automatically with their owning table).
  const tableNames = importTables.map((t) => t.name);
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
 * Imports a single table: recreates the schema (create, or TRUNCATE if it
 * already exists — a re-push carries an unchanged schema), then reloads every
 * row from the CSV. Skips Dolt's hidden FULLTEXT backing tables outright:
 * they are derived state regenerated from the owning table's FULLTEXT KEY,
 * hold no user data, and their auto-generated names can exceed MySQL's 64-char
 * identifier limit — an explicit CREATE TABLE for them fails with
 * `invalid identifier`.
 */
async function importTable(
  doltPath: string,
  table: { name: string; schema: string; data: string },
): Promise<void> {
  assertSafeTableName(table.name);

  // Recreate the schema. `dolt schema export` emits a plain CREATE TABLE, so
  // on a re-push the table already exists — fall back to TRUNCATE in that
  // case (the schema is unchanged); any other DDL failure is fatal.
  const create = await $`dolt --data-dir ${doltPath} sql -q ${table.schema}`.quiet().nothrow();
  if (create.exitCode !== 0) {
    if (!create.stderr.toString().toLowerCase().includes('already exists')) {
      throw new Error(`dolt sql (create ${table.name}) failed: ${create.stderr.toString().trim()}`);
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
    return; // header only (or empty) → table exists, no rows to insert
  }
  // Use `dolt table import -r` instead of per-row INSERT statements. It
  // parses the CSV the same way Dolt wrote it (so type coercion is exact:
  // an empty string lands as NULL into a DATETIME column, which an INSERT
  // statement rejects with "Incorrect datetime value: ''"). It's also
  // dramatically faster for tables with thousands of rows — a single
  // batched load instead of O(rows) subprocess invocations. The CSV
  // header is already produced by the client in the right column order,
  // so we just write the bytes back to a temp file and point dolt at it.
  const importDir = await mkdtemp(join(tmpdir(), 'deltix-server-import-'));
  const importFile = join(importDir, `${table.name}.csv`);
  try {
    await writeFile(importFile, table.data);
    const imp = await $`dolt --data-dir ${doltPath} table import -r ${table.name} ${importFile}`
      .quiet()
      .nothrow();
    if (imp.exitCode !== 0) {
      throw new Error(
        `dolt table import (${table.name}) failed: ${imp.stderr.toString().trim() || imp.stdout.toString().trim()}`,
      );
    }
  } finally {
    await rm(importDir, { recursive: true, force: true }).catch(() => {});
  }
}
