import { describe, expect, it } from 'bun:test';
import { assertNoClockRollback } from '../../../src/contexts/licensing/anti-tamper';
import { ClockRollbackDetectedError } from '../../../src/contexts/licensing/errors';

describe('licensing/anti-tamper', () => {
  it('allows boot when the system clock is at or after the latest Dolt commit', () => {
    const latestCommit = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date('2026-01-01T00:00:05.000Z');

    expect(() => assertNoClockRollback(now, latestCommit, 1000)).not.toThrow();
  });

  it('allows boot when there is no commit history yet (null)', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(() => assertNoClockRollback(now, null, 1000)).not.toThrow();
  });

  it('allows small clock drift within tolerance', () => {
    const latestCommit = new Date('2026-01-01T00:00:05.000Z');
    const now = new Date('2026-01-01T00:00:04.000Z'); // 1s "behind", tolerance is 2s

    expect(() => assertNoClockRollback(now, latestCommit, 2000)).not.toThrow();
  });

  it('blocks boot when the clock is behind the latest commit beyond tolerance', () => {
    const latestCommit = new Date('2026-01-01T00:10:00.000Z');
    const now = new Date('2026-01-01T00:00:00.000Z'); // 10 minutes behind

    expect(() => assertNoClockRollback(now, latestCommit, 5000)).toThrow(
      ClockRollbackDetectedError,
    );
  });
});
