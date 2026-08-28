/**
 * System bootstrap, hardware/filesystem checks, persistent crypto keys,
 * zero-config SQLite initialization, and dynamic port detection.
 *
 * Designed for Bun v1.4.
 * Zero emojis, clean error diagnostics, fully typed.
 */

import { Database } from 'bun:sqlite';
import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type AppConfig, type ConfigLoadOptions, loadConfig } from '../config/schema';
import { DiagnosticError } from '../shared/error-reporter';

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

export interface ResolvedDirectories {
  dataDir: string;
  keysDir: string;
  dbDir: string;
  stagingDir: string;
  reposDir: string;
  certsDir: string;
}

export interface PermissionCheckResult {
  readable: boolean;
  writable: boolean;
  executable: boolean;
  path: string;
}

export interface PersistentKeypair {
  privateKeyPem: string;
  publicKeyPem: string;
  privateKeyPath: string;
  publicKeyPath: string;
  created: boolean;
}

export interface SqliteInitOptions {
  walMode?: boolean;
  busyTimeoutMs?: number;
  readOnly?: boolean;
}

export interface BootstrapOptions {
  configOptions?: ConfigLoadOptions;
  overrides?: Partial<AppConfig>;
  skipDatabaseInit?: boolean;
  skipPortCheck?: boolean;
}

export interface BootstrapContext {
  config: AppConfig;
  directories: ResolvedDirectories;
  ports: {
    httpPort: number;
    grpcPort: number;
    httpPortAdjusted: boolean;
  };
  keys: PersistentKeypair;
  db?: Database;
  bootstrapDurationMs: number;
}

// ---------------------------------------------------------------------------
// 1. Data Directory Resolution
// ---------------------------------------------------------------------------

/**
 * Returns platform-standard persistent data directory for Deltix.
 */
export function detectSystemDataDir(): string {
  const osType = platform();
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  if (osType === 'linux') {
    if (isRoot) {
      return '/var/lib/deltix';
    }
    const xdgData = Bun.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
    return join(xdgData, 'deltix');
  }

  if (osType === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'deltix');
  }

  if (osType === 'win32') {
    const appData =
      Bun.env.PROGRAMDATA || Bun.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(appData, 'deltix');
  }

  return resolve('./data');
}

/**
 * Resolves the effective data directory based on configuration and platform standards.
 */
export function resolveDataDirectory(configuredPath?: string): string {
  if (configuredPath && configuredPath !== './data') {
    return resolve(configuredPath);
  }
  return resolve(configuredPath ?? './data');
}

/**
 * Ensures data directory tree exists with proper directory structure.
 */
export function ensureDataDirectoryStructure(baseDataDir: string): ResolvedDirectories {
  const resolvedBase = resolve(baseDataDir);
  const dirs: ResolvedDirectories = {
    dataDir: resolvedBase,
    keysDir: join(resolvedBase, 'keys'),
    dbDir: join(resolvedBase, 'db'),
    stagingDir: join(resolvedBase, 'staging'),
    reposDir: join(resolvedBase, 'repos'),
    certsDir: join(resolvedBase, 'certs'),
  };

  for (const dirPath of Object.values(dirs)) {
    if (!existsSync(dirPath)) {
      try {
        mkdirSync(dirPath, { recursive: true, mode: 0o750 });
      } catch (err) {
        throw new DiagnosticError({
          title: `Cannot create directory: ${dirPath}`,
          diagnosis: `Directory creation failed with error: ${err instanceof Error ? err.message : String(err)}`,
          action: `Verify write permissions on parent directory ${dirname(dirPath)} or run with appropriate system privileges.`,
          code: 'ERR_DIR_CREATION_FAILED',
          cause: err,
        });
      }
    }
  }

  return dirs;
}

// ---------------------------------------------------------------------------
// 2. Permissions Check
// ---------------------------------------------------------------------------

