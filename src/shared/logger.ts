/**
 * Lightweight, configurable structured logging built on Pino.
 *
 * - `LOG_LEVEL` controls verbosity (trace..fatal), default "info".
 * - `LOG_PRETTY=true` renders human-readable, colorized output for local
 *   development (via pino-pretty). In production, plain JSON is emitted so
 *   logs can be shipped to any aggregator without extra parsing.
 * - Sensitive fields are redacted automatically — never log secrets, keys,
 *   signatures or tokens in clear text.
 *
 * This module is truly cross-cutting and context-agnostic (see
 * .github/copilot-instructions.md §2), so it deliberately does NOT depend on
 * `./env.ts` — that schema also validates licensing-specific variables
 * (`DELTIX_LICENSE_*`), and a shared logger must be usable by any context
 * without pulling in another context's required configuration.
 */
import pino, { type Logger } from 'pino';
import { z } from 'zod';

const booleanFromEnv = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.toLowerCase());
    return defaultValue;
  }, z.boolean().default(defaultValue));

const loggerEnvSchema = z.object({
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: booleanFromEnv(false),
});

const REDACTED_PATHS = [
  'licenseKey',
  'signature',
  'publicKey',
  'privateKey',
  'token',
  'password',
  '*.licenseKey',
  '*.signature',
  '*.publicKey',
  '*.privateKey',
  '*.token',
  '*.password',
];

let rootLogger: Logger | undefined;

function getRootLogger(): Logger {
  if (!rootLogger) {
    const env = loggerEnvSchema.parse(Bun.env);
    rootLogger = pino({
      level: env.LOG_LEVEL,
      redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
      transport: env.LOG_PRETTY
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
        : undefined,
    });
  }
  return rootLogger;
}

/**
 * Creates a child logger scoped to a bounded context (e.g. "licensing",
 * "http"), so every log line carries its origin without manual tagging.
 */
export function createLogger(context: string): Logger {
  return getRootLogger().child({ context });
}

/** Test-only helper to reset the cached root logger between test cases. */
export function __resetLoggerCacheForTests(): void {
  rootLogger = undefined;
}
