/**
 * Fase 5.1: provisions a real, isolated Dolt repository per logical
 * `repoId` and persists the repoId <-> Dolt-path mapping via `RepoStore`.
 *
 * `runDoltInit` is injected (defaults to the real `dolt init` CLI
 * invocation via `Bun.$`, see `create-repo-provisioning-service.ts`) so
 * this service is fully unit-testable without a real Dolt binary — mirrors
 * the same DI convention as `NasSyncService`'s injectable `now`.
 */
import { join } from 'node:path';
import {
  InvalidRepoIdError,
  RepoAlreadyProvisionedError,
  RepoProvisioningFailedError,
} from './errors';
import type { RepoStore } from './repo-store';
import type { RepoRecord } from './types';

// Deliberately conservative: letters, digits, dash, underscore only. A
// repoId becomes a literal path segment under `doltReposRootPath` — this
// allow-list is what prevents path traversal (`../`) or shell-unsafe
// characters from ever reaching the filesystem or the Dolt CLI (OWASP A03).
const VALID_REPO_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export type RunDoltInit = (doltPath: string) => Promise<void>;

export class RepoProvisioningService {
  constructor(
    private readonly store: RepoStore,
    private readonly runDoltInit: RunDoltInit,
    private readonly doltReposRootPath: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async provision(repoId: string, createdBy: string): Promise<RepoRecord> {
    if (!VALID_REPO_ID.test(repoId)) {
      throw new InvalidRepoIdError(
        `Invalid repoId "${repoId}": must be 1-64 characters, letters/digits/dash/underscore only`,
      );
    }

    const existing = await this.store.get(repoId);
    if (existing) {
      throw new RepoAlreadyProvisionedError(`repoId "${repoId}" is already provisioned`);
    }

    const doltPath = join(this.doltReposRootPath, repoId);

    try {
      await this.runDoltInit(doltPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new RepoProvisioningFailedError(
        `Failed to provision Dolt repo for "${repoId}": ${message}`,
      );
    }

    const record: RepoRecord = { repoId, doltPath, createdAt: this.now(), createdBy };
    await this.store.create(record);
    return record;
  }

  async get(repoId: string): Promise<RepoRecord | null> {
    return this.store.get(repoId);
  }

  async list(): Promise<RepoRecord[]> {
    return this.store.list();
  }
}
