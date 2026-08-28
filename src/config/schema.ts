/**
 * Application configuration schema and hierarchical configuration loader.
 *
 * Implements strict hierarchical configuration resolution:
 *   1. Built-in defaults (safe, production-ready baseline)
 *   2. Local configuration file (config.json / APP_CONFIG_PATH)
 *   3. Environment variables (APP_* with fallback to DELTIX_*)
 *
 * Zero emojis, clean error diagnostics, fully typed with Zod.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DiagnosticError } from '../shared/error-reporter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const booleanCoerce = z.preprocess((val) => {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(lower)) return true;
    if (['false', '0', 'no', 'off'].includes(lower)) return false;
  }
  return val;
}, z.boolean());

const stringArrayCoerce = z.preprocess((val) => {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') return [];
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim());
      } catch {
        // Fall back to comma-separated
      }
    }
    return trimmed
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return val;
}, z.array(z.string()));

function assignIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const serverConfigSchema = z.object({
  host: z.string().min(1).default('0.0.0.0'),
  port: z.coerce.number().int().min(1).max(65535).default(9090),
  grpcPort: z.coerce.number().int().min(1).max(65535).default(50051),
  dynamicPort: booleanCoerce.default(false),
  tls: z
    .object({
      enabled: booleanCoerce.default(false),
      certPath: z.string().min(1).optional(),
      keyPath: z.string().min(1).optional(),
      autoGenerate: booleanCoerce.default(false),
    })
    .default({}),
});

export const storageConfigSchema = z.object({
  dataDir: z.string().min(1).default('./data'),
  stagingRootPath: z.string().min(1).default('./data/staging'),
  doltReposRootPath: z.string().min(1).default('./data/dolt-repos'),
  nasSimPath: z.string().min(1).default('./data/nas-sim'),
});

export const databaseConfigSchema = z.object({
  userDbPath: z.string().min(1).default('./data/users.db'),
  repoDbPath: z.string().min(1).default('./data/repos.db'),
  ticketDbPath: z.string().min(1).default('./data/transfer-tickets.db'),
  transferJobDbPath: z.string().min(1).default('./data/transfer-jobs.db'),
  addonTrustDbPath: z.string().min(1).default('./data/addon-trust.db'),
  sessionDbPath: z.string().min(1).default('./data/sessions.db'),
});

export const authConfigSchema = z
  .object({
    jwtPrivateKey: z.string().min(1).optional(),
    jwtPublicKey: z.string().min(1).optional(),
    jwtPrivateKeyPath: z.string().min(1).optional(),
    jwtPublicKeyPath: z.string().min(1).optional(),
    sessionTtlSeconds: z.coerce.number().int().positive().default(120),
    accessTokenTtlSeconds: z.coerce.number().int().positive().default(900),
    corsAllowedOrigins: stringArrayCoerce.default([]),
    adminUiEnabled: booleanCoerce.default(false),
    bootstrapAdminUsername: z.string().min(1).optional(),
    bootstrapAdminPassword: z.string().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    const hasUser =
      typeof data.bootstrapAdminUsername === 'string' && data.bootstrapAdminUsername.length > 0;
    const hasPass =
      typeof data.bootstrapAdminPassword === 'string' && data.bootstrapAdminPassword.length > 0;
    if (hasUser !== hasPass) {
      ctx.addIssue({
        code: 'custom',
        message: 'bootstrapAdminUsername and bootstrapAdminPassword must be provided together',
        path: ['bootstrapAdminUsername'],
      });
    }
  });

export const loggingConfigSchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  pretty: booleanCoerce.default(false),
});

export const appConfigSchema = z.object({
  environment: z.enum(['development', 'production', 'test']).default('development'),
  server: serverConfigSchema.default({}),
  storage: storageConfigSchema.default({}),
  database: databaseConfigSchema.default({}),
  auth: authConfigSchema.default({}),
  logging: loggingConfigSchema.default({}),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type StorageConfig = z.infer<typeof storageConfigSchema>;
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;
export type AuthConfig = z.infer<typeof authConfigSchema>;
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;

export interface ConfigLoadOptions {
  /** Optional custom path to config JSON file. */
  configPath?: string;
  /** Environment variable map to read from. Defaults to Bun.env or process.env. */
  env?: Record<string, string | undefined>;
  /** Optional programmatic overrides merged with highest priority. */
  overrides?: Partial<DeepPartial<AppConfig>>;
}

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: AppConfig = {
  environment: 'development',
  server: {
    host: '0.0.0.0',
    port: 9090,
    grpcPort: 50051,
    dynamicPort: false,
    tls: {
      enabled: false,
      autoGenerate: false,
    },
  },
  storage: {
    dataDir: './data',
    stagingRootPath: './data/staging',
    doltReposRootPath: './data/dolt-repos',
    nasSimPath: './data/nas-sim',
  },
  database: {
    userDbPath: './data/users.db',
    repoDbPath: './data/repos.db',
    ticketDbPath: './data/transfer-tickets.db',
    transferJobDbPath: './data/transfer-jobs.db',
    addonTrustDbPath: './data/addon-trust.db',
    sessionDbPath: './data/sessions.db',
  },
  auth: {
    sessionTtlSeconds: 120,
    accessTokenTtlSeconds: 900,
    corsAllowedOrigins: [],
    adminUiEnabled: false,
  },
  logging: {
    level: 'info',
    pretty: false,
  },
};

