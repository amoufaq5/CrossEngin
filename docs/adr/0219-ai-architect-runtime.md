# ADR-0219: `ai-architect-runtime` — the production safety-guard runtime (Phase 3 P7)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-25 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0057 (ai-architect-pg transcript), ADR-0055/0056 (architect-cli chat), ADR-0077 (P3 plan — P7) |

## Context

Phase 3 P7 (ADR-0077) is "AI Architect in production". The `ai-architect` package already models the
safety policy as pure functions — `evaluateRefusal` (hard, P0 refusals), `decideSessionAction` (cost
ceilings: session tokens / tenant monthly dollars / per-turn + per-tool call caps), and
`requiresBulkConfirmation` — but nothing holds the *live* cost state or composes these into a single
per-action verdict. A production Architect needs an enforcement runtime that gates every turn/tool. This
adds it, mirroring how the other `-runtime` packages turn contracts into stateful engines.

## Decision

`@crossengin/ai-architect-runtime` — pure, over the `ai-architect` policy. 2 modules:

- **state** — `SessionCostTracker`, in-memory per-session + per-tenant cost accounting: sessions
  accumulate `tokensUsed`, a `toolCallsThisTurn` counter (reset by `beginTurn`), and per-tool session
  tallies; tenants accumulate `monthlyDollarsUsed`. `session(id)` / `tenant(id)` project **frozen**
  `SessionCostState` / `TenantCostState` snapshots for the policy functions (mutating a snapshot can't
  corrupt the tracker); `resetSession` drops a finished session.
- **guard** — `ArchitectGuardRuntime` wraps the tracker + a `CostCeilings` (default
  `DEFAULT_BASE_CEILINGS`). `evaluate(request)` returns a `GuardDecision` in **strict precedence**:
  1. `refuse` — a hard-refusal category (P0, absolute) beats everything (the caller classifies; the
     runtime formats + enforces via `evaluateRefusal`);
  2. `block` — a cost ceiling reached (`decideSessionAction`);
  3. `confirm` — a bulk operation over threshold (`requiresBulkConfirmation`);
  4. `warn` — cost at the warn percent;
  5. `allow`.
  Thin `beginTurn` / `recordTokens` / `recordToolCall` / `recordDollars` delegate to the tracker, so a
  serving Architect drives one object: `evaluate` before a turn/tool, `record*` after.

## Consequences

- The Architect now has a single production enforcement point: decisions are stateless (pure policy over
  a snapshot), accounting is stateful, and the precedence encodes the platform's safety priority —
  refusals are never overridable, cost blocks halt before work, bulk actions gate on confirmation.
- Composes onto the existing chat loop: `architect-cli` (and any served Architect) calls `evaluate` per
  turn and `record*` after, with `ai-architect-pg` persisting the transcript alongside — the runtime is
  the missing enforcement layer between the two.
- Pure and dependency-light (only `ai-architect`), unit-tested offline; a Postgres cost-state sibling
  (surviving restarts, cross-node tenant spend) is the natural follow-up.
- 7,288 tests pass (+17: tracker accumulation / per-turn + per-tool counting / beginTurn reset / frozen
  snapshot / resetSession; guard allow / refuse / refuse-beats-block / warn / session+tenant+per-turn+
  per-tool blocks / bulk confirm / under-threshold allow / block-beats-confirm). Full build + typecheck
  green.
- Follow-ups: a Postgres cost-state store (durable per-tenant monthly spend); wiring the guard into
  `architect-cli`'s chat loop; the eval-gate + incident/redteam policy surfaces as further runtime
  checks.
