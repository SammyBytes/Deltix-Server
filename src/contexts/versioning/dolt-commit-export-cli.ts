/**
 * Real Dolt CLI implementation of the commit-export ports (Fase 5.9). Consumed
 * as a black-box binary, same convention as `dolt-commit-cli.ts`. All dolt
 * invocations go through `Bun.spawn` with an argv array (never a shell string),
 * so no dynamic value can be interpreted as a shell metacharacter (OWASP A03).
 *
 * The queries mirror what `Deltix-Client` uses for push, in reverse:
 * `dolt_log` (JSON) to enumerate commits, `dolt diff --name-only` for changed
 * tables, and `SELECT * FROM <t> AS OF <hash>` (CSV) for the per-commit data.
 */

import { createLogger } from '../../shared/logger';
import type {
  ExportedCommit,
  RunDoltBranchHead,
  RunDoltCommitExport,
  RunDoltListRefs,
} from './commit-export.service';

const logger = createLogger('dolt:export');

const SAFE_TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

interface DoltOut {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runDolt(args: string[]): Promise<DoltOut> {
  const proc = Bun.spawn(['dolt', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exitCode: await proc.exited };
}

async function queryJson(doltPath: string, sql: string): Promise<Record<string, string>[]> {
  const r = await runDolt(['--data-dir', doltPath, 'sql', '-q', sql, '-r', 'json']);
  if (r.exitCode !== 0) {
    throw new Error(`dolt sql failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  const trimmed = r.stdout.trim();
  if (!trimmed) {
    return [];
  }
  return (JSON.parse(trimmed) as { rows?: Record<string, string>[] }).rows ?? [];
}

/**
 * Returns the tables touched by `commitHash`, using their name **as of that
 * commit** (`to_table_name` from `dolt_diff_summary`) rather than
 * `dolt diff --name-only`, which reports a renamed table under its *old*
 * name. That old name doesn't exist `AS OF` the rename commit — only the new
 * one does — so using it broke schema/data export for any commit that
 * renamed a table (surfacing as the same "table not found" failure class as
 * dropped tables). A table this commit dropped has an empty `to_table_name`
 * and is filtered out here directly, so `runDoltCommitExport` never even
 * attempts (and warns about) an unresolvable AS OF lookup for it.
 */
interface ChangedTables {
  /** Tables to actually export schema/data for (drops filtered out, renames resolved to their new name). */
  tables: string[];
  /**
   * True if this commit touched *any* table (including a pure drop, which
   * yields an empty `tables` list). Used to distinguish a real commit that
   * happens to export zero tables (e.g. one that only drops tables) from a
   * genuinely empty/no-op commit (e.g. the dolt-init commit), so the former
   * is still reported to the client even though it carries no table data.
   */
  hadAnyDiff: boolean;
}

async function changedTables(doltPath: string, commitHash: string): Promise<ChangedTables> {
  let rows: Record<string, string>[];
  try {
    rows = await queryJson(
      doltPath,
      `SELECT to_table_name FROM dolt_diff_summary('${escapeSql(commitHash)}^', '${escapeSql(commitHash)}')`,
    );
  } catch {
    return { tables: [], hadAnyDiff: false }; // root commit (no parent) -> invalid ancestor spec -> nothing changed
  }
  const tables = rows
    .map((row) => row.to_table_name ?? '')
    .filter((table) => table.length > 0 && SAFE_TABLE_RE.test(table));
  return { tables, hadAnyDiff: rows.length > 0 };
}

async function tableData(doltPath: string, table: string, commitHash: string): Promise<string> {
  const r = await runDolt([
    '--data-dir',
    doltPath,
    'sql',
    '-q',
    `SELECT * FROM ${table} AS OF '${escapeSql(commitHash)}'`,
    '-r',
    'csv',
  ]);
  if (r.exitCode !== 0) {
    throw new Error(`dolt export of ${table} failed: ${r.stderr.trim()}`);
  }
  return r.stdout;
}

/**
 * Exports `table`'s CREATE TABLE DDL as it existed at `commitHash` — never the
 * current/HEAD schema. `dolt schema export` (used by the client's push path,
 * where the table is always the caller's own current schema) only reads the
 * live working set, so it throws "table not found" for any commit that
 * touched a table later dropped or renamed. Pull/fetch must tolerate that:
 * older commits in a repo's history routinely reference tables that no
 * longer exist by that name today, and failing here used to abort the whole
 * NDJSON stream mid-flight (surfacing to the client as a raw closed-socket
 * error, not a useful message). `SHOW CREATE TABLE ... AS OF` time-travels
 * the query itself, so it succeeds regardless of the table's current fate.
 */
async function tableSchema(doltPath: string, table: string, commitHash: string): Promise<string> {
  const rows = await queryJson(
    doltPath,
    `SHOW CREATE TABLE ${table} AS OF '${escapeSql(commitHash)}'`,
  );
  const ddl = rows[0]?.['Create Table'];
  if (!ddl) {
    throw new Error(`dolt schema export of ${table} AS OF ${commitHash} returned no DDL`);
  }
  return `${ddl};`;
}

/**
 * Exports a single table's schema+data for `hash`, skipping (with a warn
 * log) any table that turns out not to be resolvable `AS OF` this commit.
 * Extracted out of `runDoltCommitExport`'s per-commit loop to keep that
 * generator's cognitive complexity within lint limits.
 */
async function exportTable(
  doltPath: string,
  table: string,
  hash: string,
): Promise<{ name: string; schema: string; data: string } | undefined> {
  // `changedTables` already filters out dropped tables (empty
  // `to_table_name`) and resolves renames to their new name, so this should
  // always succeed. The try/catch remains as defense-in-depth: if a lookup
  // is ever unresolvable `AS OF` this commit for some other reason, skip
  // just that table rather than letting it abort the whole NDJSON stream —
  // that used to surface client-side as a raw closed-socket error on every
  // pull/fetch once a repo's history contained any dropped or renamed table.
  let schema: string;
  try {
    schema = await tableSchema(doltPath, table, hash);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { table, hash, error: message },
      'skipping table export: not resolvable AS OF this commit (likely dropped/renamed later)',
    );
    return undefined;
  }
  return { name: table, schema, data: await tableData(doltPath, table, hash) };
}

export const runDoltCommitExport: RunDoltCommitExport = async function* ({
  doltPath,
  branch,
  fromHash,
}) {
  // `from` is a client-negotiated hash it believes it already has. If that
  // hash is stale or unreachable from the branch (e.g. the branch was
  // rewritten/force-replaced on the server, or the client predates the
  // current history), Dolt's `AS OF` rejects it — which used to surface as a
  // hard failure ("target commit not found") and broke the whole pull/fetch.
  // Make pull resilient: fall back to exporting the full history (a re-sync)
  // so the client reconciles from a known-good base instead of erroring out.
  const rows = await queryCommitsSince(doltPath, branch, fromHash ?? null);

  for (const row of rows) {
    const hash = row.commit_hash;
    if (!hash) {
      continue;
    }
    const { tables, hadAnyDiff } = await changedTables(doltPath, hash);
    if (!hadAnyDiff) {
      continue; // skip the dolt-init commit and any no-op commit
    }
    const exported = [];
    for (const table of tables) {
      const result = await exportTable(doltPath, table, hash);
      if (result) {
        exported.push(result);
      }
    }
    const commit: ExportedCommit = {
      hash,
      message: row.message ?? '',
      author: row.author ?? '',
      tables: exported,
    };
    yield commit;
  }
};

/**
 * Lists commits on `branch` (oldest-first), optionally restricted to those not
 * reachable from `fromHash`. If `fromHash` is not a valid/reachable commit on
 * the branch, Dolt rejects the `AS OF` filter; we then degrade to the full
 * history so the caller re-syncs rather than failing hard.
 */
async function queryCommitsSince(
  doltPath: string,
  branch: string,
  fromHash: string | null,
): Promise<Record<string, string>[]> {
  const base = `SELECT commit_hash, message, author FROM dolt_log AS OF '${escapeSql(branch)}'`;
  if (fromHash) {
    const where = `WHERE commit_hash NOT IN (SELECT commit_hash FROM dolt_log AS OF '${escapeSql(fromHash)}')`;
    try {
      return await queryJson(doltPath, `${base} ${where} ORDER BY commit_order ASC`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { branch, fromHash, error: message },
        'pull from-hash not reachable; degrading to full-history re-sync',
      );
      // fall through to full export below
    }
  }
  return queryJson(doltPath, `${base} ORDER BY commit_order ASC`);
}

export const runDoltBranchHead: RunDoltBranchHead = async ({ doltPath, branch }) => {
  const r = await runDolt([
    '--data-dir',
    doltPath,
    'sql',
    '-q',
    `SELECT hash FROM dolt_branches WHERE name = '${escapeSql(branch)}'`,
    '-r',
    'csv',
  ]);
  if (r.exitCode !== 0) {
    return null;
  }
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  const hash = lines[1]?.trim();
  return hash && hash.length > 0 ? hash : null;
};

export const runDoltListRefs: RunDoltListRefs = async ({ doltPath }) => {
  const rows = await queryJson(doltPath, 'SELECT name, hash FROM dolt_branches');
  return rows
    .filter((row) => row.name && row.hash)
    .map((row) => ({ branch: row.name as string, hash: row.hash as string }));
};
