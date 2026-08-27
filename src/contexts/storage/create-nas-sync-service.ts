/**
 * Factory that wires the storage context together from validated env
 * vars. Boot-time composition root — nothing else should construct
 * `LibsqlTransferJobStore`/`LocalFsNasAdapter`/`NasSyncService` directly.
 */
import type { Env } from '../../shared/env';
import { LibsqlTransferJobStore } from './libsql-transfer-job-store';
import { LocalFsNasAdapter } from './local-fs-nas-adapter';
import { NasSyncService } from './nas-sync.service';

export async function createNasSyncService(env: Env): Promise<NasSyncService> {
  const store = new LibsqlTransferJobStore(env.DELTIX_TRANSFER_JOB_DB_PATH);
  await store.init();
  const nas = new LocalFsNasAdapter(env.DELTIX_NAS_SIM_PATH);
  return new NasSyncService(store, nas, {
    backoffBaseMs: env.DELTIX_NAS_SYNC_BACKOFF_BASE_MS,
    backoffMaxMs: env.DELTIX_NAS_SYNC_BACKOFF_MAX_MS,
  });
}
