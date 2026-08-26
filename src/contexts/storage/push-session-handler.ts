/**
 * Pure, transport-agnostic business logic for handling a Push transfer
 * session — deliberately decoupled from `@grpc/grpc-js` so it can be unit
 * tested without spinning up a real gRPC server. The thin gRPC service
 * implementation (`grpc-transfer-server.ts`) adapts grpc-js's
 * stream/callback API to this class.
 *
 * Lifecycle for one Push session:
 *   1. onHeader(ticketId, operation, repo) -> must consume the ticket
 *      (single-use, atomic) before any bytes are accepted. Fail-closed:
 *      any error here aborts the session immediately.
 *   2. onChunk(bytes) -> appended to the staging file, incrementally
 *      hashed (no need to buffer the whole file in memory).
 *   3. onHeartbeat() -> renews the ticket's sliding-window expiry. If the
 *      ticket has already expired/been closed, this throws and the caller
 *      (gRPC adapter) must abort the in-flight session — a stale ticket
 *      must not be allowed to keep streaming.
 *   4. finish() -> closes the staging file handle, computes the final
 *      checksum, creates a `TransferJob` row (status STAGED) for the
 *      independent NAS-sync pipeline to pick up later, and closes the
 *      ticket.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TicketService, TransferOperation } from '../transfer';
import type { TransferJobStore } from './transfer-job-store';

export class PushSessionAbortedError extends Error {
  constructor(reason: string) {
    super(`Push session aborted: ${reason}`);
    this.name = 'PushSessionAbortedError';
  }
}

export interface PushSessionResult {
  jobId: string;
  checksum: string;
  bytesReceived: number;
}

export class PushSessionHandler {
  private hash = createHash('sha256');
  private bytesReceived = 0;
  private ticketId: string | undefined;
  private repo: string | undefined;
  private stagingFilePath: string | undefined;
  private fileSink: Bun.FileSink | undefined;
  private closed = false;

  constructor(
    private readonly ticketService: TicketService,
    private readonly jobStore: TransferJobStore,
    private readonly stagingRootPath: string,
    private readonly maxRetries: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Must be called exactly once, with the very first message of the
   * stream. Activates the ticket atomically; throws
   * `PushSessionAbortedError` (wrapping the underlying ticket error) if
   * the ticket is invalid for any reason — the gRPC adapter must treat
   * this as fatal and close the call with an error status, never accept
   * any subsequent chunk.
   */
  async onHeader(ticketId: string, operation: TransferOperation, repo: string): Promise<void> {
    if (this.ticketId) {
      throw new PushSessionAbortedError('Header already received for this session');
    }
    try {
      await this.ticketService.consumeTicket(ticketId, operation, repo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new PushSessionAbortedError(`ticket rejected: ${message}`);
    }

    this.ticketId = ticketId;
    this.repo = repo;
    this.stagingFilePath = join(this.stagingRootPath, repo, `${randomUUID()}.staging`);
    await mkdir(dirname(this.stagingFilePath), { recursive: true });
    this.fileSink = Bun.file(this.stagingFilePath).writer();
  }

  /** Appends bytes to the staging file and the running checksum. */
  onChunk(data: Uint8Array): void {
    if (!this.fileSink) {
      throw new PushSessionAbortedError('Received a data chunk before the header');
    }
    this.fileSink.write(data);
    this.hash.update(data);
    this.bytesReceived += data.byteLength;
  }

  /**
   * Heartbeat: renews the ticket's sliding-window expiry. Throws if the
   * ticket can no longer be renewed (expired/closed) — the caller must
   * abort the session on failure; continuing to accept chunks for an
   * unrenewable ticket would defeat the entire point of the sliding
   * window.
   */
  async onHeartbeat(): Promise<void> {
    if (!this.ticketId) {
      throw new PushSessionAbortedError('Heartbeat received before the header');
    }
    try {
      await this.ticketService.renewTicket(this.ticketId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new PushSessionAbortedError(`heartbeat renewal rejected: ${message}`);
    }
  }

  /**
   * Finalizes the session: flushes the staging file, records a
   * `TransferJob` (STAGED) for the independent async NAS-sync pipeline,
   * and closes the ticket. Idempotent — calling this more than once is a
   * programming error and throws.
   */
  async finish(): Promise<PushSessionResult> {
    if (this.closed) {
      throw new PushSessionAbortedError('Session already finished');
    }
    if (!this.ticketId || !this.repo || !this.stagingFilePath || !this.fileSink) {
      throw new PushSessionAbortedError('finish() called before a valid header was received');
    }
    this.closed = true;

    this.fileSink.end();
    const checksum = this.hash.digest('hex');
    const jobId = randomUUID();
    const now = this.now();

    await this.jobStore.create({
      id: jobId,
      repo: this.repo,
      stagingPath: this.stagingFilePath,
      checksum,
      status: 'staged',
      retryCount: 0,
      maxRetries: this.maxRetries,
      nextRetryAt: 0,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    });

    await this.ticketService.closeTicket(this.ticketId).catch(() => {
      // Best-effort: the ticket has already served its purpose (bytes are
      // safely staged); a failure to explicitly close it is not fatal to
      // the transfer, it will simply expire on its own sliding window.
    });

    return { jobId, checksum, bytesReceived: this.bytesReceived };
  }

  /**
   * Called by the gRPC adapter when the client disconnects or a fatal
   * error occurs mid-stream. Cleans up the partial staging file so it
   * never gets mistaken for a completed transfer — no `TransferJob` row
   * is created (the client must retry the whole push with a new ticket).
   */
  async abort(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.fileSink) {
      try {
        this.fileSink.end();
      } catch {
        // Best-effort cleanup only.
      }
    }
    if (this.stagingFilePath) {
      await rm(this.stagingFilePath, { force: true });
    }
  }
}
