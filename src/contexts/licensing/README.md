# Context: licensing

Status: Fase 1 of the roadmap (Cryptography & Licensing). Implemented on the
`phase-1-crypto-licensing` branch.

Responsibilities:
- Parse and verify the Ed25519-signed license key (`DELTIX_LICENSE_KEY`,
  verified against `DELTIX_LICENSE_PUBLIC_KEY`).
- Detect operating-system clock manipulation ("anti-clock-rollback") by
  comparing the current time against the latest commit timestamp recorded in
  Dolt's own immutable commit graph (`dolt_log`) — never against data this
  process could edit itself.
- Fail closed: if the license is invalid/expired, or a clock rollback is
  detected, boot is refused immediately (non-zero exit), with no silent
  degradation or retry.

Only `index.ts` from this folder may be imported by other contexts (ACL boundary).
