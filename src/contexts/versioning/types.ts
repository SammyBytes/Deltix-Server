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
