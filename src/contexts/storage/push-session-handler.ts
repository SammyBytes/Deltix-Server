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
  dryRun: boolean;
}

export interface PushPreparationResult {
  repo: string;
  username: string;
  stagingPath: string;
  dryRun: boolean;
}

export type OnBeforePush = (params: {
  repo: string;
  username: string;
  stagingPath: string;
  syncOptions: unknown;
}) => Promise<PushPreparationResult>;

export type OnPushCommitted = (params: {
  repo: string;
  username: string;
  jobId: string;
  checksum: string;
}) => Promise<void>;

export class PushSessionHandler {
  private hash = createHash('sha256');
  private bytesReceived = 0;
  private ticketId: string | undefined;
  private username: string | undefined;
  private repo: string | undefined;
  private syncOptions: unknown;
  private stagingFilePath: string | undefined;
  private fileSink: Bun.FileSink | undefined;
  private closed = false;

  constructor(
    private readonly ticketService: TicketService,
    private readonly jobStore: TransferJobStore,
    private readonly stagingRootPath: string,
    private readonly maxRetries: number,
    private readonly now: () => number = () => Date.now(),
    private readonly onPushCommitted: OnPushCommitted = async () => {},
    private readonly onBeforePush: OnBeforePush = async ({ repo, username, stagingPath }) => ({
      repo,
      username,
      stagingPath,
      dryRun: false,
    }),
  ) {}

  async onHeader(ticketId: string, operation: TransferOperation, repo: string): Promise<void> {
    if (this.ticketId) {
      throw new PushSessionAbortedError('Header already received for this session');
    }
    try {
      const ticket = await this.ticketService.consumeTicket(ticketId, operation, repo);
      this.username = ticket.username;
      this.syncOptions = ticket.syncOptions ?? null;
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

  onChunk(data: Uint8Array): void {
    if (!this.fileSink) {
      throw new PushSessionAbortedError('Received a data chunk before the header');
    }
    this.fileSink.write(data);
    this.hash.update(data);
    this.bytesReceived += data.byteLength;
  }

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

  async finish(): Promise<PushSessionResult> {
    if (this.closed) {
      throw new PushSessionAbortedError('Session already finished');
    }
    if (!this.ticketId || !this.repo || !this.stagingFilePath || !this.fileSink || !this.username) {
      throw new PushSessionAbortedError('finish() called before a valid header was received');
    }
    this.closed = true;

    this.fileSink.end();
    const checksum = this.hash.digest('hex');
    const now = this.now();
    const preparation = await this.onBeforePush({
      repo: this.repo,
      username: this.username,
      stagingPath: this.stagingFilePath,
      syncOptions: this.syncOptions,
    });

    if (preparation.dryRun) {
      await this.ticketService.closeTicket(this.ticketId).catch(() => {});
      return {
        jobId: 'dry-run',
        checksum,
        bytesReceived: this.bytesReceived,
        dryRun: true,
      };
    }

    const jobId = randomUUID();
    await this.jobStore.create({
      id: jobId,
      repo: preparation.repo,
      stagingPath: preparation.stagingPath,
      checksum,
      status: 'staged',
      retryCount: 0,
      maxRetries: this.maxRetries,
      nextRetryAt: 0,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    });

    await this.ticketService.closeTicket(this.ticketId).catch(() => {});

    await this.onPushCommitted({
      repo: preparation.repo,
      username: preparation.username,
      jobId,
      checksum,
    }).catch(() => {});

    return { jobId, checksum, bytesReceived: this.bytesReceived, dryRun: false };
  }

  async abort(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.fileSink) {
      try {
        this.fileSink.end();
      } catch {}
    }
    if (this.stagingFilePath) {
      await rm(this.stagingFilePath, { force: true });
    }
  }
}
