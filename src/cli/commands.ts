/**
 * Diagnostic CLI subcommands: status, config export, doctor.
 *
 * Designed for production troubleshooting, operator observability, and automated diagnostics.
 * Zero emojis, clean ANSI styling, fully typed.
 */

import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { arch, cpus, freemem, platform, totalmem, uptime } from 'node:os';
import { join, resolve } from 'node:path';
import packageJson from '../../package.json' with { type: 'json' };
import {
  checkDirectoryPermissions,
  checkPortAvailable,
  ensureCryptoKeypair,
  ensureDataDirectoryStructure,
  resolveDataDirectory,
} from '../bootstrap/init';
import { exportSanitizedConfig, loadConfig } from '../config/schema';
import {
  type DiagnosticReport,
  formatDiagnostic,
  normalizeError,
  reportError,
} from '../shared/error-reporter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = (bytes / 1024 ** i).toFixed(2);
  return `${val} ${units[i]}`;
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// 1. Status Subcommand
// ---------------------------------------------------------------------------

export interface StatusReport {
  runtime: {
    engine: string;
    version: string;
    nodeVersion: string;
    os: string;
    arch: string;
    cpuCores: number;
    pid: number;
    uptime: string;
    memoryRss: string;
    memoryHeap: string;
    systemMemoryFree: string;
    systemMemoryTotal: string;
  };
  configuration: {
    environment: string;
    serverHost: string;
    httpPort: number;
    grpcPort: number;
    dynamicPort: boolean;
    tlsEnabled: boolean;
    adminUiEnabled: boolean;
  };
  storage: {
    dataDir: string;
    dataDirExists: boolean;
    isWritable: boolean;
    freeSpace: string;
  };
  database: {
    primaryDbExists: boolean;
    walMode: boolean;
  };
  crypto: {
    keysDir: string;
    hasPrivateKey: boolean;
    hasPublicKey: boolean;
  };
  network: {
    httpPortFree: boolean;
    grpcPortFree: boolean;
  };
}

export async function getSystemStatus(configPath?: string): Promise<StatusReport> {
  const config = loadConfig({ configPath });
  const dataDir = resolveDataDirectory(config.storage.dataDir);
  const dataDirExists = existsSync(dataDir);

  let isWritable = false;
  let freeSpace = 'Unknown';

  if (dataDirExists) {
    try {
      const perm = checkDirectoryPermissions(dataDir);
      isWritable = perm.writable;
      const fsStats = statfsSync(dataDir);
      freeSpace = formatBytes(fsStats.bavail * fsStats.bsize);
    } catch {
      isWritable = false;
    }
  }

  // DB check
  const primaryDbPath = join(dataDir, 'db', 'deltix.db');
  const primaryDbExists = existsSync(primaryDbPath);
  let walMode = false;
  if (primaryDbExists) {
    try {
      const db = new Database(primaryDbPath, { readonly: true });
      const stmt = db.prepare('PRAGMA journal_mode;');
      const res = stmt.get() as { journal_mode?: string } | undefined;
      walMode = res?.journal_mode?.toLowerCase() === 'wal';
      db.close();
    } catch {
      walMode = false;
    }
  }

  // Keys check
  const keysDir = join(dataDir, 'keys');
  const privKeyPath = join(keysDir, 'jwt_ed25519.pkcs8');
  const pubKeyPath = join(keysDir, 'jwt_ed25519.spki');
  const hasPrivateKey = existsSync(privKeyPath);
  const hasPublicKey = existsSync(pubKeyPath);

  // Network check
  const httpPortFree = await checkPortAvailable(config.server.port, config.server.host);
  const grpcPortFree = await checkPortAvailable(config.server.grpcPort, config.server.host);

  const memUsage = process.memoryUsage();

  return {
    runtime: {
      engine: 'Bun',
      version: Bun.version,
      nodeVersion: process.version,
      os: `${platform()} (${arch()})`,
      arch: arch(),
      cpuCores: cpus().length,
      pid: process.pid,
      uptime: formatDuration(uptime()),
      memoryRss: formatBytes(memUsage.rss),
      memoryHeap: formatBytes(memUsage.heapUsed),
      systemMemoryFree: formatBytes(freemem()),
      systemMemoryTotal: formatBytes(totalmem()),
    },
    configuration: {
      environment: config.environment,
      serverHost: config.server.host,
      httpPort: config.server.port,
      grpcPort: config.server.grpcPort,
      dynamicPort: config.server.dynamicPort,
      tlsEnabled: config.server.tls.enabled,
      adminUiEnabled: config.auth.adminUiEnabled,
    },
    storage: {
      dataDir,
      dataDirExists,
      isWritable,
      freeSpace,
    },
    database: {
      primaryDbExists,
      walMode,
    },
    crypto: {
      keysDir,
      hasPrivateKey,
      hasPublicKey,
    },
    network: {
      httpPortFree,
      grpcPortFree,
    },
  };
}

