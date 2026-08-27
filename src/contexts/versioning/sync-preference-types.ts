export type SyncMode = 'schema_only' | 'schema_and_data';

export interface RepoSyncPreferenceRecord {
  repoId: string;
  mode: SyncMode;
  requestedTables: string[] | null;
  createdAt: number;
  updatedAt: number;
}

export interface ForeignKeyEdge {
  tableName: string;
  referencedTableName: string;
  constraintName: string;
}

export interface SyncPlanRequest {
  mode: SyncMode;
  tables: string[] | null;
}

export interface SyncPlan {
  mode: SyncMode;
  requestedTables: string[] | null;
  resolvedTables: string[] | null;
  autoIncludedTables: string[];
}

export interface PushSyncOptions {
  mode: SyncMode;
  tables: string[] | null;
  dryRun: boolean;
}

export interface PushSyncValidationResult {
  repoId: string;
  mode: SyncMode;
  requestedTables: string[] | null;
  resolvedTables: string[] | null;
  autoIncludedTables: string[];
  dryRun: boolean;
}
