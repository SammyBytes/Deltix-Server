import { InvalidRepoIdError, RepoNotFoundError, SyncPreferenceConflictError } from './errors';
import type { RepoStore } from './repo-store';
import type {
  ForeignKeyEdge,
  PushSyncOptions,
  PushSyncValidationResult,
  RepoSyncPreferenceRecord,
  SyncMode,
  SyncPlan,
  SyncPlanRequest,
} from './sync-preference-types';

const VALID_REPO_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const VALID_TABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function invalidTableError(table: string): InvalidRepoIdError {
  return new InvalidRepoIdError(
    `Invalid table name "${table}": must start with a letter/underscore and contain only letters, digits, or underscores`,
  );
}

function normalizeTables(tables: string[] | null): string[] | null {
  if (!tables || tables.length === 0) {
    return null;
  }
  const normalized = tables.map((table) => table.trim()).filter((table) => table.length > 0);
  if (normalized.length === 0) {
    return null;
  }
  for (const table of normalized) {
    if (!VALID_TABLE.test(table)) {
      throw invalidTableError(table);
    }
  }
  return uniqueSorted(normalized);
}

function computeClosure(requestedTables: string[], edges: ForeignKeyEdge[]): string[] {
  const byTable = new Map<string, string[]>();
  for (const edge of edges) {
    const list = byTable.get(edge.tableName) ?? [];
    list.push(edge.referencedTableName);
    byTable.set(edge.tableName, uniqueSorted(list));
  }
  const resolved = new Set(requestedTables);
  const queue = [...requestedTables];
  while (queue.length > 0) {
    const table = queue.shift();
    if (!table) {
      continue;
    }
    for (const dependency of byTable.get(table) ?? []) {
      if (!resolved.has(dependency)) {
        resolved.add(dependency);
        queue.push(dependency);
      }
    }
  }
  return [...resolved].sort();
}

export class SyncPreferenceService {
  constructor(
    private readonly repoStore: RepoStore,
    private readonly readForeignKeyEdges: (doltPath: string) => Promise<ForeignKeyEdge[]>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async get(repoId: string): Promise<RepoSyncPreferenceRecord | null> {
    this.assertRepoId(repoId);
    const stored = await this.repoStore.getSyncPreference(repoId);
    if (!stored) {
      return null;
    }
    return {
      repoId,
      mode: stored.mode,
      requestedTables: stored.requestedTables,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    };
  }

  async upsert(repoId: string, request: SyncPlanRequest): Promise<RepoSyncPreferenceRecord> {
    const repo = await this.requireRepo(repoId);
    const normalizedTables = normalizeTables(request.tables);
    const edges = normalizedTables ? await this.readForeignKeyEdges(repo.doltPath) : [];
    const plan = this.buildPlan(request.mode, normalizedTables, edges);
    this.assertNoExcludedDependencies(plan);
    const timestamp = this.now();
    const record: RepoSyncPreferenceRecord = {
      repoId,
      mode: plan.mode,
      requestedTables: plan.requestedTables,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.repoStore.upsertSyncPreference({
      repoId,
      mode: record.mode,
      requestedTables: record.requestedTables,
      createdAt: timestamp,
      updatedAt: record.updatedAt,
    });
    return record;
  }

  async preview(repoId: string, request: SyncPlanRequest): Promise<SyncPlan> {
    const repo = await this.requireRepo(repoId);
    const normalizedTables = normalizeTables(request.tables);
    const edges = normalizedTables ? await this.readForeignKeyEdges(repo.doltPath) : [];
    const plan = this.buildPlan(request.mode, normalizedTables, edges);
    return plan;
  }

  async validatePushOptions(
    repoId: string,
    overrides?: Partial<PushSyncOptions>,
  ): Promise<PushSyncValidationResult> {
    const repo = await this.requireRepo(repoId);
    const stored = await this.repoStore.getSyncPreference(repoId);
    const mode: SyncMode = overrides?.mode ?? stored?.mode ?? 'schema_and_data';
    const requestedTables = normalizeTables(
      overrides?.tables === undefined
        ? (stored?.requestedTables ?? null)
        : (overrides.tables ?? null),
    );
    const dryRun = overrides?.dryRun ?? false;
    const edges = requestedTables ? await this.readForeignKeyEdges(repo.doltPath) : [];
    const plan = this.buildPlan(mode, requestedTables, edges);
    this.assertNoExcludedDependencies(plan);
    return {
      repoId,
      mode: plan.mode,
      requestedTables: plan.requestedTables,
      resolvedTables: plan.resolvedTables,
      autoIncludedTables: plan.autoIncludedTables,
      dryRun,
    };
  }

  private buildPlan(
    mode: SyncMode,
    requestedTables: string[] | null,
    edges: ForeignKeyEdge[],
  ): SyncPlan {
    if (!requestedTables) {
      return { mode, requestedTables: null, resolvedTables: null, autoIncludedTables: [] };
    }
    const resolvedTables = computeClosure(requestedTables, edges);
    return {
      mode,
      requestedTables,
      resolvedTables,
      autoIncludedTables: resolvedTables.filter((table) => !requestedTables.includes(table)),
    };
  }

  private assertNoExcludedDependencies(plan: SyncPlan): void {
    if (plan.autoIncludedTables.length > 0 && plan.requestedTables) {
      throw new SyncPreferenceConflictError(
        `Requested tables require additional FK dependencies: ${plan.autoIncludedTables.join(', ')}. Re-run with the full closure or use dry-run preview first.`,
      );
    }
  }

  private assertRepoId(repoId: string): void {
    if (!VALID_REPO_ID.test(repoId)) {
      throw new InvalidRepoIdError(
        `Invalid repoId "${repoId}": must be 1-64 characters, letters/digits/dash/underscore only`,
      );
    }
  }

  private async requireRepo(repoId: string) {
    this.assertRepoId(repoId);
    const repo = await this.repoStore.get(repoId);
    if (!repo) {
      throw new RepoNotFoundError(`Repo not found: ${repoId}`);
    }
    return repo;
  }
}
