/**
 * Build/version metadata exposed on the public, unauthenticated `/status`
 * endpoint (see `src/index.ts`). Intentionally minimal — no internal
 * topology, dependency versions, or stack traces are ever exposed here
 * (OWASP A05: verbose banners are a reconnaissance aid for attackers).
 *
 * `commit` resolution order:
 *   1. `DELTIX_BUILD_COMMIT` env var — set by CI at build time (see
 *      `.github/workflows/cd.yml`), the only reliable source once the
 *      server is packaged as a standalone binary (`bun build --compile`),
 *      since a compiled binary has no `.git` directory to inspect.
 *   2. `git rev-parse --short HEAD` — best-effort fallback for local
 *      `bun run dev`, never required for a valid boot.
 *   3. `'unknown'` — never blocks boot; version reporting is diagnostic,
 *      not a security or correctness gate.
 */
import { $ } from 'bun';
import packageJson from '../../package.json' with { type: 'json' };

export interface BuildInfo {
  version: string;
  commit: string;
  nodeEnv: string;
}

let cached: BuildInfo | null = null;

async function resolveCommit(): Promise<string> {
  const fromEnv = Bun.env.DELTIX_BUILD_COMMIT;
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const result = await $`git rev-parse --short HEAD`.quiet();
    return result.stdout.toString().trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Resolved once and cached — commit/version never change during the process lifetime. */
export async function getBuildInfo(): Promise<BuildInfo> {
  if (!cached) {
    cached = {
      version: packageJson.version,
      commit: await resolveCommit(),
      nodeEnv: Bun.env.NODE_ENV ?? 'development',
    };
  }
  return cached;
}
