/**
 * Port for the actual NAS transport. Kept separate from `TransferJobStore`
 * (bookkeeping) so the pipeline logic never depends on a real network/NAS
 * mount to be unit-tested. The real implementation
 * (`local-fs-nas-adapter.ts`) simulates a NAS via a local folder
 * (`DELTIX_NAS_SIM_PATH`) since no physical NAS is available yet — but the
 * contract (copy + verify) is identical to what a real NAS client would do.
 */
export interface NasAdapter {
  /**
   * Copies the staged file to the NAS destination for `repo`, returning the
   * checksum of the bytes actually written there. The caller compares this
   * against the staging checksum to detect corruption in transit.
   */
  copyToNas(stagingPath: string, repo: string): Promise<{ checksum: string }>;
}
