/**
 * Orchestrates license validation: parse -> verify signature -> check
 * expiry -> check anti-tamper (clock vs. dolt_log). Fails closed at every
 * step — any failure yields `{ valid: false, reason }`, never a partial or
 * optimistic success.
 */
import { loadEnv } from '../../shared/env';
import { createLogger } from '../../shared/logger';
import { assertNoClockRollback } from './anti-tamper';
import { type CommitLogReader, DoltCliCommitLogReader } from './dolt-commit-log.reader';
import { verifyEd25519Signature } from './ed25519';
import { LicenseExpiredError, LicenseSignatureInvalidError } from './errors';
import { parseLicenseKey } from './license-parser';
import type { LicenseValidationResult } from './types';

export interface LicenseValidatorDeps {
  licenseKey: string;
  publicKeyMaterial: string;
  commitLogReader: CommitLogReader;
  clockToleranceMs: number;
  /** Injectable clock, defaults to the real system clock. Tests use this to
   * simulate rollback without touching the actual OS clock. */
  now?: () => Date;
}

export class LicenseValidatorService {
  private readonly logger = createLogger('licensing');
  private readonly getNow: () => Date;
  private intervalHandle: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: LicenseValidatorDeps) {
    this.getNow = deps.now ?? (() => new Date());
  }

  async validateOnBoot(): Promise<LicenseValidationResult> {
    try {
      const parsed = parseLicenseKey(this.deps.licenseKey);

      const signatureValid = verifyEd25519Signature(
        parsed.payloadBytes,
        parsed.signature,
        this.deps.publicKeyMaterial,
      );
      if (!signatureValid) {
        throw new LicenseSignatureInvalidError('License signature verification failed');
      }

      if (parsed.payload.expiresAt) {
        const expiresAtMs = Date.parse(parsed.payload.expiresAt);
        if (this.getNow().getTime() > expiresAtMs) {
          throw new LicenseExpiredError(`License expired at ${parsed.payload.expiresAt}`);
        }
      }

      const latestCommitTimestamp = await this.deps.commitLogReader.getLatestCommitTimestamp();
      assertNoClockRollback(this.getNow(), latestCommitTimestamp, this.deps.clockToleranceMs);

      this.logger.info(
        {
          licensee: parsed.payload.licensee,
          tier: parsed.payload.tier,
          seats: parsed.payload.seats,
        },
        'License validated successfully',
      );
      return { valid: true, license: parsed.payload };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown license validation error';
      this.logger.error(
        { reason, errorType: error instanceof Error ? error.constructor.name : 'Unknown' },
        'License validation failed',
      );
      return { valid: false, reason };
    }
  }

  /** Re-validates on a fixed interval (e.g. every few minutes) to catch a
   * license revoked or a clock manipulated after boot. */
  startPeriodicValidation(intervalMs: number): void {
    this.stopPeriodicValidation();
    this.intervalHandle = setInterval(() => {
      void this.validateOnBoot();
    }, intervalMs);
    this.intervalHandle.unref?.();
  }

  stopPeriodicValidation(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }
}

/** Builds a validator wired to real environment configuration. */
export function createLicenseValidator(): LicenseValidatorService {
  const env = loadEnv();
  return new LicenseValidatorService({
    licenseKey: env.DELTIX_LICENSE_KEY,
    publicKeyMaterial: env.DELTIX_LICENSE_PUBLIC_KEY,
    commitLogReader: new DoltCliCommitLogReader(env.DELTIX_DOLT_REPO_PATH),
    clockToleranceMs: env.DELTIX_CLOCK_TOLERANCE_MS,
  });
}