function probeFileWriteAndRead(resolved: string): void {
  const probeFile = join(
    resolved,
    `.deltix_perm_probe_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
  );
  try {
    writeFileSync(probeFile, 'deltix-permissions-probe-test', { mode: 0o600 });
  } catch (err) {
    throw new DiagnosticError({
      title: `Data directory is not writable: ${resolved}`,
      diagnosis: `Failed to write probe file inside directory: ${err instanceof Error ? err.message : String(err)}`,
      action: `Grant write permissions to the running user: chmod -R 750 "${resolved}" && chown -R $(whoami) "${resolved}"`,
      code: 'ERR_DATA_DIR_NOT_WRITABLE',
      details: { directory: resolved },
      cause: err,
    });
  }

  try {
    const readContent = readFileSync(probeFile, 'utf-8');
    if (readContent !== 'deltix-permissions-probe-test') {
      throw new Error('Read content mismatch');
    }
  } catch (err) {
    throw new DiagnosticError({
      title: `Data directory is not readable: ${resolved}`,
      diagnosis: `Failed to read back probe file from directory: ${err instanceof Error ? err.message : String(err)}`,
      action: `Ensure read permissions are granted on directory: chmod -R u+r "${resolved}"`,
      code: 'ERR_DATA_DIR_NOT_READABLE',
      cause: err,
    });
  } finally {
    try {
      if (existsSync(probeFile)) {
        unlinkSync(probeFile);
      }
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Probes read, write, and execute permissions on a target directory.
 */
export function checkDirectoryPermissions(dirPath: string): PermissionCheckResult {
  const resolved = resolve(dirPath);

  if (!existsSync(resolved)) {
    try {
      mkdirSync(resolved, { recursive: true, mode: 0o750 });
    } catch (err) {
      throw new DiagnosticError({
        title: `Directory does not exist and cannot be created: ${resolved}`,
        diagnosis: `Encountered filesystem error while creating directory: ${err instanceof Error ? err.message : String(err)}`,
        action: `Create the directory manually or ensure parent directory is writable: mkdir -p "${resolved}"`,
        code: 'ERR_DATA_DIR_PERMISSION',
        cause: err,
      });
    }
  }

  probeFileWriteAndRead(resolved);

  const stat = statSync(resolved);
  return {
    readable: true,
    writable: true,
    executable: Boolean(stat.mode & 0o111),
    path: resolved,
  };
}

// ---------------------------------------------------------------------------
// 3. Dynamic Port Detection
// ---------------------------------------------------------------------------

/**
 * Checks whether a given TCP port is available for binding on the host.
 */
export async function checkPortAvailable(port: number, host = '0.0.0.0'): Promise<boolean> {
  try {
    const probe = Bun.listen({
      port,
      hostname: host,
      socket: {
        data() {},
        open() {},
        close() {},
        error() {},
      },
    });
    probe.stop(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a TCP port, finding the next available port if dynamicPort is enabled.
 */
export async function resolveServerPort(
  preferredPort: number,
  host = '0.0.0.0',
  dynamicPort = false,
  maxAttempts = 50,
): Promise<{ port: number; adjusted: boolean }> {
  const isPreferredAvailable = await checkPortAvailable(preferredPort, host);
  if (isPreferredAvailable) {
    return { port: preferredPort, adjusted: false };
  }

  if (!dynamicPort) {
    throw new DiagnosticError({
      title: `Port ${preferredPort} is already in use on ${host}`,
      diagnosis: `Cannot bind to port ${preferredPort} because another process is actively listening on this socket.`,
      action: `Stop the conflicting service on port ${preferredPort}, choose a different port via APP_PORT=<port>, or enable dynamic port allocation via APP_DYNAMIC_PORT=true.`,
      code: 'ERR_PORT_IN_USE',
      details: { port: preferredPort, host },
    });
  }

  for (let offset = 1; offset <= maxAttempts; offset++) {
    const candidate = preferredPort + offset;
    if (candidate > 65535) break;
    const available = await checkPortAvailable(candidate, host);
    if (available) {
      return { port: candidate, adjusted: true };
    }
  }

  throw new DiagnosticError({
    title: `No available ports found starting from ${preferredPort}`,
    diagnosis: `Dynamic port scan probed ${maxAttempts} consecutive ports starting at ${preferredPort} on ${host}, but all were occupied.`,
    action: `Free up network ports on the host or specify an explicit free port via APP_PORT=<port>.`,
    code: 'ERR_NO_AVAILABLE_PORTS',
    details: { preferredPort, host, maxAttempts },
  });
}

// ---------------------------------------------------------------------------
// 4. Persistent Cryptographic Keys
// ---------------------------------------------------------------------------

/**
 * Ensures Ed25519 cryptographic keypair exists on disk.
 * Generates and securely saves keypair if not present.
 */
export function ensureCryptoKeypair(keysDir: string, keyPrefix = 'jwt_ed25519'): PersistentKeypair {
  const resolvedDir = resolve(keysDir);
  if (!existsSync(resolvedDir)) {
    mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });
  }

  const privPath = join(resolvedDir, `${keyPrefix}.pkcs8`);
  const pubPath = join(resolvedDir, `${keyPrefix}.spki`);

  if (existsSync(privPath) && existsSync(pubPath)) {
    try {
      const privateKeyPem = readFileSync(privPath, 'utf-8');
      const publicKeyPem = readFileSync(pubPath, 'utf-8');
      return {
        privateKeyPem,
        publicKeyPem,
        privateKeyPath: privPath,
        publicKeyPath: pubPath,
        created: false,
      };
    } catch (err) {
      throw new DiagnosticError({
        title: `Failed to read existing cryptographic keys from ${resolvedDir}`,
        diagnosis: `Key files exist but could not be read: ${err instanceof Error ? err.message : String(err)}`,
        action: `Check file permissions on ${privPath} and ${pubPath}, or delete them to allow automatic regeneration.`,
        code: 'ERR_CRYPTO_KEY_READ_FAILED',
        cause: err,
      });
    }
  }

  // Generate fresh Ed25519 keypair
  let privateKeyPem: string;
  let publicKeyPem: string;
  try {
    const keyPair = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    privateKeyPem = keyPair.privateKey;
    publicKeyPem = keyPair.publicKey;
  } catch (err) {
    throw new DiagnosticError({
      title: 'Failed to generate Ed25519 cryptographic keypair',
      diagnosis: `Cryptographic subsystem failed during key generation: ${err instanceof Error ? err.message : String(err)}`,
      action: 'Ensure Bun and system cryptographic libraries are functional.',
      code: 'ERR_CRYPTO_KEY_GEN_FAILED',
      cause: err,
    });
  }

  try {
    writeFileSync(privPath, privateKeyPem, { mode: 0o600 });
    writeFileSync(pubPath, publicKeyPem, { mode: 0o644 });

    // Enforce restrictive POSIX permissions on private key
    if (platform() !== 'win32') {
      chmodSync(privPath, 0o600);
      chmodSync(pubPath, 0o644);
    }
  } catch (err) {
    throw new DiagnosticError({
      title: `Failed to write cryptographic keys to ${resolvedDir}`,
      diagnosis: `Error writing key files to disk: ${err instanceof Error ? err.message : String(err)}`,
      action: `Verify write permissions on directory ${resolvedDir}.`,
      code: 'ERR_CRYPTO_KEY_WRITE_FAILED',
      cause: err,
    });
  }

  return {
    privateKeyPem,
    publicKeyPem,
    privateKeyPath: privPath,
    publicKeyPath: pubPath,
    created: true,
  };
}

// ---------------------------------------------------------------------------
// 5. Zero-Config SQLite Initialization (bun:sqlite)
// ---------------------------------------------------------------------------

/**
 * Initializes and tunes a production-grade SQLite database via bun:sqlite.
 */
export function initSqlite(dbPath: string, options: SqliteInitOptions = {}): Database {
  const resolved = resolve(dbPath);
  const parent = dirname(resolved);

  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true, mode: 0o750 });
  }

  let db: Database;
  try {
    db = new Database(resolved, {
      create: !options.readOnly,
      readonly: options.readOnly ?? false,
    });
  } catch (err) {
    throw new DiagnosticError({
      title: `Failed to open SQLite database at ${resolved}`,
      diagnosis: `bun:sqlite failed to initialize database connection: ${err instanceof Error ? err.message : String(err)}`,
      action: `Check filesystem permissions on ${resolved} and verify the file is not locked by another process.`,
      code: 'ERR_SQLITE_INIT_FAILED',
      details: { dbPath: resolved },
      cause: err,
    });
  }

  // Apply production PRAGMAs
  const walMode = options.walMode ?? true;
  const busyTimeout = options.busyTimeoutMs ?? 5000;

  try {
    if (walMode) {
      db.exec('PRAGMA journal_mode = WAL;');
    }
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(`PRAGMA busy_timeout = ${busyTimeout};`);
    db.exec('PRAGMA temp_store = MEMORY;');

    // Bootstrap metadata table
    db.exec(`
      CREATE TABLE IF NOT EXISTS _schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Quick integrity check
    const checkStmt = db.prepare('PRAGMA quick_check;');
    const checkResult = checkStmt.get() as { quick_check?: string } | undefined;
    if (checkResult && checkResult.quick_check !== 'ok') {
      throw new Error(`Database integrity check failed: ${checkResult.quick_check}`);
    }
  } catch (err) {
    db.close();
    throw new DiagnosticError({
      title: `SQLite configuration or integrity check failed for ${resolved}`,
      diagnosis: `Failed to apply PRAGMAs or integrity check returned failure: ${err instanceof Error ? err.message : String(err)}`,
      action: `Verify database file integrity. If corrupted, restore from backup or remove ${resolved} to re-initialize.`,
      code: 'ERR_SQLITE_PRAGMA_FAILED',
      cause: err,
    });
  }

  return db;
}