export async function commandStatus(args: {
  configPath?: string;
  json?: boolean;
}): Promise<number> {
  try {
    const status = await getSystemStatus(args.configPath);

    if (args.json) {
      console.log(JSON.stringify(status, null, 2));
      return 0;
    }

    console.log('================================================================');
    console.log(' DELTIX SYSTEM STATUS');
    console.log('================================================================');
    console.log('[RUNTIME]');
    console.log(
      `  Engine:           ${status.runtime.engine} v${status.runtime.version} (Node compat ${status.runtime.nodeVersion})`,
    );
    console.log(`  Platform:         ${status.runtime.os}`);
    console.log(`  CPU Cores:        ${status.runtime.cpuCores}`);
    console.log(`  Process PID:      ${status.runtime.pid}`);
    console.log(`  System Uptime:    ${status.runtime.uptime}`);
    console.log(
      `  Process Memory:   RSS ${status.runtime.memoryRss} | Heap ${status.runtime.memoryHeap}`,
    );
    console.log(
      `  System Memory:    Free ${status.runtime.systemMemoryFree} / Total ${status.runtime.systemMemoryTotal}`,
    );
    console.log('');
    console.log('[CONFIGURATION]');
    console.log(`  Environment:      ${status.configuration.environment}`);
    console.log(`  Server Host:      ${status.configuration.serverHost}`);
    console.log(
      `  HTTP Port:        ${status.configuration.httpPort} (Dynamic: ${status.configuration.dynamicPort ? 'enabled' : 'disabled'})`,
    );
    console.log(`  gRPC Port:        ${status.configuration.grpcPort}`);
    console.log(`  TLS Enabled:      ${status.configuration.tlsEnabled}`);
    console.log(
      `  Admin UI:         ${status.configuration.adminUiEnabled ? 'enabled' : 'disabled'}`,
    );
    console.log('');
    console.log('[STORAGE & FILESYSTEM]');
    console.log(`  Data Directory:   ${status.storage.dataDir}`);
    console.log(`  Exists:           ${status.storage.dataDirExists ? 'YES' : 'NO'}`);
    console.log(`  Writable:         ${status.storage.isWritable ? 'YES' : 'NO'}`);
    console.log(`  Free Disk Space:  ${status.storage.freeSpace}`);
    console.log('');
    console.log('[DATABASE & STATE]');
    console.log(
      `  Primary DB:       ${status.database.primaryDbExists ? 'INITIALIZED' : 'NOT INITIALIZED'}`,
    );
    console.log(`  WAL Mode:         ${status.database.walMode ? 'ACTIVE' : 'INACTIVE'}`);
    console.log('');
    console.log('[CRYPTOGRAPHIC KEYS]');
    console.log(`  Keypair Dir:      ${status.crypto.keysDir}`);
    console.log(`  Private Key:      ${status.crypto.hasPrivateKey ? 'PRESENT' : 'NOT FOUND'}`);
    console.log(`  Public Key:       ${status.crypto.hasPublicKey ? 'PRESENT' : 'NOT FOUND'}`);
    console.log('');
    console.log('[NETWORK PORTS]');
    console.log(
      `  HTTP Port ${status.configuration.httpPort}:    ${status.network.httpPortFree ? 'AVAILABLE' : 'IN USE'}`,
    );
    console.log(
      `  gRPC Port ${status.configuration.grpcPort}:   ${status.network.grpcPortFree ? 'AVAILABLE' : 'IN USE'}`,
    );
    console.log('================================================================');

    return 0;
  } catch (err) {
    reportError(err);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// 2. Config Export Subcommand
// ---------------------------------------------------------------------------

export interface ConfigExportOptions {
  configPath?: string;
  unredacted?: boolean;
  format?: 'json' | 'env';
  outputPath?: string;
}

function buildEnvExportLines(
  config: ReturnType<typeof loadConfig>,
  options: ConfigExportOptions,
): string[] {
  const lines: string[] = [
    '# Deltix Exported Configuration',
    `# Exported at: ${new Date().toISOString()}`,
    `# Unredacted: ${Boolean(options.unredacted)}`,
    '',
    `APP_ENV=${config.environment}`,
    `APP_HOST=${config.server.host}`,
    `APP_PORT=${config.server.port}`,
    `APP_GRPC_PORT=${config.server.grpcPort}`,
    `APP_DYNAMIC_PORT=${config.server.dynamicPort}`,
    `APP_DATA_DIR=${config.storage.dataDir}`,
    `APP_STAGING_PATH=${config.storage.stagingRootPath}`,
    `APP_REPOS_PATH=${config.storage.doltReposRootPath}`,
    `APP_NAS_PATH=${config.storage.nasSimPath}`,
    `APP_USER_DB_PATH=${config.database.userDbPath}`,
    `APP_REPO_DB_PATH=${config.database.repoDbPath}`,
    `APP_TICKET_DB_PATH=${config.database.ticketDbPath}`,
    `APP_TRANSFER_JOB_DB_PATH=${config.database.transferJobDbPath}`,
    `APP_ADDON_TRUST_DB_PATH=${config.database.addonTrustDbPath}`,
    `APP_SESSION_DB_PATH=${config.database.sessionDbPath}`,
    `APP_ADMIN_UI_ENABLED=${config.auth.adminUiEnabled}`,
    `APP_SESSION_TTL_SECONDS=${config.auth.sessionTtlSeconds}`,
    `APP_ACCESS_TOKEN_TTL_SECONDS=${config.auth.accessTokenTtlSeconds}`,
    `APP_LOG_LEVEL=${config.logging.level}`,
    `APP_LOG_PRETTY=${config.logging.pretty}`,
  ];

  if (config.auth.bootstrapAdminUsername) {
    lines.push(`APP_BOOTSTRAP_ADMIN_USERNAME=${config.auth.bootstrapAdminUsername}`);
    lines.push(
      `APP_BOOTSTRAP_ADMIN_PASSWORD=${options.unredacted ? (config.auth.bootstrapAdminPassword ?? '') : '[REDACTED]'}`,
    );
  }

  if (config.server.tls.enabled) {
    lines.push('APP_TLS_ENABLED=true');
    if (config.server.tls.certPath) lines.push(`APP_TLS_CERT_PATH=${config.server.tls.certPath}`);
    if (config.server.tls.keyPath) lines.push(`APP_TLS_KEY_PATH=${config.server.tls.keyPath}`);
  }

  return lines;
}

export function exportConfig(options: ConfigExportOptions = {}): string {
  const config = loadConfig({ configPath: options.configPath });
  const data = options.unredacted ? config : exportSanitizedConfig(config);

  if (options.format === 'env') {
    return buildEnvExportLines(config, options).join('\n');
  }

  return JSON.stringify(data, null, 2);
}

export function commandConfigExport(options: ConfigExportOptions): number {
  try {
    const output = exportConfig(options);
    if (options.outputPath) {
      writeFileSync(resolve(options.outputPath), output, 'utf-8');
      console.log(`Configuration exported successfully to: ${resolve(options.outputPath)}`);
    } else {
      console.log(output);
    }
    return 0;
  } catch (err) {
    reportError(err);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// 3. Doctor Subcommand
// ---------------------------------------------------------------------------

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface DoctorCheckResult {
  id: string;
  name: string;
  status: CheckStatus;
  message: string;
  note?: string;
  diagnostic?: DiagnosticReport;
}

export interface DoctorSuiteResult {
  total: number;
  passed: number;
  warnings: number;
  failed: number;
  checks: DoctorCheckResult[];
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: intentionally a flat, linear sequence of independent try/catch diagnostic checks (runtime, OS, disk, SQLite, crypto keys, network ports, ...); each check is already isolated in its own try/catch and shares no state with the others, so splitting further would add indirection without reducing risk.
/**
 * Returns true when the deltix systemd service is currently active (running).
 * The doctor uses this to distinguish a genuinely free port from one already
 * owned by the running Deltix service itself — in a healthy production box the
 * control-plane and gRPC ports are (correctly) occupied by deltix.service, so
 * "port in use" is expected, not a failure. Best-effort: any error (no
 * systemd, missing privileges, unsupported platform) resolves to false so the
 * check falls back to the strict "in use" report.
 */
function isDeltixServiceActive(): boolean {
  try {
    return (
      process.platform === 'linux' &&
      existsSync('/run/systemd/system') &&
      Bun.spawnSync(['systemctl', 'is-active', '--quiet', 'deltix.service']).exitCode === 0
    );
  } catch {
    return false;
  }
}

export async function runDoctorSuite(configPath?: string): Promise<DoctorSuiteResult> {
  const checks: DoctorCheckResult[] = [];
  const serviceActive = isDeltixServiceActive();

  // Check 1: Bun Runtime & Version
  try {
    const rawVersion = Bun.version;
    const [major = 0, minor = 0] = rawVersion.split('.').map(Number);
    if (major > 1 || (major === 1 && minor >= 3)) {
      checks.push({
        id: 'runtime-version',
        name: 'Bun Runtime Version',
        status: 'PASS',
        message: `Bun v${rawVersion} (supported >= 1.3.0, optimal 1.4.x)`,
      });
    } else {
      checks.push({
        id: 'runtime-version',
        name: 'Bun Runtime Version',
        status: 'FAIL',
        message: `Bun v${rawVersion} is outdated`,
        diagnostic: {
          title: `Unsupported Bun version: v${rawVersion}`,
          diagnosis:
            'Deltix requires Bun v1.3.0 or newer to ensure correct bun:sqlite and Web Crypto behavior.',
          action: 'Upgrade Bun to the latest version by running: bun upgrade',
          code: 'ERR_BUN_OUTDATED',
        },
      });
    }
  } catch (err) {
    checks.push({
      id: 'runtime-version',
      name: 'Bun Runtime Version',
      status: 'FAIL',
      message: 'Failed to inspect Bun runtime version',
      diagnostic: normalizeError(err),
    });
  }

  // Check 2: OS & Architecture
  const osArch = arch();
  const osPlat = platform();
  if (['x64', 'arm64'].includes(osArch) && ['linux', 'darwin', 'win32'].includes(osPlat)) {
    checks.push({
      id: 'os-arch',
      name: 'OS and Architecture Compatibility',
      status: 'PASS',
      message: `${osPlat} (${osArch}) is fully supported`,
    });
  } else {
    checks.push({
      id: 'os-arch',
      name: 'OS and Architecture Compatibility',
      status: 'WARN',
      message: `Running on non-standard platform ${osPlat} (${osArch})`,
      diagnostic: {
        title: `Non-standard platform: ${osPlat} ${osArch}`,
        diagnosis:
          'Deltix is primarily validated on Linux and macOS x64/arm64. Other platforms may work with caveats.',
        action: 'Ensure system libraries and SQLite binaries function as expected.',
      },
    });
  }

  // Load config for subsequent checks
  const config = loadConfig({ configPath });
  const dataDir = resolveDataDirectory(config.storage.dataDir);

  // Check 3: Data Directory & Permissions
  try {
    ensureDataDirectoryStructure(dataDir);
    const perm = checkDirectoryPermissions(dataDir);
    if (perm.readable && perm.writable) {
      checks.push({
        id: 'data-dir-permissions',
        name: 'Data Directory Access & Permissions',
        status: 'PASS',
        message: `Directory ${dataDir} is readable and writable`,
      });
    } else {
      checks.push({
        id: 'data-dir-permissions',
        name: 'Data Directory Access & Permissions',
        status: 'FAIL',
        message: `Insufficient permissions on ${dataDir}`,
        diagnostic: {
          title: `Insufficient permissions on data directory: ${dataDir}`,
          diagnosis:
            'The current user does not have full read and write access to the data directory.',
          action: `Run: chmod -R 750 "${dataDir}" && chown -R $(whoami) "${dataDir}"`,
          code: 'ERR_DATA_DIR_PERMISSIONS',
        },
      });
    }
  } catch (err) {
    checks.push({
      id: 'data-dir-permissions',
      name: 'Data Directory Access & Permissions',
      status: 'FAIL',
      message: `Permission probe failed on ${dataDir}`,
      diagnostic: normalizeError(err),
    });
  }

  // Check 4: Storage Space
  try {
    const fsStats = statfsSync(dataDir);
    const freeBytes = fsStats.bavail * fsStats.bsize;
    const minBytes = 500 * 1024 * 1024; // 500 MB
    if (freeBytes >= minBytes) {
      checks.push({
        id: 'disk-space',
        name: 'Available Storage Space',
        status: 'PASS',
        message: `${formatBytes(freeBytes)} free storage available`,
      });
    } else {
      checks.push({
        id: 'disk-space',
        name: 'Available Storage Space',
        status: 'WARN',
        message: `Low storage space: only ${formatBytes(freeBytes)} free`,
        diagnostic: {
          title: 'Low free disk space on data volume',
          diagnosis: `The volume backing ${dataDir} has less than 500MB free (${formatBytes(freeBytes)}). Database and staging operations may fail if disk fills up.`,
          action: 'Free up disk space on the host volume or mount a larger filesystem.',
          code: 'WARN_LOW_DISK_SPACE',
        },
      });
    }
  } catch {
    checks.push({
      id: 'disk-space',
      name: 'Available Storage Space',
      status: 'WARN',
      message: 'Could not query disk free space',
    });
  }

  // Check 5: Zero-Config SQLite Initialization & WAL Mode
  try {
    const dbDir = join(dataDir, 'db');
    const testDbPath = join(dbDir, 'deltix.db');
    const db = new Database(testDbPath, { create: true });
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('CREATE TABLE IF NOT EXISTS _schema_meta (key TEXT PRIMARY KEY, value TEXT);');
    const checkStmt = db.prepare('PRAGMA quick_check;');
    const checkRes = checkStmt.get() as { quick_check?: string } | undefined;
    db.close();

    if (checkRes?.quick_check === 'ok') {
      checks.push({
        id: 'sqlite-integrity',
        name: 'SQLite Engine & WAL Mode',
        status: 'PASS',
        message: 'bun:sqlite opened successfully with WAL mode and verified integrity',
      });
    } else {
      checks.push({
        id: 'sqlite-integrity',
        name: 'SQLite Engine & WAL Mode',
        status: 'FAIL',
        message: `Database integrity check failed: ${checkRes?.quick_check}`,
        diagnostic: {
          title: 'SQLite Database Integrity Verification Failed',
          diagnosis: `PRAGMA quick_check returned: ${checkRes?.quick_check}`,
          action: `Repair or re-initialize the database file at ${testDbPath}.`,
          code: 'ERR_SQLITE_CORRUPTION',
        },
      });
    }
  } catch (err) {
    checks.push({
      id: 'sqlite-integrity',
      name: 'SQLite Engine & WAL Mode',
      status: 'FAIL',
      message: 'Failed to initialize SQLite database with bun:sqlite',
      diagnostic: normalizeError(err),
    });
  }

  // Check 6: Cryptographic Keys
  try {
    const keysDir = join(dataDir, 'keys');
    const keypair = ensureCryptoKeypair(keysDir);
    if (keypair.privateKeyPem && keypair.publicKeyPem) {
      checks.push({
        id: 'crypto-keys',
        name: 'Persistent Cryptographic Keys',
        status: 'PASS',
        message: `Ed25519 keypair valid (${keypair.created ? 'newly generated' : 'loaded from disk'})`,
      });
    } else {
      throw new Error('Keypair generated invalid PEM output');
    }
  } catch (err) {
    checks.push({
      id: 'crypto-keys',
      name: 'Persistent Cryptographic Keys',
      status: 'FAIL',
      message: 'Failed to generate or load cryptographic keys',
      diagnostic: normalizeError(err),
    });
  }

  // Check 7: HTTP Port Availability
  try {
    const httpFree = await checkPortAvailable(config.server.port, config.server.host);
    if (httpFree) {
      checks.push({
        id: 'network-http-port',
        name: 'HTTP Port Availability',
        status: 'PASS',
        message: `Port ${config.server.port} is available on ${config.server.host}`,
      });
    } else if (config.server.dynamicPort) {
      checks.push({
        id: 'network-http-port',
        name: 'HTTP Port Availability',
        status: 'WARN',
        message: `Port ${config.server.port} is in use (dynamicPort is enabled)`,
      });
    } else if (serviceActive) {
      checks.push({
        id: 'network-http-port',
        name: 'HTTP Port Availability',
        status: 'PASS',
        message: `Port ${config.server.port} is held by the running deltix.service (expected)`,
        note: `deltix.service is active and listens on ${config.server.port} — this is the healthy production state, not a conflict.`,
      });
    } else {
      checks.push({
        id: 'network-http-port',
        name: 'HTTP Port Availability',
        status: 'FAIL',
        message: `Port ${config.server.port} is already occupied on ${config.server.host}`,
        diagnostic: {
          title: `HTTP Port ${config.server.port} is already in use`,
          diagnosis: `Cannot bind HTTP listener to port ${config.server.port}. Another process is listening.`,
          action: `Change the port via APP_PORT=<port>, enable APP_DYNAMIC_PORT=true, or stop the conflicting service.`,
          code: 'ERR_HTTP_PORT_IN_USE',
        },
      });
    }
  } catch (err) {
    checks.push({
      id: 'network-http-port',
      name: 'HTTP Port Availability',
      status: 'FAIL',
      message: 'Failed to probe HTTP port',
      diagnostic: normalizeError(err),
    });
  }

  // Check 8: gRPC Port Availability
  try {
    const grpcFree = await checkPortAvailable(config.server.grpcPort, config.server.host);
    if (grpcFree) {
      checks.push({
        id: 'network-grpc-port',
        name: 'gRPC Port Availability',
        status: 'PASS',
        message: `Port ${config.server.grpcPort} is available on ${config.server.host}`,
      });
    } else if (serviceActive) {
      checks.push({
        id: 'network-grpc-port',
        name: 'gRPC Port Availability',
        status: 'PASS',
        message: `Port ${config.server.grpcPort} is held by the running deltix.service (expected)`,
        note: `deltix.service is active and listens on ${config.server.grpcPort} — this is the healthy production state, not a conflict.`,
      });
    } else {
      checks.push({
        id: 'network-grpc-port',
        name: 'gRPC Port Availability',
        status: 'FAIL',
        message: `Port ${config.server.grpcPort} is already occupied on ${config.server.host}`,
        diagnostic: {
          title: `gRPC Port ${config.server.grpcPort} is already in use`,
          diagnosis: `Cannot bind gRPC listener to port ${config.server.grpcPort}. Another process is listening.`,
          action: `Change the port via APP_GRPC_PORT=<port> or stop the conflicting service.`,
          code: 'ERR_GRPC_PORT_IN_USE',
        },
      });
    }
  } catch (err) {
    checks.push({
      id: 'network-grpc-port',
      name: 'gRPC Port Availability',
      status: 'FAIL',
      message: 'Failed to probe gRPC port',
      diagnostic: normalizeError(err),
    });
  }

  // Check 9: Dolt Binary Detection
  try {
    const doltPath = Bun.which('dolt');
    if (doltPath) {
      checks.push({
        id: 'dolt-binary',
        name: 'External Dolt Binary in PATH',
        status: 'PASS',
        message: `Dolt binary discovered at ${doltPath}`,
      });
    } else {
      checks.push({
        id: 'dolt-binary',
        name: 'External Dolt Binary in PATH',
        status: 'WARN',
        message: 'Dolt binary not found in system PATH',
        diagnostic: {
          title: 'Dolt binary not detected in system PATH',
          diagnosis:
            'The version control engine requires the Dolt binary for database commits and branch operations.',
          action:
            'Install Dolt from https://github.com/dolthub/dolt/releases or add its location to the system PATH.',
          code: 'WARN_DOLT_NOT_FOUND',
        },
      });
    }
  } catch {
    checks.push({
      id: 'dolt-binary',
      name: 'External Dolt Binary in PATH',
      status: 'WARN',
      message: 'Could not probe for Dolt binary in PATH',
    });
  }

  // Check 10: TLS Configuration (if enabled)
  if (config.server.tls.enabled) {
    const certPath = config.server.tls.certPath;
    const keyPath = config.server.tls.keyPath;

    if (certPath && keyPath && existsSync(certPath) && existsSync(keyPath)) {
      checks.push({
        id: 'tls-certificates',
        name: 'TLS Certificate Configuration',
        status: 'PASS',
        message: `TLS enabled with valid cert (${certPath}) and key (${keyPath})`,
      });
    } else {
      checks.push({
        id: 'tls-certificates',
        name: 'TLS Certificate Configuration',
        status: 'FAIL',
        message: 'TLS is enabled but certificate or key file is missing',
        diagnostic: {
          title: 'Missing TLS Certificate or Key Files',
          diagnosis: `TLS is enabled, but certificate (${certPath}) or key (${keyPath}) could not be found on disk.`,
          action:
            'Provide valid PEM certificate paths or run scripts/generate-server-tls-cert.ts to generate a certificate.',
          code: 'ERR_TLS_FILES_MISSING',
        },
      });
    }
  }

  const passed = checks.filter((c) => c.status === 'PASS').length;
  const warnings = checks.filter((c) => c.status === 'WARN').length;
  const failed = checks.filter((c) => c.status === 'FAIL').length;

  return {
    total: checks.length,
    passed,
    warnings,
    failed,
    checks,
  };
}

export async function commandDoctor(args: {
  configPath?: string;
  json?: boolean;
}): Promise<number> {
  const result = await runDoctorSuite(args.configPath);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.failed === 0 ? 0 : 1;
  }

  console.log('================================================================');
  console.log(' DELTIX DOCTOR DIAGNOSTIC SUITE');
  console.log('================================================================');

  for (const check of result.checks) {
    const tag = check.status === 'PASS' ? '[PASS]' : check.status === 'WARN' ? '[WARN]' : '[FAIL]';

    console.log(`${tag.padEnd(8)} ${check.name}: ${check.message}`);

    if (check.note) {
      console.log(`         ${check.note}`);
    }

    if (check.diagnostic) {
      console.log('');
      console.log(formatDiagnostic(check.diagnostic, { colors: true }));
      console.log('');
    }
  }

  console.log('----------------------------------------------------------------');
  console.log(
    `Doctor Summary: ${result.passed} passed, ${result.warnings} warnings, ${result.failed} failures (Total: ${result.total})`,
  );
  console.log('================================================================');

  return result.failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// 4. CLI Runner
// ---------------------------------------------------------------------------

export function printHelp(): void {
  console.log(`
Deltix Management and Diagnostic CLI (Bun v1.4)

USAGE:
  deltix-server <command> [options]

COMMANDS:
  status               Display real-time system, runtime, database, and storage status.
  config export        Export current merged configuration (sanitized by default).
  doctor               Execute pre-flight diagnostic checks across system components.
  help, --help, -h     Show this help message.
  --version, -v        Display engine and CLI version.

OPTIONS:
  --config <path>      Specify custom path to config.json.
  --json               Output machine-readable JSON format.
  --unredacted         (config export) Include plaintext secrets in export.
  --format <json|env>  (config export) Export format (default: json).
  --output <file>      (config export) Write exported configuration to a file.

EXAMPLES:
  deltix-server status
  deltix-server doctor
  deltix-server config export --format env
  deltix-server config export --unredacted --output /etc/deltix/config.json
`);
}

interface ParsedCliFlags {
  jsonFlag: boolean;
  unredactedFlag: boolean;
  configPath: string | undefined;
  format: 'json' | 'env';
  outputPath: string | undefined;
}

function parseCliFlags(args: string[]): ParsedCliFlags {
  const jsonFlag = args.includes('--json');
  const unredactedFlag = args.includes('--unredacted');

  let configPath: string | undefined;
  const configIdx = args.indexOf('--config');
  if (configIdx !== -1 && args[configIdx + 1]) {
    configPath = args[configIdx + 1];
  }

  let format: 'json' | 'env' = 'json';
  const formatIdx = args.indexOf('--format');
  if (formatIdx !== -1 && args[formatIdx + 1]) {
    const rawFmt = args[formatIdx + 1]?.toLowerCase();
    if (rawFmt === 'env' || rawFmt === 'json') {
      format = rawFmt;
    }
  }

  let outputPath: string | undefined;
  const outputIdx = args.indexOf('--output');
  if (outputIdx !== -1 && args[outputIdx + 1]) {
    outputPath = args[outputIdx + 1];
  }

  return { jsonFlag, unredactedFlag, configPath, format, outputPath };
}

async function dispatchCliCommand(
  command: string,
  args: string[],
  flags: ParsedCliFlags,
): Promise<number> {
  const { jsonFlag, unredactedFlag, configPath, format, outputPath } = flags;

  switch (command) {
    case 'status':
      return await commandStatus({ configPath, json: jsonFlag });

    case 'config': {
      const sub = args[1]?.toLowerCase();
      if (sub === 'export' || !sub) {
        return commandConfigExport({
          configPath,
          unredacted: unredactedFlag,
          format,
          outputPath,
        });
      }
      console.error(`[ERROR] Unknown config subcommand: '${sub}'. Available: 'export'`);
      return 1;
    }

    case 'doctor':
      return await commandDoctor({ configPath, json: jsonFlag });

    default:
      console.error(`[ERROR] Unknown command: '${command}'. Run 'deltix-server --help' for usage.`);
      return 1;
  }
}

// ---------------------------------------------------------------------------
// Env file loading (production parity)
// ---------------------------------------------------------------------------

const DEFAULT_PROD_ENV_FILE = '/etc/deltix/deltix.env';

/**
 * Loads the production environment file the same way systemd does
 * (EnvironmentFile=/etc/deltix/deltix.env). When the CLI is run manually on a
 * production box — `bun run src/cli/commands.ts doctor` — merging this file
 * into Bun.env makes every command (status, doctor, config export) reason
 * about the REAL data/config paths the running service uses, instead of the
 * source-tree defaults (`./data/...`). Harmless no-op in dev/CI where the file
 * does not exist; never overwrites variables already set in the calling
 * environment.
 */
function loadProductionEnvFileInto(env: Record<string, string | undefined>): void {
  const envFilePath = env.DELTIX_ENV_FILE ?? DEFAULT_PROD_ENV_FILE;
  if (!existsSync(envFilePath)) return;
  try {
    const text = readFileSync(envFilePath, 'utf-8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const rawValue = trimmed.slice(eq + 1).trim();
      if (!key || key in env) continue;
      const value = rawValue.replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1');
      env[key] = value;
    }
  } catch {
    // Best-effort: diagnostics must still run when the env file is unreadable.
  }
}

export async function runCli(argv: string[]): Promise<number> {
  loadProductionEnvFileInto(Bun.env as Record<string, string | undefined>);

  const args = argv.slice(2);
  const command = args[0]?.toLowerCase();

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(`deltix-server v${packageJson.version} (Bun ${Bun.version})`);
    return 0;
  }

  const flags = parseCliFlags(args);
  return dispatchCliCommand(command, args, flags);
}

// Required so `bun run src/cli/commands.ts <command>` (or a compiled standalone
// binary) actually executes the CLI; without this guard the module only defines
// functions and exits silently with code 0.
if (import.meta.main) {
  const exitCode = await runCli(process.argv);
  process.exit(exitCode);
}
