/**
 * Real `dolt init` invocation, used by the composition root
 * (`create-repo-provisioning-service.ts`) as the `RunDoltInit` dependency.
 * Dolt is consumed strictly as a black-box binary here — same convention
 * as `contexts/licensing/dolt-commit-log.reader.ts`. All arguments are
 * passed through Bun's shell templating (`Bun.$`), which quotes each
 * interpolated value as a single argument, preventing shell injection
 * (OWASP A03).
 */
import { mkdir } from 'node:fs/promises';
import { $ } from 'bun';
import type { RunDoltInit } from './repo-provisioning.service';

export const runDoltInit: RunDoltInit = async (doltPath: string): Promise<void> => {
  await mkdir(doltPath, { recursive: true });
  const result = await $`dolt --data-dir ${doltPath} init`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(
      `dolt init exited with code ${result.exitCode}: ${result.stderr.toString().trim()}`,
    );
  }
};
