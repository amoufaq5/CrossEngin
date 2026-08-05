# ADR-0213: `marketplace-runtime` — per-tenant pack install lifecycle (Phase 3 P5)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0077 (P3 plan — P5), M2.5 (marketplace crypto wiring), ADR-0048 (crypto) |

## Context

The `marketplace` package models the *shape* of the extension marketplace — pack manifests, signed
version records, install/grant/listing state machines, compatibility, security review — as pure
contracts + helpers, but nothing *drives* them: there is no engine that takes a signed pack and a tenant
and produces an installation. P5 (ADR-0077, "marketplace install") is that engine. It follows the
established runtime-pillar pattern (a pure in-process `-runtime` first, a Postgres `-pg` sibling later),
exactly as `workflow-runtime` / `observability-runtime` did over their contract packages.

## Decision

`@crossengin/marketplace-runtime` — pure, in-process, no new META tables (it emits records typed by the
existing `marketplace` schemas). 4 modules:

- **clock** — `Clock`/`FixedClock`/`SystemClock` + `IdGenerator`/`CountingIdGenerator`/`RandomIdGenerator`
  (+ `formatInstallationId`), so tests pin time + ids and prod uses the wall clock + `crypto.randomUUID`.
- **decisions** — the `InstallRequest` input (pack manifest + version + compatibility + signature +
  publisher key + review status + tenant context + existing installs), the `InstallDecision`
  discriminated union (`admitted` / `permission_pending` / `rejected`), and the ordered
  `INSTALL_REJECTION_REASONS` (`already_installed` → `signature_invalid` → `incompatible` →
  `review_required`).
- **install** — the pure pipeline + guarded transitions. `admitInstallation` runs the four gates in a
  fixed order (first failure wins): the already-installed guard (`activeInstallations`), Ed25519
  signature verification (`verifyPackSignature` over the real crypto), compatibility
  (`checkCompatibility` — platform/region/plan/compliance/dedicated), and the elevated-review gate
  (`requiresElevatedReview` must have cleared `passed`/`exempt`). On success it builds the `requested`
  installation with its scope grants seeded pending (`buildInitialGrantSet`) and advances it — straight
  to `installing` when the pack needs no required scopes, else to `permission_pending`.
  `applyPermissionGrants` flips pending grants to granted and advances to `installing` once
  `resolvePermissions` is satisfied; `completeInstallation` / `failInstallation` / `beginUninstall` /
  `completeUninstall` / `beginUpdate` / `completeUpdate` are the rest of the lifecycle. Every transition
  is guarded by `canTransitionInstallation` and re-validated through `PackInstallationSchema`, so an
  illegal transition throws and every emitted record is schema-valid.
- **engine** — `MarketplaceInstallEngine`, a thin stateful wrapper injecting the clock's timestamps and
  the id generator's ids so callers drive the whole lifecycle without threading `now`/`id`. It holds no
  installation state — the caller owns the `PackInstallationSet` (so it can be a Postgres table, an
  in-memory array, whatever), which the `-pg` sibling will persist.

## Consequences

- The marketplace's contracts now have a runtime: a signed pack + a tenant context → an admission
  decision → a lifecycle. The exit criterion runs in tests end-to-end — a real Ed25519-signed pack is
  admitted, its required scopes granted, installed, then uninstalled; a tampered signature, an
  incompatible platform, and an un-reviewed PHI pack are each rejected with the right reason.
- Signature verification is real (`@crossengin/crypto` Ed25519), not stubbed — a forged or
  wrong-key signature fails admission, closing the supply-chain gate the marketplace contracts described.
- No new META tables and no central wiring: like `observability-runtime`, it emits records typed by
  existing contracts; a `marketplace-runtime-pg` that persists the `PackInstallationSet` +
  grant/version records to the existing META_PACK_* tables is the explicit next step, and an
  operate-server admin route to install packs per tenant is the one after.
- 7,213 tests pass (+24: the four admission gates + both admit outcomes, partial→full scope granting,
  the full install → uninstall and install → update lifecycles, illegal-transition guarding, and the
  clock/id sources). Full build + typecheck green.
