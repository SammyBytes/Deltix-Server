/**
 * Factory that wires the gRPC Transfer Engine together from validated env
 * vars. Boot-time composition root — nothing else should construct
 * `LibsqlTransferJobStore`/`createGrpcTransferServer` directly (same
 * discipline as `createNasSyncService`).
 *
 * Deliberately reuses the SAME `LibsqlTransferJobStore` file
 * (`DELTIX_TRANSFER_JOB_DB_PATH`) as the NAS sync worker: Push writes
 * 'staged' rows here, and the NAS sync worker (separate process loop,
 * same DB file) picks them up and promotes them through the pipeline.
 */

import type { Env } from '../../shared/env';
import type { TicketService } from '../transfer';
import {
  bindGrpcTransferServer,
  createGrpcTransferServer,
  type GrpcTlsConfig,
} from './grpc-transfer-server';
import { LibsqlTransferJobStore } from './libsql-transfer-job-store';
import type { OnPushCommitted } from './push-session-handler';

export interface GrpcTransferEngine {
  server: import('@grpc/grpc-js').Server;
  port: number;
}

/** Builds, binds, and starts the gRPC transfer server. Returns the bound port. */
export async function startGrpcTransferEngine(
  env: Env,
  ticketService: TicketService,
  onPushCommitted?: OnPushCommitted,
): Promise<GrpcTransferEngine> {
  const jobStore = new LibsqlTransferJobStore(env.DELTIX_TRANSFER_JOB_DB_PATH);
  await jobStore.init();

  const tls: GrpcTlsConfig = {
    certPath: env.DELTIX_GRPC_TLS_CERT_PATH,
    keyPath: env.DELTIX_GRPC_TLS_KEY_PATH,
  };

  const server = createGrpcTransferServer({
    ticketService,
    jobStore,
    stagingRootPath: env.DELTIX_STAGING_ROOT_PATH,
    nasRootPath: env.DELTIX_NAS_SIM_PATH,
    maxRetries: env.DELTIX_TRANSFER_JOB_MAX_RETRIES,
    tls,
    ...(onPushCommitted ? { onPushCommitted } : {}),
  });

  const port = await bindGrpcTransferServer(server, env.DELTIX_GRPC_PORT, tls);
  server.start();

  return { server, port };
}
