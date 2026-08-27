import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { $ } from 'bun';
import { assertSafeTableName } from './dolt-foreign-key-reader';
import type { PushSyncValidationResult } from './sync-preference-types';

export interface PlannedPushPayload {
  stagingPath: string;
  createdDerivedPath: boolean;
}

export async function planPushPayload(
  repoId: string,
  originalStagingPath: string,
  repoRoot: string,
  options: PushSyncValidationResult,
): Promise<PlannedPushPayload> {
  if (options.dryRun || (options.mode === 'schema_and_data' && !options.resolvedTables)) {
    return { stagingPath: originalStagingPath, createdDerivedPath: false };
  }

  const derivedPath = join(dirname(originalStagingPath), `${repoId}.sync-plan.sql`);
  await mkdir(dirname(derivedPath), { recursive: true });
  const statements: string[] = [];
  const tables = options.resolvedTables ?? [];
  for (const table of tables) {
    assertSafeTableName(table);
    const schema = await $`dolt --data-dir ${repoRoot} schema export ${table}`.quiet().nothrow();
    if (schema.exitCode !== 0) {
      throw new Error(`dolt schema export failed for ${table}: ${schema.stderr.toString().trim()}`);
    }
    statements.push(schema.stdout.toString().trim());

    if (options.mode === 'schema_and_data') {
      const rows =
        await $`dolt --data-dir ${repoRoot} table export -r sql ${table} ${derivedPath}.${table}.rows.sql`
          .quiet()
          .nothrow();
      if (rows.exitCode !== 0) {
        throw new Error(`dolt table export failed for ${table}: ${rows.stderr.toString().trim()}`);
      }
      const rowFile = Bun.file(`${derivedPath}.${table}.rows.sql`);
      statements.push((await rowFile.text()).trim());
      await rm(`${derivedPath}.${table}.rows.sql`, { force: true });
    }
  }
  await Bun.write(
    derivedPath,
    String.raw(
      { raw: ['', '\n'] },
      ['', statements.filter(Boolean).join('\n\n')].join('\n').trimStart(),
    ),
  );
  return { stagingPath: derivedPath, createdDerivedPath: true };
}