// ---------------------------------------------------------------------------
// Deep Merge Utility
// ---------------------------------------------------------------------------

function isPlainObject(item: unknown): item is Record<string, unknown> {
  return typeof item === 'object' && item !== null && !Array.isArray(item);
}

export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>,
): T {
  const output = { ...target };
  for (const key of Object.keys(source)) {
    const sourceValue = source[key];
    const targetValue = output[key];

    if (sourceValue === undefined) {
      continue;
    }

    if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
      output[key as keyof T] = deepMerge(targetValue, sourceValue) as unknown as T[keyof T];
    } else {
      output[key as keyof T] = sourceValue as unknown as T[keyof T];
    }
  }
  return output;
}

// ---------------------------------------------------------------------------
// Modular Environment Extraction Functions
// ---------------------------------------------------------------------------

function extractServerEnv(env: Record<string, string | undefined>): Record<string, unknown> {
  const server: Record<string, unknown> = {};
  const tls: Record<string, unknown> = {};

  assignIfDefined(server, 'host', env.APP_HOST ?? env.APP_SERVER_HOST ?? env.DELTIX_HTTP_HOST);
  assignIfDefined(server, 'port', env.APP_PORT ?? env.APP_SERVER_PORT ?? env.DELTIX_HTTP_PORT);
  assignIfDefined(
    server,
    'grpcPort',
    env.APP_GRPC_PORT ?? env.APP_SERVER_GRPC_PORT ?? env.DELTIX_GRPC_PORT,
  );
  assignIfDefined(server, 'dynamicPort', env.APP_DYNAMIC_PORT ?? env.APP_SERVER_DYNAMIC_PORT);

  assignIfDefined(tls, 'enabled', env.APP_TLS_ENABLED ?? env.APP_SERVER_TLS_ENABLED);
  assignIfDefined(
    tls,
    'certPath',
    env.APP_TLS_CERT_PATH ?? env.APP_SERVER_TLS_CERT_PATH ?? env.DELTIX_HTTP_TLS_CERT_PATH,
  );
  assignIfDefined(
    tls,
    'keyPath',
    env.APP_TLS_KEY_PATH ?? env.APP_SERVER_TLS_KEY_PATH ?? env.DELTIX_HTTP_TLS_KEY_PATH,
  );
  assignIfDefined(tls, 'autoGenerate', env.APP_TLS_AUTO_GENERATE);

  if (Object.keys(tls).length > 0) server.tls = tls;
  return server;
}

function extractStorageEnv(env: Record<string, string | undefined>): Record<string, unknown> {
  const storage: Record<string, unknown> = {};

  assignIfDefined(storage, 'dataDir', env.APP_DATA_DIR ?? env.APP_STORAGE_DATA_DIR);
  assignIfDefined(storage, 'stagingRootPath', env.APP_STAGING_PATH ?? env.DELTIX_STAGING_ROOT_PATH);
  assignIfDefined(
    storage,
    'doltReposRootPath',
    env.APP_REPOS_PATH ?? env.DELTIX_DOLT_REPOS_ROOT_PATH,
  );
  assignIfDefined(storage, 'nasSimPath', env.APP_NAS_PATH ?? env.DELTIX_NAS_SIM_PATH);

  return storage;
}

