import { describe, expect, it } from 'bun:test';
import { parseDoltLogDate } from '../../../src/contexts/licensing/dolt-commit-log.reader';

describe('licensing/dolt-commit-log.reader parseDoltLogDate', () => {
  it('interprets the space-separated dolt_log date as UTC, not host-local time', () => {
    // Regression test: dolt_log.date has no "T"/"Z"/offset, but the value IS
    // UTC. `new Date("2026-08-26 07:44:00.035")` would previously be parsed
    // as host-local time, silently shifting the timestamp by the host's UTC
    // offset (observed as a ~4h skew in a UTC-4 environment) and triggering
    // false-positive clock-rollback detection.
    const parsed = parseDoltLogDate('2026-08-26 07:44:00.035');
    expect(parsed.toISOString()).toBe('2026-08-26T07:44:00.035Z');
  });

  it('throws for a value that cannot be parsed as a date at all', () => {
    expect(() => parseDoltLogDate('not-a-date')).toThrow();
  });
});
