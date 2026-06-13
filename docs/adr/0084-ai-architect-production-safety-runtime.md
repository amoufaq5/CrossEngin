# ADR-0084: AI Architect production safety runtime (Phase 3 P7)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0077 (Phase 3 plan), ADR-0025 (AI Architect safety + governance), ADR-0081 (marketplace install runtime) |

## Context

P7 puts the AI Architect into production: the authoring loop (already tool-driven +
persisted) wired so an approved `propose_manifest_edit` can *publish + install* a pack,
with the `ai-architect` safety policy enforced and per-tenant cost ceilings live. The
`ai-architect/policy` submodule already ships the safety **contracts + deciders** (hard
refusals, cost ceilings, the eval gate, confirmation gates, redteam, incidents) — but
nothing *composes* them into a single "is this proposal allowed?" verdict for the loop.
Mirroring how every milestone opens with a pure runtime over the contracts
(`observability-runtime`, `active-active-runtime`, `edge-runtime`), P7 opens with that
composition.

## Decision

A new pure package `@crossengin/ai-architect-runtime` (the **72nd**), dep
`@crossengin/ai-architect`. Two modules:

- **`proposal-gate.ts`** — `evaluateProposalGate(input) → ProposalGateDecision` composes
  the policy deciders into one verdict (`allow` / `confirm` / `refuse`) by precedence: a
  **hard refusal** (`evaluateRefusal`, P0, non-overridable) wins and is **terminal**
  (short-circuits the rest); otherwise a cost-ceiling **block** (`decideSessionAction`) or
  an eval-gate **block** (`evaluateGate`) → `refuse`; otherwise an eval gate that's
  `fail_with_override_possible`, or a bulk operation over threshold
  (`requiresBulkConfirmation`), → `confirm` (a human must acknowledge/override); a cost
  **warn** is a non-blocking `warning`; else `allow`. Each clause of the input is optional —
  the runtime evaluates only the facets the loop supplies. The per-facet decisions
  (`refusal` / `costDecision` / `evalOutcome`) are surfaced for the UI.
- **`summary.ts`** — `formatProposalGate(decision)` renders the verdict (headline +
  reasons + warnings + the refusal citation) for the CLI.

## Consequences

- **72 packages + 4 apps, 128 meta-schema tables, ~7,427 offline tests.** No new META_
  tables (pure runtime; the loop persists via the existing `ai-architect-pg` transcript +
  `marketplace-pg`). New tests: `proposal-gate.test.ts` (8 — allow, hard-refusal terminal
  short-circuit, cost block / warn, eval block [safety-critical regression] / overridable
  regression, bulk confirm, refuse-wins-over-confirm) + `summary.test.ts` (3).
- The safety policy is now enforceable as one call in the authoring loop. The remaining P7
  increments: detecting a hard refusal from a proposed manifest diff (mapping a `DiffSummary`
  → an optional `HardRefusal`), wiring `evaluateProposalGate` into `apps/architect-cli`'s
  approval path, the agent → `marketplace-pg` publish+install on an `allow`/confirmed
  proposal, and the router's `onResolved` cost attribution feeding the per-tenant ceiling
  state.
