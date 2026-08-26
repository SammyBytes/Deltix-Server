/**
 * Public API of the "storage" bounded context (Fase 3 continued: SSD
 * staging -> NAS sync pipeline). This is the ONLY module other
 * contexts/modules are allowed to import from — see
 * .github/copilot-instructions.md for the ACL boundary rule.
 */

export type { GrpcTransferEngine } from './create-grpc-transfer-server';
export { startGrpcTransferEngine } from './create-grpc-transfer-server';
export { createNasSyncService } from './create-nas-sync-service';
export {
  ChecksumMismatchError,
  TransferJobInvalidTransitionError,
  TransferJobNotFoundError,
} from './errors';
export type { GrpcTlsConfig, GrpcTransferServerOptions } from './grpc-transfer-server';
export {
  bindGrpcTransferServer,
  createGrpcTransferServer,
} from './grpc-transfer-server';
export { NasSyncService } from './nas-sync.service';
export { NasSyncWorker } from './nas-sync.worker';
export { createStorageRouter } from './storage.router';
export type { TransferJob, TransferJobStatus } from './types';
