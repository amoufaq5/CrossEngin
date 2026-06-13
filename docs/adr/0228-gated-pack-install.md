# ADR-0228: gated pack install (Phase 3 P7.4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0084 (safety runtime), ADR-0081 (marketplace install runtime), ADR-0226 (architect-cli gate) |

## Context

P7's exit criterion ends "…and the agent publishes + installs the upgrade into a sandbox
tenant — refusing if the eval gate or cost ceiling trips." P7/P7.1–P7.3 built the gate; the
install half — driving the marketplace install engine **only when the gate allows** — was
still missing. `marketplace-pg` already has the install engine (`newInstallationRequest →
beginInstall → completeInstall`) + the RLS-scoped store; this composes them behind the gate
verdict.

## Decision

A `gated-install.ts` module in `@crossengin/marketplace-pg`:

- **`InstallGateVerdict`** — a structural verdict (`{ decision: "allow" | "confirm" |
  "refuse" }`) that `@crossengin/ai-architect-runtime`'s `ProposalGateDecision` satisfies as
  is, so `marketplace-pg` stays decoupled from the AI Architect runtime.
- **`installPackGated(store, input)`** installs a proposed pack upgrade into a tenant **only
  if the gate allows it**: a `refuse` verdict never installs (`{ installed: false, reason:
  "refused" }`); a `confirm` verdict installs only when `confirmed` (`confirmation_required`
  otherwise); an `allow` (or confirmed) verdict drives the install engine and persists via
  the store. An existing active install for the pack short-circuits as `already_installed`
  (no duplicate). The actor + tenant are explicit (the store re-enforces RLS).

## Consequences

- **72 packages + 4 apps, 128 meta-schema tables, ~7,445 offline tests + 60 gated
  real-Postgres integration tests.** No new META_ tables (reuses `meta.pack_installations`).
  New tests: `gated-install.test.ts` (5, offline with a fake store — refuse / confirm /
  confirmed / allow→installed / already_installed) + a gated `integration-gated-install.test.ts`
  (an `allow` verdict installs + reads the row back from `meta.pack_installations`, a
  `refuse` installs nothing, a re-install short-circuits — ran green against live Postgres 16).
- The install half of the exit criterion is now real: an approved + gate-allowed pack
  upgrade installs into a tenant; a refused one doesn't. Wiring this into `apps/architect-cli`
  as an agent-driven install command/tool (so the agent itself installs after an approved
  edit) — the literal "the agent publishes + installs" — is the next step; a marketplace
  *publish* registry is the deeper follow-up.
