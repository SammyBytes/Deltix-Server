import { describe, expect, it } from 'bun:test';
import {
  commandConfigExport,
  commandDoctor,
  commandStatus,
  exportConfig,
  getSystemStatus,
  runCli,
  runDoctorSuite,
} from '../../../src/cli/commands';

describe('cli commands & diagnostics', () => {
  it('collects comprehensive system status', async () => {
    const status = await getSystemStatus();

    expect(status.runtime.engine).toBe('Bun');
    expect(status.runtime.version).toBe(Bun.version);
    expect(status.configuration.serverHost).toBeDefined();
    expect(status.storage.dataDir).toBeDefined();
    expect(typeof status.network.httpPortFree).toBe('boolean');
  });

  it('runs status command without throwing', async () => {
    const exitCode = await commandStatus({ json: true });
    expect(exitCode).toBe(0);
  });

  it('exports configuration in json and env formats', () => {
    const jsonOutput = exportConfig({ format: 'json' });
    const parsed = JSON.parse(jsonOutput);
    expect(parsed.server.port).toBeDefined();

    const envOutput = exportConfig({ format: 'env' });
    expect(envOutput).toContain('APP_PORT=');
    expect(envOutput).toContain('APP_ENV=');

    const exitCode = commandConfigExport({ format: 'json' });
    expect(exitCode).toBe(0);
  });

  it('runs doctor suite and returns structured results', async () => {
    const suite = await runDoctorSuite();

    expect(suite.total).toBeGreaterThan(0);
    expect(suite.checks.length).toBe(suite.total);
    const bunCheck = suite.checks.find((c) => c.id === 'runtime-version');
    expect(bunCheck).toBeDefined();
    expect(bunCheck?.status).toBe('PASS');
  });

  it('runs doctor command returning exit code', async () => {
    const exitCode = await commandDoctor({ json: true });
    expect([0, 1]).toContain(exitCode);
  });

  it('runs CLI runner with help and version', async () => {
    const helpExit = await runCli(['bun', 'deltix', '--help']);
    expect(helpExit).toBe(0);

    const versionExit = await runCli(['bun', 'deltix', '--version']);
    expect(versionExit).toBe(0);
  });
});
