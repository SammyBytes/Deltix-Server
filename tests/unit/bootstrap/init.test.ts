import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootstrap,
  checkDirectoryPermissions,
  checkPortAvailable,
  detectSystemDataDir,
  ensureCryptoKeypair,
  ensureDataDirectoryStructure,
  initSqlite,
  resolveDataDirectory,
  resolveServerPort,
} from '../../../src/bootstrap/init';

describe('bootstrap init engine', () => {
  let testTempDir: string;

  beforeEach(() => {
    testTempDir = join(
      tmpdir(),
      `deltix_test_bootstrap_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    );
  });

  afterEach(() => {
    try {
      if (existsSync(testTempDir)) {
        rmSync(testTempDir, { recursive: true, force: true });
      }
    } catch {
      // Cleanup best-effort
    }
  });

  it('detects platform data directory and resolves custom path', () => {
    const defaultDataDir = detectSystemDataDir();
    expect(typeof defaultDataDir).toBe('string');
    expect(defaultDataDir.length).toBeGreaterThan(0);

    const custom = resolveDataDirectory('/tmp/custom/deltix');
    expect(custom).toBe('/tmp/custom/deltix');
  });

  it('ensures complete directory structure layout', () => {
    const dirs = ensureDataDirectoryStructure(testTempDir);

    expect(existsSync(dirs.dataDir)).toBe(true);
    expect(existsSync(dirs.keysDir)).toBe(true);
    expect(existsSync(dirs.dbDir)).toBe(true);
    expect(existsSync(dirs.stagingDir)).toBe(true);
    expect(existsSync(dirs.reposDir)).toBe(true);
    expect(existsSync(dirs.certsDir)).toBe(true);
  });

  it('verifies directory permissions probe', () => {
    const perm = checkDirectoryPermissions(testTempDir);
    expect(perm.readable).toBe(true);
    expect(perm.writable).toBe(true);
  });

  it('detects port availability and resolves dynamic ports', async () => {
    // Check random high port
    const testPort = 34567;
    const isFree = await checkPortAvailable(testPort, '127.0.0.1');
    expect(typeof isFree).toBe('boolean');

    const resolved = await resolveServerPort(testPort, '127.0.0.1', false);
    expect(resolved.port).toBe(testPort);
    expect(resolved.adjusted).toBe(false);
  });

  it('generates and persists Ed25519 cryptographic keypair', () => {
    const keysDir = join(testTempDir, 'keys');
    const firstGen = ensureCryptoKeypair(keysDir);

    expect(firstGen.created).toBe(true);
    expect(firstGen.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(firstGen.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(existsSync(firstGen.privateKeyPath)).toBe(true);
    expect(existsSync(firstGen.publicKeyPath)).toBe(true);

    // Second call should load existing without regenerating
    const secondLoad = ensureCryptoKeypair(keysDir);
    expect(secondLoad.created).toBe(false);
    expect(secondLoad.privateKeyPem).toBe(firstGen.privateKeyPem);
    expect(secondLoad.publicKeyPem).toBe(firstGen.publicKeyPem);
  });

  it('initializes zero-config bun:sqlite with WAL mode and pragmas', () => {
    const dbPath = join(testTempDir, 'db', 'test.db');
    const db = initSqlite(dbPath);

    const pragmaJournal = db.prepare('PRAGMA journal_mode;').get() as { journal_mode?: string };
    expect(pragmaJournal.journal_mode?.toLowerCase()).toBe('wal');

    const metaTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_schema_meta';")
      .get();
    expect(metaTable).toBeDefined();

    db.close();
  });

  it('executes full end-to-end bootstrap sequence', async () => {
    const result = await bootstrap({
      skipPortCheck: true,
      configOptions: {
        env: {
          APP_DATA_DIR: testTempDir,
        },
      },
    });

    expect(result.directories.dataDir).toBe(testTempDir);
    expect(result.keys.privateKeyPem).toBeDefined();
    expect(result.db).toBeDefined();
    expect(result.bootstrapDurationMs).toBeGreaterThanOrEqual(0);

    result.db?.close();
  });
});
