/**
 * Centralized, validated access to environment variables.
 *
 * Every env var the app depends on is declared and validated here with zod.
 * The process MUST fail fast and loudly at boot if a required variable is
 * missing or malformed — never silently fall back to an insecure default
 * for security-sensitive values (keys, secrets, paths).
 */
import { z } from 'zod';

const localUserSchema = z.object({
  username: z.string().min(1),
  passwordHash: z.string().min(1),
});

const envSchema = z.object({
  // Licensing (Fase 1)
  DELTIX_LICENSE_PUBLIC_KEY: z
    .string()
    .min(1, 'DELTIX_LICENSE_PUBLIC_KEY is required (Ed25519 public key, never hardcode it)'),
  DELTIX_LICENSE_KEY: z.string().min(1, 'DELTIX_LICENSE_KEY is required'),
  DELTIX_DOLT_REPO_PATH: z.string().min(1, 'DELTIX_DOLT_REPO_PATH is required'),
  DELTIX_CLOCK_TOLERANCE_MS: z.coerce.number().int().nonnegative().default(5000),

  // Auth / Control Plane REST (Fase 2)
  DELTIX_JWT_PRIVATE_KEY: z
    .string()
    .min(1, 'DELTIX_JWT_PRIVATE_KEY is required (Ed25519 PKCS8 PEM, never hardcode it)'),
  DELTIX_JWT_PUBLIC_KEY: z
    .string()
    .min(1, 'DELTIX_JWT_PUBLIC_KEY is required (Ed25519 SPKI PEM, never hardcode it)'),
  DELTIX_LOCAL_USERS: z
    .string()
    .min(1, 'DELTIX_LOCAL_USERS is required (JSON array of {username, passwordHash})')
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
          message:
            'DELTIX_LOCAL_USERS must be a JSON array of 1-3 {username, passwordHash} entries',
        });
        return z.NEVER;
      }
      return result.data;
    }),
  DELTIX_SESSION_DB_PATH: z.string().min(1, 'DELTIX_SESSION_DB_PATH is required'),
  DELTIX_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  DELTIX_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(120),

  // CORS allow-list: comma-separated list of exact origins allowed to call the
  // REST API cross-origin (e.g. the Admin Web UI if served from a different
  // origin/port). Empty by default — the CLI client talks server-to-server,
  // not from a browser, so no origin needs to be allowed until the Admin Web
  // UI requires it. NEVER default this to "*" for an authenticated API.
  DELTIX_CORS_ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((raw) =>
      raw
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),

  // Admin Web UI (Fase 2 follow-up): disabled by default to keep the attack
  // surface minimal for headless/CI-driven deployments. Uses the SAME auth
  // endpoints as the CLI — no separate auth path to secure.
  DELTIX_ADMIN_UI_ENABLED: z.preprocess(
    (value) =>
      typeof value === 'string' ? ['true', '1', 'yes'].includes(value.toLowerCase()) : value,
    z.boolean().default(false),
  ),

  // Ephemeral transfer tickets (Fase 3: gRPC transfer engine). Reuses the
  // same sliding-window discipline as REST auth sessions (Fase 2) — see
  // src/contexts/transfer/ticket.service.ts.
  DELTIX_TICKET_DB_PATH: z.string().default('./data/transfer-tickets.db'),
  DELTIX_TICKET_TTL_SECONDS: z.coerce.number().int().positive().default(120),

  // SSD staging -> NAS sync pipeline (Fase 3 continued). No physical NAS is
  // available yet, so DELTIX_NAS_SIM_PATH points at a local folder that is
  // treated exactly like a real NAS mount (copy + checksum + atomic
  // rename) — swapping in a real NAS adapter later requires no changes to
  // NasSyncService, only a new NasAdapter implementation.
  DELTIX_TRANSFER_JOB_DB_PATH: z.string().default('./data/transfer-jobs.db'),
  DELTIX_NAS_SIM_PATH: z.string().default('./data/nas-sim'),
  DELTIX_NAS_SYNC_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(1000),
  DELTIX_NAS_SYNC_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(60_000),
  DELTIX_NAS_SYNC_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  DELTIX_TRANSFER_JOB_MAX_RETRIES: z.coerce.number().int().positive().default(5),

  // gRPC Transfer Engine (Fase 3 continued): Push/Pull/Heartbeat wire
  // protocol. ALWAYS TLS — the server never binds a plaintext listener,
  // so cert/key paths are required (no insecure default). Generate a
  // local dev cert with `bun run scripts/generate-dev-tls-certs.ts`.
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

  // Addon system (Fase 4): TOFU trust store for community addon author
  // keys, plus local-filesystem-only addon discovery paths (comma
  // separated). See docs/decisions/0001-addon-licensing-and-business-model.md.
  DELTIX_ADDON_TRUST_DB_PATH: z.string().default('./data/addon-trust.db'),
  DELTIX_ADDON_PATHS: z.string().default(''),
  /** Official addon names that are always free (never gated by the license payload). */
  DELTIX_ADDON_FREE_OFFICIAL: z.string().default(''),
  /** Consecutive runtime failures before an addon route is disabled in-memory until restart. */
  DELTIX_ADDON_MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().positive().default(5),

  // Reserved for future phases
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

/**
 * Parses and validates `Bun.env` on first call, caching the result.
 * Throws a descriptive ZodError-based message if validation fails.
 */
export function loadEnv(source: Record<string, string | undefined> = Bun.env): Env {
  if (!cachedEnv) {
    cachedEnv = envSchema.parse(source);
  }
  return cachedEnv;
}

/** Test-only helper to reset the cache between test cases. */
export function __resetEnvCacheForTests(): void {
  cachedEnv = undefined;
}
