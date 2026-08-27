import { describe, expect, it } from 'bun:test';
import {
  InvalidRepoIdError,
  RepoNotFoundError,
  SyncPreferenceConflictError,
} from '../../../src/contexts/versioning/errors';
import type { RepoStore } from '../../../src/contexts/versioning/repo-store';
import { SyncPreferenceService } from '../../../src/contexts/versioning/sync-preference.service';
import type { RepoRecord, RepoSyncPreferenceSummary } from '../../../src/contexts/versioning/types';

function createRepoStore(): RepoStore {
  const repos = new Map<string, RepoRecord>();
  const prefs = new Map<string, RepoSyncPreferenceSummary>();
  return {
    init: async () => {},
    create: async (record) => {
      repos.set(record.repoId, record);
    },
    get: async (repoId) => repos.get(repoId) ?? null,
    list: async () => [...repos.values()],
    getSyncPreference: async (repoId) => prefs.get(repoId) ?? null,
    upsertSyncPreference: async (params) => {
      prefs.set(params.repoId, { mode: params.mode, requestedTables: params.requestedTables });
    },
  };
}

describe('versioning/SyncPreferenceService', () => {
  it('returns the requested subset untouched when no FK expansion is needed', async () => {
    const store = createRepoStore();
    await store.create({
      repoId: 'demo',
      doltPath: '/repos/demo',
      createdAt: 1,
      createdBy: 'seed',
    });
    const service = new SyncPreferenceService(store, async () => []);

    const plan = await service.preview('demo', { mode: 'schema_and_data', tables: ['orders'] });

    expect(plan.requestedTables).toEqual(['orders']);
    expect(plan.resolvedTables).toEqual(['orders']);
    expect(plan.autoIncludedTables).toEqual([]);
  });

  it('fails closed when a selected subset excludes FK-required tables', async () => {
    const store = createRepoStore();
    await store.create({
      repoId: 'demo',
      doltPath: '/repos/demo',
      createdAt: 1,
      createdBy: 'seed',
    });
    const service = new SyncPreferenceService(store, async () => [
      {
        tableName: 'orders',
        referencedTableName: 'customers',
        constraintName: 'fk_orders_customers',
      },
      {
        tableName: 'customers',
        referencedTableName: 'regions',
        constraintName: 'fk_customers_regions',
      },
    ]);

    await expect(
      service.preview('demo', { mode: 'schema_and_data', tables: ['orders'] }),
    ).rejects.toBeInstanceOf(SyncPreferenceConflictError);
  });

  it('stores only an already-closed subset and re-validates it server-side on push', async () => {
    const store = createRepoStore();
    await store.create({
      repoId: 'demo',
      doltPath: '/repos/demo',
      createdAt: 1,
      createdBy: 'seed',
    });
    const service = new SyncPreferenceService(
      store,
      async () => [
        {
          tableName: 'orders',
          referencedTableName: 'customers',
          constraintName: 'fk_orders_customers',
        },
      ],
      () => 1234,
    );

    await service.upsert('demo', { mode: 'schema_only', tables: ['customers', 'orders'] });
    const saved = await store.getSyncPreference('demo');
    const validated = await service.validatePushOptions('demo');

    expect(saved).toEqual({ mode: 'schema_only', requestedTables: ['customers', 'orders'] });
    expect(validated.resolvedTables).toEqual(['customers', 'orders']);
    expect(validated.mode).toBe('schema_only');
  });

  it('applies request-time overrides instead of stored preferences, then revalidates closure', async () => {
    const store = createRepoStore();
    await store.create({
      repoId: 'demo',
      doltPath: '/repos/demo',
      createdAt: 1,
      createdBy: 'seed',
    });
    await store.upsertSyncPreference({
      repoId: 'demo',
      mode: 'schema_and_data',
      requestedTables: ['customers'],
      createdAt: 1,
      updatedAt: 1,
    });
    const service = new SyncPreferenceService(store, async () => [
      {
        tableName: 'orders',
        referencedTableName: 'customers',
        constraintName: 'fk_orders_customers',
      },
    ]);

    const validated = await service.validatePushOptions('demo', {
      mode: 'schema_only',
      tables: ['customers', 'orders'],
      dryRun: true,
    });

    expect(validated.mode).toBe('schema_only');
    expect(validated.requestedTables).toEqual(['customers', 'orders']);
    expect(validated.resolvedTables).toEqual(['customers', 'orders']);
    expect(validated.autoIncludedTables).toEqual([]);
    expect(validated.dryRun).toBe(true);
  });

  it('treats null/empty table selection as all tables with no FK expansion needed', async () => {
    const store = createRepoStore();
    await store.create({
      repoId: 'demo',
      doltPath: '/repos/demo',
      createdAt: 1,
      createdBy: 'seed',
    });
    const service = new SyncPreferenceService(store, async () => {
      throw new Error('should not read fks for full-repo sync');
    });

    const validated = await service.validatePushOptions('demo', { tables: [] });

    expect(validated.requestedTables).toBeNull();
    expect(validated.resolvedTables).toBeNull();
    expect(validated.autoIncludedTables).toEqual([]);
  });

  it('rejects invalid repo ids and invalid table names', async () => {
    const store = createRepoStore();
    const service = new SyncPreferenceService(store, async () => []);

    await expect(
      service.preview('../escape', { mode: 'schema_only', tables: null }),
    ).rejects.toBeInstanceOf(InvalidRepoIdError);
    await store.create({
      repoId: 'demo',
      doltPath: '/repos/demo',
      createdAt: 1,
      createdBy: 'seed',
    });
    await expect(
      service.preview('demo', { mode: 'schema_only', tables: ['orders;drop'] }),
    ).rejects.toBeInstanceOf(InvalidRepoIdError);
  });

  it('rejects requests for repos that are not provisioned', async () => {
    const store = createRepoStore();
    const service = new SyncPreferenceService(store, async () => []);

    await expect(service.validatePushOptions('missing')).rejects.toBeInstanceOf(RepoNotFoundError);
  });
});
