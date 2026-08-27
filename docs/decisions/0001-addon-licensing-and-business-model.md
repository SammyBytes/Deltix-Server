# ADR 0001: Addon Licensing & Business Model (Fase 4 groundwork)

- **Status**: Draft — under discussion, NOT approved, NOT implemented.
- **Date**: 2026-08-26
- **Owner**: @SammyBytes
- **Scope**: Deltix-Server only (Deltix-Client stays MIT/free, unaffected by this ADR).
- **Related**: Fase 1 (`src/contexts/licensing`), Fase 4 (not started — this ADR is the
  prerequisite planning artifact requested before Fase 4 begins).

> This document exists so every business/licensing decision has a paper trail before
> any code is written. Update it as decisions are made; do not silently change the
> model in code without updating this file first.

---

## 1. Problem statement

Deltix-Server is BSL 1.1 (Business Source License) — free to read/self-host/modify,
but the license text itself already prevents a third party from re-selling Deltix as
a competing hosted service during the BSL "conversion window" (converts to an OSI
license, e.g. Apache 2.0, after N years — the classic MariaDB/CockroachDB/Sentry model).

**That legal protection already covers the worst-case risk** (someone forking your
server code and reselling it as-is). What's still undecided is the **addon layer**:
once Fase 4 allows dynamic `import()`-loaded addons, we need a model for:

1. Which addons are "official" (built/maintained by the Deltix team) vs "community"
   (built by third parties).
2. Which official addons are free vs paid.
3. How a company actually *installs and runs* a community addon safely.
4. Whether/how Deltix takes a cut when someone else monetizes on top of the platform.

The user's stated goals (verbatim intent, paraphrased for clarity):
- Wants to contribute to open source genuinely, not just as a marketing veneer.
- Is worried the community could "steal the business" (i.e. someone builds/sells a
  competing addon or service on top of Deltix without Deltix seeing any benefit).
- Does not want the licensing/permission model to become operationally complex.
- This is an enterprise product — pricing has to reflect that.

---

## 2. Decision drivers (constraints we're optimizing for)

| Driver | Why it matters here |
|---|---|
| **Low operational complexity** | One engineer/small team maintaining this — the addon gate must be enforceable with a small, auditable amount of code (a signature check + a license-payload lookup), not a bespoke DRM system. |
| **Revenue protection without ecosystem suffocation** | If every addon requires Deltix's blessing to exist, nobody builds community addons and the ecosystem never forms. If nothing is protected, someone repackages your best addon and undercuts you. |
| **Trust & safety** | A community addon runs arbitrary code inside (or alongside) a customer's production control plane. Enterprise buyers will not install unsigned, unsandboxed third-party code next to their schema/data. |
| **Brand protection** | "Official" must mean something. If anyone can badge their addon "Deltix Official", the badge becomes worthless and support burden becomes unbounded (customers blaming Deltix for a community addon's bugs). |
| **Compatibility with BSL** | The addon contract/SDK itself should probably be MIT (like the client) so community authors aren't scared off by BSL — only the *server core* is BSL. |

---

## 3. Decision: three-tier addon model

### 3.1 Tiers

| Tier | Built by | License of the addon's own code | Runs with | Badge |
|---|---|---|---|---|
| **Official — Free** | Deltix team | Deltix's choice (likely MIT, same spirit as client) | Full trust, default permissions | ✅ "Deltix Official" |
| **Official — Paid** | Deltix team | Proprietary / BSL, gated by license payload | Full trust, default permissions | ✅ "Deltix Official" + 🔒 paywall |
| **Community** | Anyone | Author's choice (their repo, their license) | Sandboxed, explicit permission grants only | 🧩 "Community" (never "Official") — optional "Verified" sub-badge if Deltix reviewed it |

**Decision**: which specific official addons are free vs paid is a per-addon business
call the user makes later (tracked in §6, "Open decisions"), but the *default rule of
thumb* agreed here is:

> Generic/utility addons (things any self-hoster would want, that don't require
> ongoing Deltix engineering investment to keep safe/compliant) → **free**.
> Addons that require ongoing investment in security, compliance, scale, or support
> (SSO/SAML, audit/compliance exports, HA/clustering, advanced backup/DR, RBAC,
> enterprise observability) → **paid, official-only**. This is deliberately the same
> shape as GitLab CE/EE, Grafana OSS/Enterprise, Sentry OSS/Business — a well-tested
> pattern for exactly this concern.

### 3.2 Why community addons don't automatically "steal the business"

Three concrete mechanisms make this true, all cheap to build:

1. **Trademark/branding gate, not a code gate.** Nothing stops a community author
   from writing a great addon. What's protected by policy (and by BSL's general
   anti-competitive-resale clause) is the word "Official" and the Deltix logo. A
   community addon that gets popular is *good* for Deltix — it's free ecosystem
   growth, and Deltix can always offer to acquire/hire the author or fold the idea
   into an Official addon later (this is how npm, VS Code, and Terraform ecosystems
   grew without their vendors losing the core business).
2. **Enterprise buyers prefer official + supported over community + unsupported**,
   *if* Deltix's official version is genuinely better (SLA, security review, upgrade
   guarantees, support contract). This is a sales/product argument, not a technical
   lock — but it's the argument that actually holds in practice (see: nobody serious
   runs unsupported community auth plugins in a bank).