// ---------------------------------------------------------------------------
// 6. Bootstrap Orchestrator
// ---------------------------------------------------------------------------

/**
 * Executes full application bootstrap: configuration resolution, directory
 * creation, permissions probe, dynamic port allocation, persistent keys, and
 * zero-config SQLite initialization.
 */
export async function bootstrap(options: BootstrapOptions = {}): Promise<BootstrapContext> {
  const startTime = performance.now();

  // 1. Resolve configuration
  const config = loadConfig(options.configOptions);
  if (options.overrides) {
    Object.assign(config, options.overrides);
  }

  // 2. Resolve data directory & check permissions
  const dataDir = resolveDataDirectory(config.storage.dataDir);
  const directories = ensureDataDirectoryStructure(dataDir);
  checkDirectoryPermissions(directories.dataDir);

  // 3. Port check & dynamic allocation
  let httpPort = config.server.port;
  let httpPortAdjusted = false;
  const grpcPort = config.server.grpcPort;

  if (!options.skipPortCheck) {
    const resolvedHttp = await resolveServerPort(
      config.server.port,
      config.server.host,
      config.server.dynamicPort,
    );
    httpPort = resolvedHttp.port;
    httpPortAdjusted = resolvedHttp.adjusted;

    const isGrpcAvailable = await checkPortAvailable(grpcPort, config.server.host);
    if (!isGrpcAvailable) {
      throw new DiagnosticError({
        title: `gRPC port ${grpcPort} is already in use on ${config.server.host}`,
        diagnosis: `Cannot bind gRPC service to port ${grpcPort} because another process is actively listening.`,
        action: `Configure a different gRPC port via APP_GRPC_PORT=<port> or stop the conflicting service.`,
        code: 'ERR_GRPC_PORT_IN_USE',
        details: { grpcPort, host: config.server.host },
      });
    }
  }

  // 4. Persistent crypto keys
  const keys = ensureCryptoKeypair(directories.keysDir);
  if (!config.auth.jwtPrivateKey) {
    config.auth.jwtPrivateKey = keys.privateKeyPem;
    config.auth.jwtPrivateKeyPath = keys.privateKeyPath;
  }
  if (!config.auth.jwtPublicKey) {
    config.auth.jwtPublicKey = keys.publicKeyPem;
    config.auth.jwtPublicKeyPath = keys.publicKeyPath;
  }

  // 5. Zero-config SQLite DB initialization
  let db: Database | undefined;
  if (!options.skipDatabaseInit) {
    const primaryDbPath = join(directories.dbDir, 'deltix.db');
    db = initSqlite(primaryDbPath);
  }

  const endTime = performance.now();
  const bootstrapDurationMs = Math.round((endTime - startTime) * 100) / 100;

  return {
    config,
    directories,
    ports: {
      httpPort,
      grpcPort,
      httpPortAdjusted,
    },
    keys,
    db,
    bootstrapDurationMs,
  };
}
