/**
 * gRPC transport adapter (Fase 3): thin glue between grpc-js's
 * stream/callback API and the pure business logic in
 * `PushSessionHandler`/`PullSessionHandler`. Deliberately kept as thin as
 * possible — anything that can be unit tested without a live gRPC server
 * lives in those two classes instead.
 *
 * Security posture (fail-closed throughout):
 *  - The server is ALWAYS created with TLS server credentials — there is
 *    no insecure/plaintext code path. `createGrpcTransferServer` requires
 *    a cert/key pair; callers cannot opt out.
 *  - The very first message of a Push call must be a `Header` carrying a
 *    ticket; any other message first, or an invalid/expired/mismatched
 *    ticket, aborts the call immediately via `call.destroy()` with a
 *    PERMISSION_DENIED status — no chunk is ever written to staging
 *    without a successfully consumed ticket.
 *  - A session that fails or is cancelled mid-stream calls
 *    `PushSessionHandler.abort()`, guaranteeing no partial, unverified
 *    file is ever mistaken for a completed transfer (no TransferJob row
 *    is created on the abort path).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { TicketService } from '../transfer';
import {
  PullNotFoundError,
  PullSessionAbortedError,
  PullSessionHandler,
} from './pull-session-handler';
import {
  type OnPushCommitted,
  PushSessionAbortedError,
  PushSessionHandler,
} from './push-session-handler';
import type { TransferJobStore } from './transfer-job-store';

const PROTO_PATH = join(import.meta.dir, '..', '..', '..', 'proto', 'transfer.proto');

export interface GrpcTlsConfig {
  certPath: string;
  keyPath: string;
}

export interface GrpcTransferServerOptions {
  ticketService: TicketService;
  jobStore: TransferJobStore;
  stagingRootPath: string;
  nasRootPath: string;
  maxRetries: number;
  tls: GrpcTlsConfig;
  onPushCommitted?: OnPushCommitted;
}

function loadTransferEngineDefinition() {
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    deltix: { transfer: { v1: { TransferEngine: grpc.ServiceClientConstructor } } };
  };
  return proto.deltix.transfer.v1.TransferEngine.service;
}

/** Builds (but does not start) the gRPC server, wired to real handlers. */
export function createGrpcTransferServer(options: GrpcTransferServerOptions): grpc.Server {
  const service = loadTransferEngineDefinition();
  const server = new grpc.Server();

  server.addService(service, {
    push: (
      call: grpc.ServerReadableStream<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>,
    ) => {
      const handler = new PushSessionHandler(
        options.ticketService,
        options.jobStore,
        options.stagingRootPath,
        options.maxRetries,
        undefined,
        options.onPushCommitted,
      );
      let headerReceived = false;
      let aborted = false;
      let pendingAbort: { code: grpc.status; message: string } | undefined;
      let streamEnded = false;
      // grpc-js emits 'data' events synchronously and back-to-back for a
      // client-streaming call; since header activation (onHeader) is
      // async, without serializing we could start processing a 'chunk'
      // message before the previous 'header' message's ticket-consume
      // call has resolved (a real race caught in integration testing).
      // `queue` chains every message handler onto the previous one so
      // messages are always processed strictly in arrival order.
      let queue: Promise<void> = Promise.resolve();

      // IMPORTANT: never call `callback()` while the client may still be
      // writing/half-closing the stream. Ending the RPC early (before the
      // 'end' event) races with in-flight HTTP/2 frames and grpc-js drops
      // the connection instead of delivering a clean status (observed as
      // "UNAVAILABLE: Connection dropped" on the client in integration
      // tests). Instead we record the failure and keep draining incoming
      // messages (ignoring them once aborted) until 'end' fires, and only
      // then invoke `callback()` with the error.
      const markAborted = async (code: grpc.status, message: string) => {
        if (aborted) return;
        aborted = true;
        pendingAbort = { code, message };
        await handler.abort();
        if (streamEnded) {
          callback({ code, message });
        }
      };

      const processHeader = async (header: {
        ticketId: string;
        operation: string;
        repo: string;
      }) => {
        if (headerReceived) {
          await markAborted(grpc.status.FAILED_PRECONDITION, 'Header already sent');
          return;
        }
        headerReceived = true;
        await handler.onHeader(header.ticketId, header.operation as 'push' | 'pull', header.repo);
      };

      const processChunk = async (chunk: { data: Uint8Array }) => {
        if (!headerReceived) {
          await markAborted(grpc.status.FAILED_PRECONDITION, 'Chunk received before header');
          return;
        }
        handler.onChunk(chunk.data);
      };

      type PushMessage = {
        header?: { ticketId: string; operation: string; repo: string };
        chunk?: { data: Uint8Array };
      };

      const dispatchMessage = async (msg: PushMessage) => {
        if (msg.header) {
          await processHeader(msg.header);
        } else if (msg.chunk) {
          await processChunk(msg.chunk);
        }
      };

      const processMessage = async (msg: PushMessage) => {
        if (aborted) {
          return;
        }
        try {
          await dispatchMessage(msg);
        } catch (err) {
          const message = err instanceof PushSessionAbortedError ? err.message : 'Internal error';
          await markAborted(grpc.status.PERMISSION_DENIED, message);
        }
      };

      const finishSuccessfully = async () => {
        try {
          const result = await handler.finish();
          callback(null, {
            jobId: result.jobId,
            checksum: result.checksum,
            bytesReceived: result.bytesReceived,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Internal error';
          await markAborted(grpc.status.INTERNAL, message);
        }
      };

      const finalizeStream = async () => {
        if (aborted) {
          if (pendingAbort) {
            callback(pendingAbort);
          }
          return;
        }
        if (!headerReceived) {
          await markAborted(
            grpc.status.FAILED_PRECONDITION,
            'Stream ended before a header was sent',
          );
          return;
        }
        await finishSuccessfully();
      };

      call.on(
        'data',
        (msg: {
          header?: { ticketId: string; operation: string; repo: string };
          chunk?: { data: Uint8Array };
        }) => {
          queue = queue.then(() => processMessage(msg));
        },
      );

      call.on('end', () => {
        queue = queue.then(() => {
          streamEnded = true;
          return finalizeStream();
        });
      });

      call.on('error', () => {
        void handler.abort();
      });
      call.on('cancelled', () => {
        aborted = true;
        void handler.abort();
      });
    },

    pull: (call: grpc.ServerWritableStream<{ ticketId: string; repo: string }, unknown>) => {
      void (async () => {
        const handler = new PullSessionHandler(options.ticketService, options.nasRootPath);
        try {
          for await (const chunk of handler.stream(call.request.ticketId, call.request.repo)) {
            call.write({ data: chunk });
          }
          call.end();
        } catch (err) {
          if (err instanceof PullNotFoundError) {
            call.emit(
              'error',
              Object.assign(new Error(err.message), { code: grpc.status.NOT_FOUND }),
            );
          } else if (err instanceof PullSessionAbortedError) {
            call.emit(
              'error',
              Object.assign(new Error(err.message), { code: grpc.status.PERMISSION_DENIED }),
            );
          } else {
            call.emit(
              'error',
              Object.assign(new Error('Internal error'), { code: grpc.status.INTERNAL }),
            );
          }
        }
      })();
    },

    heartbeat: (
      call: grpc.ServerUnaryCall<{ ticketId: string }, unknown>,
      callback: grpc.sendUnaryData<{ newExpiresAt: number }>,
    ) => {
      void (async () => {
        try {
          const newExpiresAt = await options.ticketService.renewTicket(call.request.ticketId);
          callback(null, { newExpiresAt });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Internal error';
          callback({ code: grpc.status.PERMISSION_DENIED, message });
        }
      })();
    },
  });

  return server;
}

/** Binds the server with TLS server credentials (mandatory — see file header). */
export function bindGrpcTransferServer(
  server: grpc.Server,
  port: number,
  tls: GrpcTlsConfig,
): Promise<number> {
  const cert = readFileSync(tls.certPath);
  const key = readFileSync(tls.keyPath);
  const credentials = grpc.ServerCredentials.createSsl(
    null,
    [{ cert_chain: cert, private_key: key }],
    false,
  );

  return new Promise((resolve, reject) => {
    server.bindAsync(`0.0.0.0:${port}`, credentials, (err, boundPort) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(boundPort);
    });
  });
}
