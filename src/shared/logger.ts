/**
 * Lightweight, configurable structured logging built on Pino.
 *
 * - `LOG_LEVEL` controls verbosity (trace..fatal), default "info".
 * - `LOG_PRETTY=true` renders human-readable, colorized output for local
 *   development (via pino-pretty). In production, plain JSON is emitted so
 *   logs can be shipped to any aggregator without extra parsing.
 * - Sensitive fields are redacted automatically — never log secrets, keys,
 *   signatures or tokens in clear text.
 */
import pino, { type Logger } from 'pino';
import { loadEnv } from './env';

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
    const env = loadEnv();
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