function extractDatabaseEnv(env: Record<string, string | undefined>): Record<string, unknown> {
  const database: Record<string, unknown> = {};

  assignIfDefined(database, 'userDbPath', env.APP_USER_DB_PATH ?? env.DELTIX_USER_DB_PATH);
  assignIfDefined(database, 'repoDbPath', env.APP_REPO_DB_PATH ?? env.DELTIX_REPO_DB_PATH);
  assignIfDefined(database, 'ticketDbPath', env.APP_TICKET_DB_PATH ?? env.DELTIX_TICKET_DB_PATH);
  assignIfDefined(
    database,
    'transferJobDbPath',
    env.APP_TRANSFER_JOB_DB_PATH ?? env.DELTIX_TRANSFER_JOB_DB_PATH,
  );
  assignIfDefined(
    database,
    'addonTrustDbPath',
    env.APP_ADDON_TRUST_DB_PATH ?? env.DELTIX_ADDON_TRUST_DB_PATH,
  );
  assignIfDefined(database, 'sessionDbPath', env.APP_SESSION_DB_PATH ?? env.DELTIX_SESSION_DB_PATH);

  return database;
}

function extractAuthEnv(env: Record<string, string | undefined>): Record<string, unknown> {
  const auth: Record<string, unknown> = {};

  assignIfDefined(auth, 'jwtPrivateKey', env.APP_JWT_PRIVATE_KEY ?? env.DELTIX_JWT_PRIVATE_KEY);
  assignIfDefined(auth, 'jwtPublicKey', env.APP_JWT_PUBLIC_KEY ?? env.DELTIX_JWT_PUBLIC_KEY);
  assignIfDefined(auth, 'jwtPrivateKeyPath', env.APP_JWT_PRIVATE_KEY_PATH);
  assignIfDefined(auth, 'jwtPublicKeyPath', env.APP_JWT_PUBLIC_KEY_PATH);
  assignIfDefined(
    auth,
    'sessionTtlSeconds',
    env.APP_SESSION_TTL_SECONDS ?? env.DELTIX_SESSION_TTL_SECONDS,
  );
  assignIfDefined(
    auth,
    'accessTokenTtlSeconds',
    env.APP_ACCESS_TOKEN_TTL_SECONDS ?? env.DELTIX_ACCESS_TOKEN_TTL_SECONDS,
  );
  assignIfDefined(
    auth,
    'corsAllowedOrigins',
    env.APP_CORS_ALLOWED_ORIGINS ?? env.DELTIX_CORS_ALLOWED_ORIGINS,
  );
  assignIfDefined(auth, 'adminUiEnabled', env.APP_ADMIN_UI_ENABLED ?? env.DELTIX_ADMIN_UI_ENABLED);
  assignIfDefined(
    auth,
    'bootstrapAdminUsername',
    env.APP_BOOTSTRAP_ADMIN_USERNAME ?? env.DELTIX_BOOTSTRAP_ADMIN_USERNAME,
  );
  assignIfDefined(
    auth,
    'bootstrapAdminPassword',
    env.APP_BOOTSTRAP_ADMIN_PASSWORD ?? env.DELTIX_BOOTSTRAP_ADMIN_PASSWORD,
  );

  return auth;
}

function extractLoggingEnv(env: Record<string, string | undefined>): Record<string, unknown> {
  const logging: Record<string, unknown> = {};
  assignIfDefined(logging, 'level', env.APP_LOG_LEVEL ?? env.LOG_LEVEL);
  assignIfDefined(logging, 'pretty', env.APP_LOG_PRETTY ?? env.LOG_PRETTY);
  return logging;
}

function extractDoubleUnderscoreEnv(
  env: Record<string, string | undefined>,
  result: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('APP__') || value === undefined) continue;
    const parts = key.substring(5).toLowerCase().split('__');
    const section = parts[0];
    const prop = parts[1];
    if (section && prop && parts.length === 2) {
      const secObj = (result[section] ?? {}) as Record<string, unknown>;
      secObj[prop] = value;
      result[section] = secObj;
    }
  }
}

export function extractEnvConfig(env: Record<string, string | undefined>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  const rawEnv = env.APP_ENV ?? env.NODE_ENV;
  if (rawEnv !== undefined) result.environment = rawEnv;

  const server = extractServerEnv(env);
  if (Object.keys(server).length > 0) result.server = server;

  const storage = extractStorageEnv(env);
  if (Object.keys(storage).length > 0) result.storage = storage;

  const database = extractDatabaseEnv(env);
  if (Object.keys(database).length > 0) result.database = database;

  const auth = extractAuthEnv(env);
  if (Object.keys(auth).length > 0) result.auth = auth;

  const logging = extractLoggingEnv(env);
  if (Object.keys(logging).length > 0) result.logging = logging;

  extractDoubleUnderscoreEnv(env, result);
  return result;
}

