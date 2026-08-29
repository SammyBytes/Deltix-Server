/**
 * Real Dolt CLI implementation of `RunDoltCommit` (Fase 5.2). Dolt is
 * consumed strictly as a black-box binary, same convention as
 * `dolt-cli.ts`'s `runDoltInit` and `licensing/dolt-commit-log.reader.ts`.
 *
 * Ensures a `deltix_push_log` table exists (idempotent `CREATE TABLE IF
 * NOT EXISTS`), inserts one row per push, then runs `dolt add -A` +
 * `dolt commit` with `--author` attributing the commit to the pushing
 * user. All dynamic values are passed as bound `dolt sql` `-q` arguments
 * built via parameterless string interpolation of already-validated
 * values only (`jobId`/`checksum` are server-generated hex/UUID strings,
 * never raw user input; `authorName` is sanitized below) — never raw,
 * unsanitized user input, consistent with the project's OWASP A03
 * discipline for shelling out to `dolt`.
 */
import { $ } from 'bun';
import type { RunDoltCommit } from './commit.service';

// dolt --author expects "Name <email>"; usernames in this project are a
// closed, already-validated set (Fase 2 auth), but we still strip
// characters that would break out of the quoted CLI argument as
// defense-in-depth (OWASP A03) rather than trusting the auth layer alone.
function sanitizeAuthorName(username: string): string {
  return username.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

// Defense-in-depth (OWASP A03): jobId (UUID v4) and checksum (hex SHA-256)
// are always server-generated in this codebase (see `PushSessionHandler`),
// never raw user input, but we still assert their expected shape before
// string-interpolating them into a `dolt sql` statement — the CLI does not
// offer parameterized queries, so this allow-list check is the only
// injection defense available at this layer.
const UUID_RE = /^[0-9a-fA-F-]{36}$/;
const HEX_RE = /^[0-9a-f]{64}$/;

function assertSafeSqlValue(value: string, kind: 'jobId' | 'checksum'): void {
  const re = kind === 'jobId' ? UUID_RE : HEX_RE;
  if (!re.test(value)) {
    throw new Error(`Refusing to commit: ${kind} "${value}" has an unexpected shape`);
  }
}

export const runDoltCommit: RunDoltCommit = async ({
  doltPath,
  authorName,
  jobId,
  checksum,
  tables,
}): Promise<string> => {
  const safeAuthor = sanitizeAuthorName(authorName);
  assertSafeSqlValue(jobId, 'jobId');
  assertSafeSqlValue(checksum, 'checksum');
  const authorFlag = `${safeAuthor} <${safeAuthor}@deltix.local>`;

  const createTable = await $`dolt --data-dir ${doltPath} sql -q ${
    'CREATE TABLE IF NOT EXISTS deltix_push_log (' +
    'job_id VARCHAR(64) PRIMARY KEY, ' +
    'author VARCHAR(128) NOT NULL, ' +
    'checksum VARCHAR(128) NOT NULL, ' +
    'pushed_at BIGINT NOT NULL)'
  }`
    .quiet()
    .nothrow();
  if (createTable.exitCode !== 0) {
    throw new Error(`dolt sql (create table) failed: ${createTable.stderr.toString().trim()}`);
  }

  const insertRow =
    await $`dolt --data-dir ${doltPath} sql -q ${`INSERT INTO deltix_push_log (job_id, author, checksum, pushed_at) VALUES ('${jobId}', '${safeAuthor}', '${checksum}', ${Date.now()})`}`
      .quiet()
      .nothrow();
  if (insertRow.exitCode !== 0) {
    throw new Error(`dolt sql (insert) failed: ${insertRow.stderr.toString().trim()}`);
  }

  const addArgs = tables && tables.length > 0
    ? ['--data-dir', doltPath, 'add', ...tables]
    : ['--data-dir', doltPath, 'add', '-A'];
  const addProc = Bun.spawn(['dolt', ...addArgs], { stdout: 'ignore', stderr: 'pipe' });
  const addExitCode = await addProc.exited;
  if (addExitCode !== 0) {
    const addStderr = await new Response(addProc.stderr).text();
    throw new Error(`dolt add failed: ${addStderr.trim()}`);
  }

  const commit =
    await $`dolt --data-dir ${doltPath} commit --author=${authorFlag} -m ${`push: job=${jobId} checksum=${checksum}`}`
      .quiet()
      .nothrow();
  if (commit.exitCode !== 0) {
    throw new Error(`dolt commit failed: ${commit.stderr.toString().trim()}`);
  }

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
