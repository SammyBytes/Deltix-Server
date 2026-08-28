/**
 * Structured diagnostic error reporter.
 *
 * Formats errors and troubleshooting guidance into standardized, actionable
 * blocks:
 *   [ERROR]     - What failed or went wrong.
 *   [DIAGNOSIS] - Root cause, underlying context, and technical details.
 *   [ACTION]    - Prescriptive steps for the operator to resolve the issue.
 *
 * Zero emojis, clean ANSI styling when supported, fully typed.
 */

export interface DiagnosticReport {
  /** Brief summary or title of the error condition. */
  title: string;
  /** Detailed explanation of the root cause and why the error occurred. */
  diagnosis: string;
  /** Prescriptive instructions explaining how the operator can resolve the issue. */
  action: string;
  /** Optional machine-readable error code (e.g. ERR_PORT_IN_USE, ERR_DATA_DIR_PERMISSION). */
  code?: string;
  /** Optional key-value metadata providing extra context. */
  details?: Record<string, unknown>;
  /** Optional underlying cause or caught exception. */
  cause?: unknown;
}

export interface FormatDiagnosticOptions {
  /** Explicitly enable or disable ANSI color formatting. Auto-detected if omitted. */
  colors?: boolean;
  /** Include stack trace from cause if available. Defaults to false. */
  includeStack?: boolean;
}

export interface ReportErrorOptions extends FormatDiagnosticOptions {
  /** Destination stream. Defaults to 'stderr'. */
  stream?: 'stderr' | 'stdout';
  /** Exit process with this code after reporting. If undefined, process does not exit. */
  exitCode?: number;
}

/**
 * Custom error class carrying structured diagnostic information.
 */
export class DiagnosticError extends Error {
  readonly diagnosis: string;
  readonly action: string;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(report: DiagnosticReport) {
    super(report.title);
    this.name = 'DiagnosticError';
    this.diagnosis = report.diagnosis;
    this.action = report.action;
    if (report.code !== undefined) {
      this.code = report.code;
    }
    if (report.details !== undefined) {
      this.details = report.details;
    }
    if (report.cause !== undefined) {
      this.cause = report.cause;
    }
  }

  toReport(): DiagnosticReport {
    const report: DiagnosticReport = {
      title: this.message,
      diagnosis: this.diagnosis,
      action: this.action,
    };
    if (this.code !== undefined) {
      report.code = this.code;
    }
    if (this.details !== undefined) {
      report.details = this.details;
    }
    if (this.cause !== undefined) {
      report.cause = this.cause;
    }
    return report;
  }
}

/**
 * Type guard to check if an unknown error is an instance of DiagnosticError.
 */
export function isDiagnosticError(error: unknown): error is DiagnosticError {
  return error instanceof DiagnosticError;
}

/**
 * Creates a new DiagnosticError from a DiagnosticReport.
 */
export function createDiagnosticError(report: DiagnosticReport): DiagnosticError {
  return new DiagnosticError(report);
}

/**
 * Determines whether ANSI colors should be used for formatting.
 */
function shouldColorize(explicit?: boolean): boolean {
  if (explicit !== undefined) {
    return explicit;
  }
  if (typeof Bun !== 'undefined' && Bun.env) {
    if (Bun.env.NO_COLOR !== undefined && Bun.env.NO_COLOR !== '') {
      return false;
    }
    if (Bun.env.FORCE_COLOR === '1' || Bun.env.FORCE_COLOR === 'true') {
      return true;
    }
  }
  if (typeof process !== 'undefined' && process.stderr) {
    return Boolean(process.stderr.isTTY);
  }
  return false;
}

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

/**
 * Formats a multi-line string with uniform indentation after the first line.
 */
function formatIndented(text: string, prefixLength: number): string {
  const lines = text.trim().split('\n');
  if (lines.length === 0) return '';
  const firstLine = lines[0] ?? '';
  if (lines.length === 1) return firstLine;
  const padding = ' '.repeat(prefixLength);
  return [firstLine, ...lines.slice(1).map((line) => `${padding}${line}`)].join('\n');
}

/**
 * Formats a DiagnosticReport into a clean, standardized diagnostic block.
 */
export function formatDiagnostic(
  report: DiagnosticReport,
  options: FormatDiagnosticOptions = {},
): string {
  const useColors = shouldColorize(options.colors);

  const errorTag = useColors ? `${ANSI.bold}${ANSI.red}[ERROR]${ANSI.reset}` : '[ERROR]';
  const diagTag = useColors ? `${ANSI.bold}${ANSI.yellow}[DIAGNOSIS]${ANSI.reset}` : '[DIAGNOSIS]';
  const actionTag = useColors ? `${ANSI.bold}${ANSI.cyan}[ACTION]${ANSI.reset}` : '[ACTION]';

  const codeSuffix = report.code ? ` (${report.code})` : '';
  const titleText = `${report.title}${codeSuffix}`;
  const titleFormatted = useColors
    ? `${ANSI.bold}${ANSI.white}${titleText}${ANSI.reset}`
    : titleText;

  const lines: string[] = [
    `${errorTag}     ${formatIndented(titleFormatted, 12)}`,
    `${diagTag} ${formatIndented(report.diagnosis, 12)}`,
    `${actionTag}    ${formatIndented(report.action, 12)}`,
  ];

  if (report.details && Object.keys(report.details).length > 0) {
    const detailsTag = useColors ? `${ANSI.dim}[DETAILS]${ANSI.reset}` : '[DETAILS]';
    const formattedEntries = Object.entries(report.details)
      .map(
        ([key, value]) =>
          `  - ${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`,
      )
      .join('\n');
    lines.push(`${detailsTag}   \n${formattedEntries}`);
  }

  if (options.includeStack && report.cause instanceof Error && report.cause.stack) {
    const stackTag = useColors ? `${ANSI.dim}[STACK]${ANSI.reset}` : '[STACK]';
    lines.push(`${stackTag}     \n${report.cause.stack}`);
  }

  return lines.join('\n');
}

/**
 * Normalizes an unknown caught error into a DiagnosticReport.
 */
export function normalizeError(error: unknown): DiagnosticReport {
  if (isDiagnosticError(error)) {
    return error.toReport();
  }

  if (error instanceof Error) {
    return {
      title: error.message || 'An unexpected error occurred',
      diagnosis: error.stack
        ? `Exception of type ${error.name} was thrown: ${error.message}`
        : `An unexpected exception was encountered (${error.name}).`,
      action: 'Check application logs and verify configuration parameters.',
      code: 'ERR_UNHANDLED_EXCEPTION',
      cause: error,
    };
  }

  if (typeof error === 'string') {
    return {
      title: error,
      diagnosis: 'A string error was thrown without structured metadata.',
      action: 'Check logs and verify recent system operations.',
      code: 'ERR_GENERIC_STRING',
    };
  }

  return {
    title: 'An unknown fatal error occurred',
    diagnosis: `Received non-standard error value: ${JSON.stringify(error)}`,
    action: 'Inspect system state, ensure all required environment variables are set, and re-run.',
    code: 'ERR_UNKNOWN',
    cause: error,
  };
}

/**
 * Reports an error to the specified stream with standardized diagnostic formatting.
 */
export function reportError(error: unknown, options: ReportErrorOptions = {}): void {
  const report = normalizeError(error);
  const formatted = formatDiagnostic(report, options);
  const stream = options.stream ?? 'stderr';

  if (stream === 'stderr') {
    console.error(formatted);
  } else {
    console.log(formatted);
  }

  if (typeof options.exitCode === 'number') {
    process.exit(options.exitCode);
  }
}
