/**
 * Centralized, validated access to environment variables.
 *
 * Every env var the app depends on is declared and validated here with zod.
 * The process MUST fail fast and loudly at boot if a required variable is
 * missing or malformed — never silently fall back to an insecure default
 * for security-sensitive values (keys, secrets, paths).
 */
import { z } from 'zod';

const envSchema = z.object({
  // Licensing (Fase 1)
  DELTIX_LICENSE_PUBLIC_KEY: z
    .string()
    .min(1, 'DELTIX_LICENSE_PUBLIC_KEY is required (Ed25519 public key, never hardcode it)'),
  DELTIX_LICENSE_KEY: z.string().min(1, 'DELTIX_LICENSE_KEY is required'),
  DELTIX_DOLT_REPO_PATH: z.string().min(1, 'DELTIX_DOLT_REPO_PATH is required'),
  DELTIX_CLOCK_TOLERANCE_MS: z.coerce.number().int().nonnegative().default(5000),

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
