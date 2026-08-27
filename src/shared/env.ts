import { z } from 'zod';

const localUserSchema = z.object({
  username: z.string().min(1),
  passwordHash: z.string().min(1),
});

const optionalLocalUsersSchema = z
  .string()
  .min(1, 'DELTIX_LOCAL_USERS must be a non-empty JSON array when provided')
  .transform((raw, ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'DELTIX_LOCAL_USERS must be valid JSON' });
      return z.NEVER;
    }
    const result = z.array(localUserSchema).min(1).max(3).safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({
        code: 'custom',
        message: 'DELTIX_LOCAL_USERS must be a JSON array of 1-3 {username, passwordHash} entries',
      });
      return z.NEVER;
    }
    return result.data;
  })
  .optional();

const envSchema = z
  .object({
    DELTIX_LICENSE_PUBLIC_KEY: z
      .string()
      .min(1, 'DELTIX_LICENSE_PUBLIC_KEY is required (Ed25519 public key, never hardcode it)'),
    DELTIX_LICENSE_KEY: z.string().min(1, 'DELTIX_LICENSE_KEY is required'),
    DELTIX_DOLT_REPO_PATH: z.string().min(1, 'DELTIX_DOLT_REPO_PATH is required'),
    DELTIX_CLOCK_TOLERANCE_MS: z.coerce.number().int().nonnegative().default(5000),
    DELTIX_JWT_PRIVATE_KEY: z
      .string()
      .min(1, 'DELTIX_JWT_PRIVATE_KEY is required (Ed25519 PKCS8 PEM, never hardcode it)'),
    DELTIX_JWT_PUBLIC_KEY: z
      .string()
      .min(1, 'DELTIX_JWT_PUBLIC_KEY is required (Ed25519 SPKI PEM, never hardcode it)'),
    DELTIX_LOCAL_USERS: optionalLocalUsersSchema,
    DELTIX_USER_DB_PATH: z.string().default('./data/users.db'),
    DELTIX_BOOTSTRAP_ADMIN_USERNAME: z.string().min(1).optional(),
    DELTIX_BOOTSTRAP_ADMIN_PASSWORD: z.string().min(1).optional(),
    DELTIX_SESSION_DB_PATH: z.string().min(1, 'DELTIX_SESSION_DB_PATH is required'),
    DELTIX_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    DELTIX_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(120),
    DELTIX_CORS_ALLOWED_ORIGINS: z
      .string()
      .default('')
      .transform((raw) =>
        raw
          .split(',')
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0),
      ),
    DELTIX_ADMIN_UI_ENABLED: z.preprocess(
      (value) =>
        typeof value === 'string' ? ['true', '1', 'yes'].includes(value.toLowerCase()) : value,
      z.boolean().default(false),
    ),
    DELTIX_TICKET_DB_PATH: z.string().default('./data/transfer-tickets.db'),
    DELTIX_TICKET_TTL_SECONDS: z.coerce.number().int().positive().default(120),
    DELTIX_TRANSFER_JOB_DB_PATH: z.string().default('./data/transfer-jobs.db'),
    DELTIX_NAS_SIM_PATH: z.string().default('./data/nas-sim'),
    DELTIX_NAS_SYNC_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(1000),
    DELTIX_NAS_SYNC_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(60_000),
    DELTIX_NAS_SYNC_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
    DELTIX_TRANSFER_JOB_MAX_RETRIES: z.coerce.number().int().positive().default(5),
    DELTIX_GRPC_PORT: z.coerce.number().int().positive().default(50051),
    DELTIX_GRPC_TLS_CERT_PATH: z
      .string()
      .min(
        1,
        'DELTIX_GRPC_TLS_CERT_PATH is required (PEM cert chain, see scripts/generate-dev-tls-certs.ts for local dev)',
      ),
    DELTIX_GRPC_TLS_KEY_PATH: z
      .string()
      .min(
        1,
        'DELTIX_GRPC_TLS_KEY_PATH is required (PEM private key, see scripts/generate-dev-tls-certs.ts for local dev)',
      ),
    DELTIX_STAGING_ROOT_PATH: z.string().default('./data/staging'),
    DELTIX_ADDON_TRUST_DB_PATH: z.string().default('./data/addon-trust.db'),
    DELTIX_ADDON_PATHS: z.string().default(''),
    DELTIX_ADDON_FREE_OFFICIAL: z.string().default(''),
    DELTIX_ADDON_MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().positive().default(5),
    DELTIX_REPO_DB_PATH: z.string().default('./data/repos.db'),
    DELTIX_DOLT_REPOS_ROOT_PATH: z.string().default('./data/dolt-repos'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  })
  .superRefine((env, ctx) => {
    const hasBootstrapUsername = typeof env.DELTIX_BOOTSTRAP_ADMIN_USERNAME === 'string';
    const hasBootstrapPassword = typeof env.DELTIX_BOOTSTRAP_ADMIN_PASSWORD === 'string';
    if (hasBootstrapUsername !== hasBootstrapPassword) {
      ctx.addIssue({
        code: 'custom',
        message:
          'DELTIX_BOOTSTRAP_ADMIN_USERNAME and DELTIX_BOOTSTRAP_ADMIN_PASSWORD must be set together',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

export function loadEnv(source: Record<string, string | undefined> = Bun.env): Env {
  if (!cachedEnv) {
    cachedEnv = envSchema.parse(source);
  }
  return cachedEnv;
}

export function __resetEnvCacheForTests(): void {
  cachedEnv = undefined;
}
