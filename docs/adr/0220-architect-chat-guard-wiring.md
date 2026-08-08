# ADR-0220: Wiring the safety guard into the Architect chat loop (Phase 3 P7)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-26 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0219 (ai-architect-runtime), ADR-0055/0056 (architect-cli chat + tools), ADR-0077 (P3 plan — P7) |

## Context

ADR-0219 shipped `ArchitectGuardRuntime` — the stateful cost/refusal guard — but nothing drove it: the
`architect-cli` chat loop called the provider and executed tools with no enforcement. This wires the
guard into the loop so a served Architect enforces cost ceilings live, end-to-end.

## Decision

- **`runChatExchange` gains an optional `guard`** (`architect-cli`, `chat.ts`). When present:
  - **Pre-turn gate** — before the provider is called, `guard.beginTurn(sessionId)` resets the per-turn
    tool counter and `guard.evaluate({tenantId, sessionId})` runs. A **`block`** short-circuits the whole
    exchange: it writes a `blocked by the AI Architect cost guard: <reason>` notice and returns a
    zero-turn result (`usage: null`, `iterations: 0`) — the provider is **never called**, so a tenant
    over its token/dollar ceiling can't spend more. A **`warn`** prints a budget-percentage line and
    proceeds.
  - **Per-tool gate** — before each tool call, `guard.evaluate({…, proposedTool})`. A **`block`** (per-turn
    or per-tool cap) skips execution and feeds the model a `tool '<name>' blocked by the cost guard`
    error result instead, so it can react; an allowed tool executes and is recorded via
    `recordToolCall`.
  - **Usage recording** — after each turn (initial + every continuation), `recordTurnCost` folds the
    turn's tokens (`input + output`) and dollars into the session/tenant cost state, so the next
    `evaluate` sees real accumulated spend.
- **Threaded through** `ChatReplOptions` → `runChatRepl` → both `runChatExchange` call sites, and the
  `chat` command constructs an `ArchitectGuardRuntime` (default ceilings) — so enforcement is **on by
  default** for the real CLI, while `runChatExchange` without a `guard` is unchanged (existing tests and
  any embedder that omits it behave exactly as before).

## Consequences

- The Architect's cost ceilings are now enforced where the spend happens: a session that hits 50k tokens
  (default) or a tenant at $200/month is blocked before the next provider call, and a tool that hits its
  per-session cap is refused mid-loop without executing. P7 enforcement is live end-to-end, not just a
  library.
- The guard is opt-in at the engine seam (`opts.guard`) but default-on at the command, so production CLI
  runs are protected while the pure engine stays testable without it. Default ceilings are generous, so
  normal sessions (and all existing offline tests with small stub usage) see no behavior change.
- Refusals (hard P0 categories) are wired through the same `evaluate` but only fire when a caller
  classifies an action as a refusal category — the chat loop passes none today, so the live effect here
  is cost + cap enforcement; classifying `propose_manifest_edit` against refusal categories is the noted
  follow-up.
- 7,291 tests pass (+3 architect-cli: pre-turn ceiling block skips the provider; per-turn usage recorded
  into the guard state; per-tool cap blocks a tool without executing it). Full build + typecheck green.
- Follow-ups: classify `propose_manifest_edit` against hard-refusal categories so the refuse path fires;
  a durable (Postgres) cost-state store so ceilings persist across CLI invocations / nodes; surfacing the
  guard verdict in the `--format json` envelope.
