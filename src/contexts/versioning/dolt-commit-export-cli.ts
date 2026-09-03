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

async function changedTables(doltPath: string, commitHash: string): Promise<string[]> {
  const r = await runDolt([
    '--data-dir',
    doltPath,
    'diff',
    '--name-only',
    `${commitHash}^..${commitHash}`,
  ]);
  if (r.exitCode !== 0) {
    return []; // root commit (no parent) → nothing changed
  }
  return r.stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((table) => table.length > 0 && SAFE_TABLE_RE.test(table));
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

async function tableSchema(doltPath: string, table: string): Promise<string> {
  const r = await runDolt(['--data-dir', doltPath, 'schema', 'export', table]);
  if (r.exitCode !== 0) {
    throw new Error(`dolt schema export of ${table} failed: ${r.stderr.trim()}`);
  }
  return r.stdout;
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
    const tables = await changedTables(doltPath, hash);
    if (tables.length === 0) {
      continue; // skip the dolt-init commit and any no-op commit
    }
    const exported = [];
    for (const table of tables) {
      exported.push({
        name: table,
        schema: await tableSchema(doltPath, table),
        data: await tableData(doltPath, table, hash),
      });
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
