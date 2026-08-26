/**
 * Reads the timestamp of the latest commit in a Dolt repository's own
 * immutable commit graph (`dolt_log`), used as the anti-tamper source of
 * truth (see `anti-tamper.ts`).
 *
 * Dolt is consumed strictly as a black-box binary here: we invoke its CLI
 * and parse its output, never its Go source or an embedded library. All
 * arguments are passed through Bun's shell templating (`Bun.$`), which
 * quotes each interpolated value as a single argument — this is equivalent
 * to using an argv array and prevents shell injection (see OWASP A03 in
 * .github/copilot-instructions.md).
 */
import { $ } from 'bun';

export interface CommitLogReader {
  getLatestCommitTimestamp(): Promise<Date | null>;
}

const LATEST_COMMIT_DATE_QUERY = 'select `date` from dolt_log order by `date` desc limit 1';

/**
 * Converts a `dolt_log.date` CSV value ("YYYY-MM-DD HH:MM:SS.sss", implicitly
 * UTC, no separator/offset) into a `Date`. Exported as a pure function so the
 * UTC-normalization fix is unit-testable independent of the host's timezone
 * and without shelling out to a real `dolt` binary.
 */
export function parseDoltLogDate(rawValue: string): Date {
  const isoUtc = `${rawValue.replace(' ', 'T')}Z`;
  const timestamp = new Date(isoUtc);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(`Unexpected value read from dolt_log.date: "${rawValue}"`);
  }
  return timestamp;
}

export class DoltCliCommitLogReader implements CommitLogReader {
  constructor(private readonly doltRepoPath: string) {}

  async getLatestCommitTimestamp(): Promise<Date | null> {
    const result =
      await $`dolt --data-dir ${this.doltRepoPath} sql -q ${LATEST_COMMIT_DATE_QUERY} -r csv`
        .quiet()
        .nothrow();

    if (result.exitCode !== 0) {
      throw new Error(
        `dolt CLI exited with code ${result.exitCode} while reading dolt_log: ${result.stderr.toString().trim()}`,
      );
    }

    const lines = result.stdout
      .toString()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // First line is the CSV header ("date"); the second (if present) is the value.
    const [, dataLine] = lines;
    if (!dataLine) {
      return null;
    }

    // Dolt's `dolt_log.date` is emitted in UTC as "YYYY-MM-DD HH:MM:SS.sss",
    // with no "T" separator and no "Z"/offset suffix. Parsing that string
    // directly with `new Date()` is a footgun: engines treat a
    // space-separated, suffix-less datetime as *local* time, silently
    // shifting it by the host's UTC offset. See `parseDoltLogDate` above.
    return parseDoltLogDate(dataLine);
  }
}