// ---------------------------------------------------------------------------
// File Loader
// ---------------------------------------------------------------------------

export function loadConfigFile(filePath: string): Record<string, unknown> {
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    return {};
  }

  let content: string;
  try {
    content = readFileSync(resolved, 'utf-8');
  } catch (err) {
    throw new DiagnosticError({
      title: `Failed to read configuration file at ${resolved}`,
      diagnosis: `The configuration file exists but could not be opened: ${err instanceof Error ? err.message : String(err)}`,
      action: `Verify filesystem permissions on ${resolved} and ensure the current user has read access.`,
      code: 'ERR_CONFIG_FILE_READ_FAILED',
      cause: err,
    });
  }

  try {
    const parsed = JSON.parse(content);
    if (!isPlainObject(parsed)) {
      throw new Error('Root JSON configuration must be an object');
    }
    return parsed;
  } catch (err) {
    throw new DiagnosticError({
      title: `Invalid JSON in configuration file: ${resolved}`,
      diagnosis: `Syntax error encountered while parsing configuration JSON: ${err instanceof Error ? err.message : String(err)}`,
      action: `Check ${resolved} for syntax errors (missing commas, trailing commas, unmatched quotes) or validate with a JSON linter.`,
      code: 'ERR_CONFIG_JSON_PARSE_ERROR',
      cause: err,
    });
  }
}

// ---------------------------------------------------------------------------
// Main Loader
// ---------------------------------------------------------------------------

let cachedConfig: AppConfig | undefined;

/**
 * Loads, merges, and validates the application configuration.
 * Resolution hierarchy: Defaults -> config.json -> Environment Variables -> Overrides.
 */
export function loadConfig(options: ConfigLoadOptions = {}): AppConfig {
  const env = options.env ?? (typeof Bun !== 'undefined' ? Bun.env : process.env);

  let merged: Record<string, unknown> = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  const candidatePaths = [
    options.configPath,
    env.APP_CONFIG_PATH,
    env.DELTIX_CONFIG_PATH,
    './config.json',
    './config.local.json',
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  for (const pathCandidate of candidatePaths) {
    if (existsSync(pathCandidate)) {
      const fileConfig = loadConfigFile(pathCandidate);
      merged = deepMerge(merged, fileConfig);
      break;
    }
  }

  const envConfig = extractEnvConfig(env);
  merged = deepMerge(merged, envConfig);

  if (options.overrides) {
    merged = deepMerge(merged, options.overrides as Record<string, unknown>);
  }

  const parseResult = appConfigSchema.safeParse(merged);
  if (!parseResult.success) {
    const issues = parseResult.error.issues.map(
      (issue) => ` - Path '${issue.path.join('.')}': ${issue.message}`,
    );

    throw new DiagnosticError({
      title: 'Configuration validation failed',
      diagnosis: `The merged application configuration contains invalid or incompatible values:\n${issues.join('\n')}`,
      action:
        'Correct the specified configuration parameters in your config.json or environment variables.',
      code: 'ERR_CONFIG_VALIDATION_FAILED',
      details: {
        issues: parseResult.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
      cause: parseResult.error,
    });
  }

  cachedConfig = parseResult.data;
  return parseResult.data;
}

/**
 * Gets the current cached config or loads it if not yet loaded.
 */
export function getConfig(): AppConfig {
  if (!cachedConfig) {
    return loadConfig();
  }
  return cachedConfig;
}

/**
 * Clears the cached configuration (primarily for tests).
 */
export function __resetConfigCacheForTests(): void {
  cachedConfig = undefined;
}

// ---------------------------------------------------------------------------
// Sanitization Utility
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /privatekey/i,
  /token/i,
  /licensekey/i,
  /credential/i,
];

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      sanitized[k] =
        isSensitiveKey(k) && typeof v === 'string' && v.length > 0
          ? '[REDACTED]'
          : sanitizeValue(v);
    }
    return sanitized;
  }
  return value;
}

/**
 * Recursively redacts sensitive keys from a configuration object for safe logging or export.
 */
export function exportSanitizedConfig(
  config: AppConfig | Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeValue(config) as Record<string, unknown>;
}
