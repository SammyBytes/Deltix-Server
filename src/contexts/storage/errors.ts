/**
 * Storage-specific error types. Kept distinct from other contexts' errors
 * — `storage` must never import internals from `transfer`/`auth`, only
 * their public barrels (ACL rule), and vice versa.
 */

export class TransferJobNotFoundError extends Error {
  constructor() {
    super('Transfer job not found');
    this.name = 'TransferJobNotFoundError';
  }
}

/**
 * Thrown when a caller attempts to transition a job from a status it is
 * not currently in (e.g. retrying a job that is not SYNC_FAILED/DEAD_LETTER,
 * or claiming a job that another worker already claimed). Concurrency-safe
 * by construction: the underlying store only ever reports this via a
 * failed atomic conditional UPDATE, never a stale read.
 */
export class TransferJobInvalidTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Cannot transition transfer job from '${from}' to '${to}'`);
    this.name = 'TransferJobInvalidTransitionError';
  }
}

/** Thrown when a staged file's checksum does not match at promotion time. */
export class ChecksumMismatchError extends Error {
  constructor() {
    super('Checksum mismatch between staged file and NAS copy');
    this.name = 'ChecksumMismatchError';
  }
}