3. **Optional revenue share for marketplace distribution** (see §4) means if a
   community addon *does* become commercially significant and wants distribution
   through Deltix's official marketplace/registry, Deltix takes a cut — without
   Deltix needing to have built the addon at all.

### 3.3 What "sandboxed" means for community addons (Fase 4 technical direction, not yet built)

Not implemented yet — this is the direction Fase 4 should take, recorded now so the
decision isn't lost:

- Every addon ships an `addon.manifest.json` declaring: name, author, tier, semver of
  the Fase-4 addon contract it targets, and a **declared permission set** (e.g. `db:read`,
  `db:write`, `network:outbound`, `fs:staging-read`). This mirrors browser
  extension manifests and mobile app permission models — a well-understood UX for both
  admins and auditors.
- Official addons get **implicit full trust** (no manifest permission prompt) because
  Deltix already reviewed them.
- Community addons **must** declare permissions, and the server must refuse to load
  a community addon whose manifest requests something the license payload doesn't
  allow (e.g. `communityAddonsEnabled: false` → refuse to `import()` anything outside
  the official set, full stop).
- Every addon package must be **signed**; the server verifies the signature before
  ever calling `import()` on it. Official addons are signed with a Deltix-controlled
  key (reuses the same Ed25519 infrastructure already built in Fase 1's
  `src/contexts/licensing`). Community addons are signed by their own author's key —
  the server doesn't need to "trust" that key for authenticity of *origin*, but the
  license payload gate is what decides whether community code runs *at all* on this
  instance.

---

## 4. Revenue mechanics

| Mechanism | When it applies | Complexity to build |
|---|---|---|
| **Per-seat/per-node license fee** (already exists, Fase 1) | Always — this is the base Deltix-Server enterprise license | Already built |
| **Official paid addon flags in license payload** (`addons.official: ["sso-saml", "audit-compliance"]`) | Whenever a paid official addon is enabled for a customer | Small — extends the existing license payload schema, verified the same way as `tier`/`seats` today |
| **Community addon marketplace revenue share** (optional, future — not Fase 4) | Only if/when Deltix stands up an actual marketplace/registry for discovering & distributing community addons | Large — requires a registry service, packaging format, payment processing; explicitly **out of scope until there's real ecosystem demand** |
| **"Verified" community badge fee or free review program** | Optional differentiator: Deltix could offer free review for popular addons (goodwill/ecosystem growth) while charging a review/certification fee for others (b2b positioning) | Medium — mostly a process decision, not a technical one |

**Decision**: build only the first two now (they reuse Fase 1's existing licensing
machinery almost entirely). The marketplace/revenue-share mechanism is explicitly
**deferred** — do not build registry/payment infrastructure speculatively before
there's a real community of addon authors to justify it.

---

## 5. License payload extension (design only — not implemented)

Extends the existing Fase 1 payload (already Ed25519-signed & anti-tamper-checked via
Dolt's commit history). Additive, backward compatible — old payloads without `addons`
simply mean "no addons enabled", which fails closed by default (secure by default).

```jsonc
{
  "licensee": "Acme Corp",
  "tier": "enterprise",
  "seats": 10,
  "expiresAt": "2027-01-01T00:00:00Z",
  // --- new in this ADR, not yet implemented ---
  "addons": {
    // Explicit allow-list of paid official addons this license unlocks.
    // Free official addons are always allowed regardless of this list.
    "official": ["sso-saml", "audit-compliance"],
    // Whether this server instance is allowed to import() ANY community
    // addon at all. Fails closed (false) if omitted.
    "communityAddonsEnabled": false,
    // Optional cap, defense-in-depth against a compromised/rogue addon
    // sprawl even when community addons are enabled.
    "maxCommunityAddons": 5
  }
}
```

Enforcement rule (to be implemented in Fase 4, described here for continuity):
fail-closed exactly like Fase 1's license validator — if the payload doesn't
explicitly say an addon is allowed, it does not load. No addon `import()` call
happens before this check, mirroring the existing "license validated before HTTP
listener starts" boot-sequence discipline already established in `src/index.ts`.

---

## 6. Open decisions (need the user's input before Fase 4 starts)

These are explicitly **not decided yet** — tracked here so nothing gets assumed silently:

1. **Which specific addons will be official-free vs official-paid at launch?**
   (Needs an actual addon roadmap/backlog — none exists yet.)
2. **Pricing model for paid official addons**: bundled into higher license tiers
   (e.g. "Enterprise" tier includes SSO+audit) vs. à la carte per-addon pricing?
3. **Community addon distribution channel**: is there a registry at all for Fase 4,
   or do community addons start as "bring your own file path" (simplest possible
   MVP — no registry, no discovery UI, just a manifest + signature + local
   filesystem path) until there's real demand?
4. **"Verified" review program**: free goodwill program, paid certification, or not
   offered at all initially?
5. **Addon SDK/contract license**: confirmed direction is MIT (matches Client), but
   needs explicit sign-off since it affects how freely community authors can build
   against it.

---

## 7. Non-goals for now

- No addon marketplace/registry service.
- No payment processing for addons.
- No revenue-share automation.
- No addon sandboxing beyond permission-manifest + signature-gate (i.e. not a full
  VM/container-level isolation — reassess if/when a real security incident or
  enterprise buyer requirement demands it).

---

## 8. Next steps

Fase 4 implementation **must not start** until the "Open decisions" in §6 are
resolved by the user. When resolved, update this ADR's Status to "Accepted", record
the answers inline, and only then create the Fase 4 implementation todos.
