# Context: storage

SSD staging -> NAS sync pipeline (Fase 3 continued). Only `index.ts` from
this folder may be imported by other contexts (ACL boundary).

## Why a separate job entity from the transfer ticket

A ticket (`contexts/transfer`) authorizes and tracks a gRPC transfer
*session* — moving bytes from a client into local SSD staging. What
happens to those bytes *after* they land on staging is a fundamentally
different concern with its own failure modes (NAS unreachable, disk full,
checksum mismatch, needs multiple retries over minutes/hours) — modeling
it as a separate `TransferJob` state machine keeps the ticket lifecycle
(seconds-scale, single-use, sliding-window) uncoupled from the sync
lifecycle (minutes-to-hours-scale, retryable, eventually-consistent).

## Job state machine

```
STAGED --claim--> SYNCING --success--> SYNCED
                     |
                     +--failure (retries remain)--> SYNC_FAILED --(backoff elapsed)--> SYNCING
                     |
                     +--failure (retries exhausted)--> DEAD_LETTER --(manual retry)--> STAGED
```

Every transition is a single atomic conditional `UPDATE ... WHERE status =
'<expected>'` in `LibsqlTransferJobStore` — the same discipline as
`contexts/transfer/ticket-store.ts` — so multiple concurrent sync workers
can safely race to claim/process jobs without double-processing or losing
one.

## NAS simulation

No physical NAS is available in this environment. `LocalFsNasAdapter`
simulates one via a local folder (`DELTIX_NAS_SIM_PATH`), but honors the
exact same contract a real NAS client must: copy the bytes, compute/verify
a checksum, and make the result visible only via an atomic rename (never a
partially-written file under its final name). Swapping in a real NAS
adapter later (NFS/SMB mount, remote copy over SSH, etc.) requires
implementing `NasAdapter` — no changes to `NasSyncService` or the job
store.

## Retry/backoff and manual intervention

`NasSyncWorker` polls on an interval (`DELTIX_NAS_SYNC_POLL_INTERVAL_MS`)
and drains all currently-eligible jobs each tick. A failed sync gets an
exponential backoff (`DELTIX_NAS_SYNC_BACKOFF_BASE_MS`, capped at
`DELTIX_NAS_SYNC_BACKOFF_MAX_MS`) before its next automatic retry. Once
`DELTIX_TRANSFER_JOB_MAX_RETRIES` is reached, the job escalates to
`dead_letter` — data is never silently dropped; an operator must act via
`GET /api/v1/storage/transfer-jobs/dead-letter` (list) and `POST
/api/v1/storage/transfer-jobs/dead-letter/retry` (manual requeue), both
JWT-protected, ready to back a future Admin Web UI panel.

## Real Dolt commits on push (Fase 5.2)

`PushSessionHandler.finish()` accepts an injectable `OnPushCommitted` hook
(default no-op), invoked best-effort right after the `TransferJob` row is
created. `src/index.ts` wires this to `contexts/versioning`'s
`CommitService.recordPush()`, which records a real, additional `dolt
commit` — attributed to the pushing user — inside the repo's own Dolt
history, IF that `repo` was previously provisioned via `POST
/api/v1/versioning/repos` (Fase 5.1). Pushing to a `repo` with no
provisioned Dolt backend is still legal and simply produces no commit
(backward-compatible with the Fase 3/4 NAS-sim-only flow).

This hook is injected rather than imported directly so `storage` never
imports `versioning` (ACL boundary) — see `.github/copilot-instructions.md`.
A failure inside the hook is always swallowed here: the pushed bytes are
already safely staged and will still reach the NAS via the independent
sync pipeline above; losing one version-history commit is recoverable,
losing staged data is not.

## Sync-preference enforcement hook (Fase 5.8)

`PushSessionHandler` now accepts an injected `onBeforePush` callback in the
same style as `onPushCommitted`. `src/index.ts` wires this callback to the
`versioning` context so sync-preference overrides carried by the push ticket
can be revalidated server-side before the `TransferJob` row is created. This
keeps `storage` free of direct `versioning` imports while enforcing the
fail-closed rule that a push with an invalid FK-incomplete subset must never
proceed silently.

If the callback marks the request as `dryRun`, the push session closes the
ticket and returns success metadata without creating a `TransferJob`, so the
preview path never writes to NAS.

## Not yet implemented

- Wiring `NasSyncWorker`'s failure callback to an actual alerting/
  notification channel (currently only logs via `pino`).
