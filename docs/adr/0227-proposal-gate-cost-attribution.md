# ADR-0227: live cost attribution for the proposal gate (Phase 3 P7.3)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0084 (safety runtime), ADR-0059 (ai-router cost tracker), ADR-0226 (architect-cli gate) |

## Context

P7's `evaluateProposalGate` has a `cost` facet (`SessionDecisionInput` → `decideSessionAction`,
allow/warn/block), but the caller had to assemble the per-tenant spend by hand. The third P7
bullet is "the router's `onResolved` attribution + cost tracker feeding per-tenant AI
budgets" — connecting `ai-router`'s `CostTracker` (which accumulates per-tenant USD windows)
to the gate's cost facet so it's *live*.

## Decision

A `cost-attribution.ts` module in `@crossengin/ai-architect-runtime`:

- **`TenantCostWindowSource`** — a structural interface (`getWindow(tenantId) →
  Promise<{ costUsd } | null>`) that `ai-router`'s `CostTracker` satisfies as-is, so the
  bridge needs **no `ai-router` dep**.
- **`buildProposalCostInput({ source, tenantId, ceilings, session, proposedTool? })`** reads
  the tenant's accumulated spend window (`costUsd`) and maps it to the gate's
  `tenant.monthlyDollarsUsed`, alongside the live session token/tool state. Feeding the
  result into `evaluateProposalGate({ cost })` makes the cost facet live — a tenant whose
  router-tracked AI spend has hit its monthly ceiling gets its next proposal **blocked** (a
  warning as it approaches). `null` window ⇒ zero spend. (The deployment configures the
  tracker's window to match the ceiling's period.)

## Consequences

- **72 packages + 4 apps, 128 meta-schema tables, ~7,440 offline tests.** No new META_
  tables; no new dep (structural source). New tests: `cost-attribution.test.ts` (4 — maps
  the spend window to `monthlyDollarsUsed`, null → 0, over-ceiling spend ⇒ gate `refuse`,
  under-ceiling ⇒ `allow`).
- The proposal gate's cost facet is now driven by real per-tenant AI spend. The remaining
  P7 work is the agent → `marketplace-pg` publish+install on an allowed proposal (toward the
  exit criterion's "publishes + installs the upgrade into a sandbox tenant"), and extending
  the apply-flow guard to the four context-dependent hard refusals.
