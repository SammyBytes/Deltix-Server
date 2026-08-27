/**
 * Fase 5.1 types: mapping between a logical `repoId` (what the client and
 * API refer to, e.g. "demo-repo") and the real, isolated Dolt repository
 * provisioned for it on disk. Before Fase 5, `repoId` was just a folder
 * name inside the NAS-sim staging area (see `contexts/storage`) with no
 * real Dolt repository behind it — this is the record that changes that.
 */
export interface RepoRecord {
  repoId: string;
  doltPath: string;
  createdAt: number;
  createdBy: string;
}

export interface RepoSyncPreferenceSummary {
  mode: 'schema_only' | 'schema_and_data';
  requestedTables: string[] | null;
  createdAt: number;
  updatedAt: number;
}

export interface BranchSummary {
  name: string;
  isCurrent: boolean;
}

export interface LogCommitEntry {
  commitHash: string;
  author: string;
  authorEmail: string;
  timestamp: string;
  message: string;
  parents: string[];
}

export interface DiffRowChange {
  diffType: 'added' | 'removed' | 'modified';
  oldValues: Record<string, string | null>;
  newValues: Record<string, string | null>;
}

export interface DiffTableSummary {
  table: string;
  diffType: string;
  dataChange: boolean;
  schemaChange: boolean;
  changes: DiffRowChange[];
}

export interface DiffResult {
  fromRef: string;
  toRef: string;
  tables: DiffTableSummary[];
}

export interface MergeConflictRow {
  fromRootIsh: string | null;
  base: Record<string, string | null>;
  ours: Record<string, string | null>;
  theirs: Record<string, string | null>;
  ourDiffType: string | null;
  theirDiffType: string | null;
  conflictId: string | null;
}

export interface MergeConflictTable {
  table: string;
  count: number;
  conflicts: MergeConflictRow[];
}

export type MergeResult =
  | {
      status: 'merged';
      targetBranch: string;
      sourceBranch: string;
      commitHash: string;
      fastForward: boolean;
      message: string;
    }
  | {
      status: 'up_to_date';
      targetBranch: string;
      sourceBranch: string;
      message: string;
    };
