import { describe, expect, it } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsNasAdapter } from '../../../src/contexts/storage/local-fs-nas-adapter';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('storage/local-fs-nas-adapter (integration, real filesystem)', () => {
  it('copies a staged file into the sim NAS root and returns the correct checksum', async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), 'deltix-staging-'));
    const nasRoot = await mkdtemp(join(tmpdir(), 'deltix-nas-sim-'));
    try {
      const content = randomBytes(1024);
      const stagingPath = join(stagingDir, 'repo.dolt');
      await writeFile(stagingPath, content);

      const adapter = new LocalFsNasAdapter(nasRoot);
      const { checksum } = await adapter.copyToNas(stagingPath, 'org/repo');

      expect(checksum).toBe(sha256(content));
      const written = await readFile(join(nasRoot, 'org/repo', 'repo.dolt'));
      expect(written.equals(content)).toBe(true);
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
      await rm(nasRoot, { recursive: true, force: true });
    }
  });

  it('creates nested repo directories under the NAS root on demand', async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), 'deltix-staging-'));
    const nasRoot = await mkdtemp(join(tmpdir(), 'deltix-nas-sim-'));
    try {
      const stagingPath = join(stagingDir, 'repo.dolt');
      await writeFile(stagingPath, 'hello');

      const adapter = new LocalFsNasAdapter(nasRoot);
      await adapter.copyToNas(stagingPath, 'deep/nested/org/repo');

      const written = await readFile(join(nasRoot, 'deep/nested/org/repo', 'repo.dolt'), 'utf8');
      expect(written).toBe('hello');
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
      await rm(nasRoot, { recursive: true, force: true });
    }
  });

  it('never leaves a stray .tmp- file behind after a successful copy', async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), 'deltix-staging-'));
    const nasRoot = await mkdtemp(join(tmpdir(), 'deltix-nas-sim-'));
    try {
      const stagingPath = join(stagingDir, 'repo.dolt');
      await writeFile(stagingPath, 'data');

      const adapter = new LocalFsNasAdapter(nasRoot);
      await adapter.copyToNas(stagingPath, 'org/repo');

      const { readdir } = await import('node:fs/promises');
      const files = await readdir(join(nasRoot, 'org/repo'));
      expect(files).toEqual(['repo.dolt']);
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
      await rm(nasRoot, { recursive: true, force: true });
    }
  });

  it('cleans up the tmp file and rethrows if the source file does not exist', async () => {
    const nasRoot = await mkdtemp(join(tmpdir(), 'deltix-nas-sim-'));
    try {
      const adapter = new LocalFsNasAdapter(nasRoot);
      await expect(adapter.copyToNas('/nonexistent/repo.dolt', 'org/repo')).rejects.toThrow();

      const { readdir } = await import('node:fs/promises');
      await mkdir(join(nasRoot, 'org/repo'), { recursive: true });
      const files = await readdir(join(nasRoot, 'org/repo'));
      expect(files.some((f) => f.startsWith('.tmp-'))).toBe(false);
    } finally {
      await rm(nasRoot, { recursive: true, force: true });
    }
  });
});
