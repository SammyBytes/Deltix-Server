# Security Policy

Deltix-Server is the control plane for the Deltix system: it validates
Ed25519-signed licenses, brokers gRPC transfers, and dynamically loads
addons. Security issues here have a direct blast radius on customer data —
treat any report seriously and respond fast.

## Supported versions

Only the latest release on `main` is supported with security fixes during
the current pilot/pre-1.0 phase. There is no long-term-support branch yet.

| Version        | Supported |
| -------------- | --------- |
| `main` (latest)| ✅        |
| Older tags     | ❌        |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Use GitHub's private vulnerability reporting instead:
1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, impact, and reproduction steps in as much detail as
   possible.

You should expect an initial response within **5 business days**. Please
give us a reasonable window to investigate and ship a fix before any public
disclosure.

## Scope

In scope:
- Ed25519 license verification and the Dolt-log-backed anti-tamper check
  (`src/contexts/licensing`).
- Authentication, session, and JWT handling (`src/contexts/auth`).
- The addon loader, manifest validation, permission enforcement, and the
  TOFU (Trust-On-First-Use) trust store (`src/contexts/addons`).
- The gRPC transfer engine and ephemeral ticket issuance
  (`src/contexts/transfer`).
- The Admin Web UI (`src/contexts/admin-ui`) — XSS, CSRF, CSP bypass, auth
  bypass.
- Supply-chain issues in `package.json`/`bun.lock` dependencies.

Out of scope (report upstream instead):
- Vulnerabilities in the Dolt CLI binary itself (report to
  [dolthub/dolt](https://github.com/dolthub/dolt)).
- Vulnerabilities in Bun itself (report to
  [oven-sh/bun](https://github.com/oven-sh/bun)).

## Our security baseline

This project follows, at minimum:
- **OWASP ASVS** (fail-closed license/auth checks, no security-by-obscurity).
- **OWASP Top 10** threat modeling for every new context added
  (see `.github/copilot-instructions.md`).
- Secrets (license private keys, JWT keys, DB paths) are always supplied via
  environment variables — **never hardcoded**, never logged, never committed.
- Dependency vulnerabilities are checked with `bun audit` in CI on every
  push/PR, and Dependabot keeps dependencies patched automatically
  (see `.github/dependabot.yml`).
