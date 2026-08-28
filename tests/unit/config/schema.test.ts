import { describe, expect, it } from 'bun:test';
import {
  __resetConfigCacheForTests,
  DEFAULT_CONFIG,
  deepMerge,
  exportSanitizedConfig,
  extractEnvConfig,
  loadConfig,
} from '../../../src/config/schema';
import { isDiagnosticError } from '../../../src/shared/error-reporter';

describe('config schema & hierarchical loading', () => {
  it('loads default configuration when no overrides or env vars are present', () => {
    __resetConfigCacheForTests();
    const config = loadConfig({ env: {}, configPath: '/non/existent/config.json' });

    expect(config.environment).toBe('development');
    expect(config.server.host).toBe('0.0.0.0');
    expect(config.server.port).toBe(9090);
    expect(config.server.grpcPort).toBe(50051);
    expect(config.server.dynamicPort).toBe(false);
    expect(config.storage.dataDir).toBe('./data');
    expect(config.auth.adminUiEnabled).toBe(false);
  });

  it('correctly deep merges objects', () => {
    const target = { a: 1, nested: { b: 2, c: 3 } };
    const source = { nested: { c: 99, d: 4 }, e: 5 };
    const result = deepMerge(target, source);

    expect(result).toEqual({
      a: 1,
      nested: { b: 2, c: 99, d: 4 },
      e: 5,
    });
  });

  it('extracts APP_* environment variables', () => {
    const envVars = {
      APP_ENV: 'production',
      APP_PORT: '8080',
      APP_GRPC_PORT: '50055',
      APP_DYNAMIC_PORT: 'true',
      APP_DATA_DIR: '/var/lib/deltix',
      APP_ADMIN_UI_ENABLED: 'true',
      APP_LOG_LEVEL: 'debug',
      APP_LOG_PRETTY: 'true',
      APP_BOOTSTRAP_ADMIN_USERNAME: 'admin',
      APP_BOOTSTRAP_ADMIN_PASSWORD: 'secretpassword123',
    };

    const extracted = extractEnvConfig(envVars);
    expect(extracted.environment).toBe('production');
    expect((extracted.server as Record<string, unknown>).port).toBe('8080');
    expect((extracted.server as Record<string, unknown>).grpcPort).toBe('50055');
    expect((extracted.server as Record<string, unknown>).dynamicPort).toBe('true');
    expect((extracted.storage as Record<string, unknown>).dataDir).toBe('/var/lib/deltix');
    expect((extracted.auth as Record<string, unknown>).adminUiEnabled).toBe('true');
    expect((extracted.auth as Record<string, unknown>).bootstrapAdminUsername).toBe('admin');
  });

  it('hierarchically overrides defaults with env vars and programmatic overrides', () => {
    __resetConfigCacheForTests();
    const config = loadConfig({
      env: {
        APP_PORT: '9191',
        APP_ADMIN_UI_ENABLED: 'true',
      },
      overrides: {
        server: {
          host: '127.0.0.1',
          port: 9292,
        },
      },
    });

    expect(config.server.port).toBe(9292); // Programmatic override wins over env
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.auth.adminUiEnabled).toBe(true); // Env var wins over default
    expect(config.server.grpcPort).toBe(50051); // Default intact
  });

  it('redacts sensitive fields in exportSanitizedConfig', () => {
    const rawConfig = {
      ...DEFAULT_CONFIG,
      auth: {
        ...DEFAULT_CONFIG.auth,
        bootstrapAdminUsername: 'admin',
        bootstrapAdminPassword: 'SuperSecretPassword!',
        jwtPrivateKey: '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgk...',
      },
    };

    const sanitized = exportSanitizedConfig(rawConfig);
    const auth = sanitized.auth as Record<string, unknown>;

    expect(auth.bootstrapAdminUsername).toBe('admin');
    expect(auth.bootstrapAdminPassword).toBe('[REDACTED]');
    expect(auth.jwtPrivateKey).toBe('[REDACTED]');
  });

  it('throws DiagnosticError on invalid schema validation', () => {
    __resetConfigCacheForTests();
    try {
      loadConfig({
        env: {
          APP_PORT: 'invalid_port_string',
        },
      });
      expect(true).toBe(false); // Should not reach here
    } catch (err) {
      expect(isDiagnosticError(err)).toBe(true);
      if (isDiagnosticError(err)) {
        expect(err.code).toBe('ERR_CONFIG_VALIDATION_FAILED');
        expect(err.diagnosis).toContain('server.port');
      }
    }
  });

  it('throws DiagnosticError when bootstrap username is provided without password', () => {
    __resetConfigCacheForTests();
    try {
      loadConfig({
        env: {
          APP_BOOTSTRAP_ADMIN_USERNAME: 'admin_only',
        },
      });
      expect(true).toBe(false);
    } catch (err) {
      expect(isDiagnosticError(err)).toBe(true);
      if (isDiagnosticError(err)) {
        expect(err.code).toBe('ERR_CONFIG_VALIDATION_FAILED');
      }
    }
  });
});
