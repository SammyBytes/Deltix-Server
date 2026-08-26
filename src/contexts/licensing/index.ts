/**
 * Public API of the "licensing" bounded context (Fase 1: Cryptography &
 * Licensing). This is the ONLY module other contexts may import from — see
 * .github/copilot-instructions.md for the ACL boundary rule.
 */
export { assertNoClockRollback } from './anti-tamper';
export { type CommitLogReader, DoltCliCommitLogReader } from './dolt-commit-log.reader';
export { loadEd25519PublicKey, verifyEd25519Signature } from './ed25519';
export {
  ClockRollbackDetectedError,
  LicenseExpiredError,
  LicenseMalformedError,
  LicenseSignatureInvalidError,
} from './errors';
export {
  createLicenseValidator,
  type LicenseValidatorDeps,
  LicenseValidatorService,
} from './license-validator.service';
export type { LicensePayload, LicenseValidationResult } from './types';
