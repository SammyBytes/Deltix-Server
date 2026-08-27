/**
 * Persists the repoId <-> Dolt-path mapping. Interface kept separate from
 * the libSQL implementation so tests can substitute an in-memory fake —
 * same convention as `AddonTrustStore` / `TransferJobStore`.
 */
import type { RepoRecord } from './types';

export interface RepoStore {
  init(): Promise<void>;
  create(record: RepoRecord): Promise<void>;
  get(repoId: string): Promise<RepoRecord | null>;
  list(): Promise<RepoRecord[]>;
}
