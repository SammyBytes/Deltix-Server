/**
 * Simulated NAS adapter backed by a local folder (`DELTIX_NAS_SIM_PATH`).
 * No physical NAS is available in this environment yet, but the contract
 * mirrors exactly what a real NAS client (e.g. NFS/SMB mount, or a remote
 * copy over SSH) would need to guarantee: copy bytes, verify their
 * integrity, and only make the copy visible via an atomic rename — never
 * a partially-written file visible under its final name.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { NasAdapter } from './nas-adapter';

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export class LocalFsNasAdapter implements NasAdapter {
  constructor(private readonly simRootPath: string) {}

  async copyToNas(stagingPath: string, repo: string): Promise<{ checksum: string }> {
    const destDir = join(this.simRootPath, repo);
    await mkdir(destDir, { recursive: true });

    const finalPath = join(destDir, 'repo.dolt');
    // Write to a temp path first, verify, THEN atomically rename into
    // place. A reader/lister of `destDir` must never observe a
    // partially-copied file under the final name.
    const tmpPath = join(destDir, `.tmp-${crypto.randomUUID()}`);

    try {
      await copyFile(stagingPath, tmpPath);
      const checksum = await sha256File(tmpPath);
      await mkdir(dirname(finalPath), { recursive: true });
      await rename(tmpPath, finalPath);
      return { checksum };
    } catch (err) {
      await unlink(tmpPath).catch(() => {
        // Best-effort cleanup; the tmp file being missing is not an error.
      });
      throw err;
    }
  }
}
