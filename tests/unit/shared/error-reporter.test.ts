import { describe, expect, it } from 'bun:test';
import {
  createDiagnosticError,
  DiagnosticError,
  formatDiagnostic,
  isDiagnosticError,
  normalizeError,
} from '../../../src/shared/error-reporter';

describe('error-reporter', () => {
  it('formats structured diagnostic error with [ERROR], [DIAGNOSIS], and [ACTION]', () => {
    const output = formatDiagnostic(
      {
        title: 'Port 9090 is in use',
        diagnosis: 'Another process is actively listening on this socket.',
        action: 'Stop the conflicting process or change APP_PORT.',
        code: 'ERR_PORT_IN_USE',
      },
      { colors: false },
    );

    expect(output).toContain('[ERROR]     Port 9090 is in use (ERR_PORT_IN_USE)');
    expect(output).toContain('[DIAGNOSIS] Another process is actively listening on this socket.');
    expect(output).toContain('[ACTION]    Stop the conflicting process or change APP_PORT.');
  });

  it('formats details dictionary properly', () => {
    const output = formatDiagnostic(
      {
        title: 'Filesystem permission denied',
        diagnosis: 'Cannot write to target path.',
        action: 'Fix permissions.',
        details: {
          path: '/var/lib/deltix',
          uid: 1000,
        },
      },
      { colors: false },
    );

    expect(output).toContain('[DETAILS]');
    expect(output).toContain('- path: /var/lib/deltix');
    expect(output).toContain('- uid: 1000');
  });

  it('handles DiagnosticError class and type guard', () => {
    const error = createDiagnosticError({
      title: 'Database connection failed',
      diagnosis: 'File is locked by another SQLite instance.',
      action: 'Close competing connections.',
      code: 'ERR_DB_LOCKED',
    });

    expect(error instanceof DiagnosticError).toBe(true);
    expect(isDiagnosticError(error)).toBe(true);
    expect(error.message).toBe('Database connection failed');
    expect(error.diagnosis).toBe('File is locked by another SQLite instance.');
    expect(error.action).toBe('Close competing connections.');
    expect(error.code).toBe('ERR_DB_LOCKED');

    const report = error.toReport();
    expect(report.title).toBe('Database connection failed');
    expect(report.code).toBe('ERR_DB_LOCKED');
  });

  it('normalizes standard Error objects', () => {
    const standardError = new Error('Socket hang up');
    const report = normalizeError(standardError);

    expect(report.title).toBe('Socket hang up');
    expect(report.code).toBe('ERR_UNHANDLED_EXCEPTION');
    expect(report.diagnosis).toContain('Socket hang up');
    expect(report.action).toContain('Check application logs');
  });

  it('normalizes raw strings and unknown values', () => {
    const stringReport = normalizeError('Plain string failure');
    expect(stringReport.title).toBe('Plain string failure');
    expect(stringReport.code).toBe('ERR_GENERIC_STRING');

    const unknownReport = normalizeError({ custom: 'object' });
    expect(unknownReport.code).toBe('ERR_UNKNOWN');
  });
});
