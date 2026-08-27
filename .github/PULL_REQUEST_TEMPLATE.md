## What does this change?

<!-- One or two sentences: what and why. Link the relevant ADR/roadmap phase if applicable. -->

## Checklist

- [ ] `bun run lint` passes with no new warnings.
- [ ] `bun run test:unit`, `test:integration`, and `test:smoke` all pass locally.
- [ ] `bun audit` reports no new vulnerabilities.
- [ ] No secrets, license keys, or JWT keys are hardcoded or committed.
- [ ] If this touches `licensing`, `auth`, or `addons`: I considered OWASP
      Top 10 / ASVS implications and kept the change fail-closed.
- [ ] Docs updated if this changes operator-facing behavior (`README.md`,
      `docs/`, or the relevant context's `README.md`).

## How was this tested?

<!-- What you ran, what you observed. Paste relevant test output if useful. -->
