/**
 * Pure, transport-agnostic business logic for handling a Pull transfer
 * session — the read-side counterpart of `PushSessionHandler`. Decoupled
 * from `@grpc/grpc-js` for the same reason: fast, real unit tests without
 * a live gRPC server.
 *
 * Design decision: Pull always reads from the NAS-simulated location
 * (`DELTIX_NAS_SIM_PATH/<repo>/repo.dolt`), NOT from SSD staging. Staging
 * is a transient upload buffer for in-flight pushes; once a push's
 * `TransferJob` is `synced`, the NAS copy is the durable, queryable
 * source of truth for reads. A repo with no synced copy yet cannot be
 * pulled — this is intentional: we never want a client to read a
 * half-uploaded, not-yet-verified staging file.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { TicketService } from '../transfer';

export class PullNotFoundError extends Error {
  constructor(repo: string) {
    super(`No synced copy available for repo '${repo}'`);
    this.name = 'PullNotFoundError';
  }
}

export class PullSessionAbortedError extends Error {
  constructor(reason: string) {
    super(`Pull session aborted: ${reason}`);
    this.name = 'PullSessionAbortedError';
  }
}

const CHUNK_SIZE = 64 * 1024;

export class PullSessionHandler {
  constructor(
    private readonly ticketService: TicketService,
    private readonly nasRootPath: string,
  ) {}

  /**
   * Activates the ticket (atomic, single-use) for this pull, resolves the
   * repo's synced file path, and returns an async iterable of chunks the
   * gRPC adapter can forward directly as stream writes. Throws
   * `PullSessionAbortedError` if the ticket is invalid, or
   * `PullNotFoundError` if the repo has no synced NAS copy — both are
   * fatal to the call.
   */
  async *stream(ticketId: string, repo: string): AsyncGenerator<Uint8Array> {
    try {
      await this.ticketService.consumeTicket(ticketId, 'pull', repo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new PullSessionAbortedError(`ticket rejected: ${message}`);
    }

    const filePath = join(this.nasRootPath, repo, 'repo.dolt');
    try {
      await stat(filePath);
    } catch {
      await this.ticketService.closeTicket(ticketId).catch(() => {});
      throw new PullNotFoundError(repo);
    }

    try {
      for await (const chunk of createReadStream(filePath, { highWaterMark: CHUNK_SIZE })) {
        yield chunk as Uint8Array;
      }
    } finally {
      await this.ticketService.closeTicket(ticketId).catch(() => {});
    }
  }
}
