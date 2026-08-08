# ADR-0222: Wiring durable per-tenant cost into the Architect chat command (Phase 3 P7)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-28 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0221 (ai-architect-runtime-pg), ADR-0220 (chat-guard wiring), ADR-0219 (ai-architect-runtime), ADR-0077 (P3 plan — P7) |

## Context

ADR-0221 shipped `PostgresTenantCostStore` + `seedTenantMonthlyCost`, but the `architect-cli` chat
command still used a fresh in-memory guard each run, so the durable monthly total was never loaded or
written. This wires the store into the command: seed the guard from the tenant's persisted spend at
session start, and persist each turn's cost back — closing the P7 durable-cost loop end-to-end.

## Decision

- **`runChatExchange` gains an `onTurnCost` sink** (`chat.ts`). After each turn's usage is recorded into
  the in-memory guard, `persistTurnCost(opts.onTurnCost, usage)` calls the sink with the turn's dollar
  cost (zero-cost turns skipped). Threaded through `ChatReplOptions` → `runChatRepl` → both
  `runChatExchange` call sites. Opt-in: without a sink, behavior is unchanged.
- **The chat command wires the durable store** (`commands.ts`). It already opens a Postgres connection
  for `--persist`; that same connection now also backs a `PostgresTenantCostStore`. Before the loop it
  **seeds** the guard's tracker with the tenant's persisted monthly total
  (`seedTenantMonthlyCost(store, guard.tracker, tenantId, now)`), and it passes an `onTurnCost` sink that
  **persists** each turn's cost via `addMonthly(tenantId, monthlyPeriodKey(now), dollars)` — the atomic
  accumulator. So the in-memory tracker holds the running total (seeded + this session's turns) while
  the DB accumulates the durable deltas; the two stay consistent. A seed failure is a clean `chat:
  failed to load durable cost state` error, not a crash.

## Consequences

- The Architect's per-tenant **monthly dollar ceiling now persists end-to-end**: a `--persist` chat run
  loads the tenant's month-to-date spend, enforces the ceiling against it from the first turn, and writes
  each turn's cost back — so the budget holds across CLI invocations, restarts, and concurrent instances
  (atomic `addMonthly`). Without `--persist`, the guard stays in-memory (unchanged prior behavior).
- The durable cost path reuses the existing `--persist` connection, so no new flag/credential surface —
  cost governance rides along with transcript persistence, both durable together.
- The store path itself (real Postgres) is offline-untestable like `--persist`, but the seam is fully
  covered: `onTurnCost` is invoked with each turn's cost (zero-cost turns skipped), and `seed` /
  `addMonthly` / `monthlyPeriodKey` were covered in ADR-0221.
- 7,301 tests pass (+2 architect-cli: `onTurnCost` called with each turn's dollar cost across a
  two-turn exchange; zero-cost turns skipped). Full build + typecheck green.
- Follow-ups: a `--cost-store`-style flag to enable durable cost independently of transcript persistence;
  surfacing month-to-date spend in the session-end summary; a monthly reset/rollover query.
