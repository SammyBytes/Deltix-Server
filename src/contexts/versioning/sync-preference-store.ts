import type { RepoSyncPreferenceRecord } from './sync-preference-types';

export interface SyncPreferenceStore {
  init(): Promise<void>;
  get(repoId: string): Promise<RepoSyncPreferenceRecord | null>;
  upsert(record: RepoSyncPreferenceRecord): Promise<void>;
}
