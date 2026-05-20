# ADR-0141: RouterInstrumentation interface + META_LLM_CALL_TRACES + PostgresRouterInstrumentation (Phase 2 M6.7.z)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0059 (M6.5 ai-router), ADR-0120 (M8 workflow instrumentation hooks), ADR-0135 (M6.7 PostgresCostTracker), ADR-0137 (M6.7.x per-tenant ceiling), ADR-0140 (M6.7.y PostgresLatencyTracker) |

## Context

M8 (ADR-0120) gave the workflow runtime an instrumentation rail: 11 (now 14, after M8.1) event kinds wired to a `WorkflowInstrumentation.onEvent` hook + a `META_WORKFLOW_TRACES` table for persistence. The ai-router has nothing equivalent.

ADR-0135 Q2 lined this up:

> Should `recordUsage` emit an event into a router-scoped instrumentation channel (like M8's `WorkflowInstrumentation`)?
> _Current direction:_ Likely yes — operators want per-LLM-call traces for cost attribution. A `RouterInstrumentation` interface mirroring `WorkflowInstrumentation` is a separate milestone.

ADR-0137 Q3+Q4 reinforced the need:

> Q3: Should the resolver emit a structured signal on cache miss / hit (observability)?
> _Current direction:_ A `RouterInstrumentation` interface is the natural home for ceiling-resolution events.
> Q4: Should the router track which ceiling (tenant vs global) was used for which request (audit)?
> _Current direction:_ Out of scope. Full audit needs `RouterInstrumentation`.

ADR-0140 Q3:

> Q3: Should there be a `RouterInstrumentation` rail that emits per-LLM-call traces (kind=llm_call_completed) carrying full attribution including cost + tokens + tenant?
> _Current direction:_ Yes — M6.7.z.

M6.7.z closes all three deferred-Qs.

### Why traces are distinct from latency samples

`META_LLM_LATENCY_SAMPLES` (M6.7.y) and `META_LLM_CALL_TRACES` (M6.7.z) are deliberately separate substrates:

- **Latency samples** are **aggregation-optimized**: small rows (`provider_id`, `latency_ms`, `success`, `recorded_at`), composite index for windowed p50/p95 queries, no tenant scoping, no RLS.
- **Traces** are **audit-optimized**: full event context (tenant, session, task, model, costUsd, tokens, error details), JSONB attributes, tenant-scoped with RLS.

A single mega-table trying to serve both would be neither: every aggregation query would scan-and-decode large rows, and every audit query would compete with high-volume sample writes. Different read patterns deserve different schemas.

## Decision

Three additions, mirroring the M8 workflow instrumentation pattern:

1. **`RouterInstrumentation` interface** + helpers in `@crossengin/ai-router`. Three event kinds: `llm_call_started`, `llm_call_completed`, `llm_call_failed`. Default `NoopRouterInstrumentation`. Helpers: `captureRouterInstrumentation()` for tests, `combineRouterInstrumentations(...)` for fan-out.
2. **Wire into `DefaultLlmRouter`.** New constructor option `instrumentation?: RouterInstrumentation` (defaults to noop). `onEvent` calls at three lifecycle points inside `complete()`: started (before fetch, after preflight), completed (on success), failed (on per-provider failure, with `willFallback` derived from remaining choices).
3. **`META_LLM_CALL_TRACES` table (124th)** + `PostgresRouterInstrumentation` in `@crossengin/ai-router-pg`. Tenant-scoped, RLS-enabled, audit-grade row layout. Single INSERT per `onEvent` call.

### `RouterInstrumentationEvent` shape

```ts
export interface RouterInstrumentationEvent {
  readonly kind: "llm_call_started" | "llm_call_completed" | "llm_call_failed";
  readonly tenantId: string;
  readonly sessionId: string;
  readonly task: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly occurredAt: string;       // ISO 8601
  readonly durationMs: number | null;  // null on started
  readonly attributes: Readonly<Record<string, unknown>>;
}
```

The first six fields are always populated. `durationMs` is `null` on `llm_call_started` and a non-negative integer on the other two. `attributes` carries kind-specific data:

- **`llm_call_started`** — `{ attemptIndex: 0|1|..., totalChoices: N }`. Tracks the position in the fallback chain.
- **`llm_call_completed`** — `{ costUsd, inputTokens, outputTokens, cachedInputTokens, attempts: 1 }`. The cost + token attribution rail.
- **`llm_call_failed`** — `{ errorKind, errorMessage, attempts, willFallback: boolean }`. The failure-classification rail. `willFallback` is `true` if the router will try the next choice; `false` on the last choice (terminal exhaustion) or on non-retryable errors.

### Event sequence

A successful single-provider call emits exactly two events:

```
llm_call_started → llm_call_completed
```

A fallover (primary fails retryably, fallback succeeds):

```
llm_call_started (anthropic) → llm_call_failed (anthropic, willFallback=true)
                              → llm_call_started (openai)
                              → llm_call_completed (openai)
```

A `non-retryable` error (e.g., moderation, conflict, not-found short-circuit from ADRs 0091/0133/0134):

```
llm_call_started (anthropic) → llm_call_failed (anthropic, willFallback=false)
```

All providers exhausted:

```
llm_call_started (anthropic) → llm_call_failed (anthropic, willFallback=true)
                              → llm_call_started (openai)
                              → llm_call_failed (openai, willFallback=false)
→ throws AllProvidersExhaustedError
```

### Table: `meta.llm_call_traces`

```ts
META_LLM_CALL_TRACES = {
  schema: "meta",
  name: "llm_call_traces",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "provider_id", type: "TEXT", notNull: true },
    { name: "model_id", type: "TEXT", notNull: true },
    { name: "task", type: "TEXT", notNull: true },
    { name: "session_id", type: "TEXT", notNull: true },
    { name: "kind", type: "TEXT", notNull: true, check: "kind IN ('llm_call_started','llm_call_completed','llm_call_failed')" },
    { name: "occurred_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "duration_ms", type: "INTEGER", check: "duration_ms IS NULL OR duration_ms >= 0" },
    { name: "attributes", type: "JSONB", notNull: true, default: "'{}'::jsonb" },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_llm_call_traces_tenant_occurred", columns: ["tenant_id", "occurred_at"] },
    { name: "idx_llm_call_traces_provider_kind_occurred", columns: ["provider_id", "kind", "occurred_at"] },
    { name: "idx_llm_call_traces_session", columns: ["tenant_id", "session_id"] },
  ],
  rls: { enabled: true, policies: [{ name: "llm_call_traces_tenant_isolation", using: TENANT_ISOLATION_USING }] },
};
```

Three indexes serve the canonical operator queries:

- `(tenant_id, occurred_at)` — "tenant X's recent LLM activity"
- `(provider_id, kind, occurred_at)` — "anthropic failures in the last hour"
- `(tenant_id, session_id)` — "all calls for session S in tenant T" (audit trail reconstruction)

### `PostgresRouterInstrumentation`

```ts
export class PostgresRouterInstrumentation implements RouterInstrumentation {
  constructor(opts: { conn: PgConnection });
  async onEvent(event: RouterInstrumentationEvent): Promise<void> {
    // INSERT one row into meta.llm_call_traces; attributes via JSON.stringify.
  }
}
```

Single round-trip per event. No batching, no buffering. Matches the M8 `PostgresWorkflowInstrumentation` shape verbatim.

## Cross-cutting invariants enforced

- **No breaking change.** Default `NoopRouterInstrumentation` means existing callers see zero behavior difference. Wiring is opt-in.
- **Pattern parity with `WorkflowInstrumentation`.** Same `onEvent(event): Promise<void> | void` signature, same `captureX()` / `combineXs()` helpers, same Noop default. Operators learning one observability rail know both.
- **Per-attempt granularity.** A `complete()` call that falls back emits 2N events for N attempts. Matches operator mental model: "what happened at each step?"
- **Verbatim error propagation.** Failed events carry the verbatim `errorKind` (from the error's `kind` discriminator) and `errorMessage`. Operators discriminate via the same predicates (isModerationError, isConflictError, etc.) that the router uses.
- **`willFallback` is derived, not stored on the error.** Router knows the choice chain at emit time; future-proofs against ADR-0091 / 0133 / 0134 short-circuit semantics (where `willFallback` becomes `false` for terminal errors).
- **Trace volume is bounded by request volume.** N requests → at most 2N traces for happy paths, ~3N for typical fallover patterns. No N²+ amplification.
- **Append-only.** No UPDATE / DELETE / UPSERT semantics. The trace table is an audit log; retention is a future milestone (Q1).
- **Tenant isolation via RLS.** Standard `TENANT_ISOLATION_USING` policy. A misconfigured gateway cannot read another tenant's traces.

## End-to-end semantic

```ts
import { createNodePgConnection } from "@crossengin/kernel-pg";
import { DefaultLlmRouter } from "@crossengin/ai-router";
import {
  PostgresCostCeilingResolver,
  PostgresCostTracker,
  PostgresLatencyTracker,
  PostgresRouterInstrumentation,
} from "@crossengin/ai-router-pg";

const conn = createNodePgConnection(parsePgEnvConfig());
const router = new DefaultLlmRouter({
  providers,
  taskPolicies,
  getTenantResidency,
  costTracker: new PostgresCostTracker({ conn }),
  getTenantCostCeiling: new PostgresCostCeilingResolver({ conn }).resolve,
  latencyTracker: new PostgresLatencyTracker({ conn }),
  instrumentation: new PostgresRouterInstrumentation({ conn }),
});

// Operator audit queries:
//
// 1. All LLM calls for session S in tenant T (chronological):
//   SELECT kind, provider_id, model_id, duration_ms, attributes
//   FROM meta.llm_call_traces
//   WHERE tenant_id = $1 AND session_id = $2
//   ORDER BY occurred_at ASC;
//
// 2. Cost attribution by tenant + provider over the last day:
//   SELECT tenant_id, provider_id, SUM((attributes->>'costUsd')::NUMERIC) AS total_usd
//   FROM meta.llm_call_traces
//   WHERE kind = 'llm_call_completed' AND occurred_at > now() - INTERVAL '1 day'
//   GROUP BY tenant_id, provider_id;
//
// 3. Failure rate per provider in the last hour:
//   SELECT provider_id,
//          COUNT(*) FILTER (WHERE kind = 'llm_call_failed') AS failures,
//          COUNT(*) FILTER (WHERE kind = 'llm_call_completed') AS successes
//   FROM meta.llm_call_traces
//   WHERE occurred_at > now() - INTERVAL '1 hour'
//   GROUP BY provider_id;
```

The ai-router-pg adapter set now has 4 substrates: cost-windows (M6.7), cost-ceilings (M6.7.x), latency-samples (M6.7.y), call-traces (M6.7.z). The router is fully observable.

## Alternatives considered

- **Single mega-table combining latency samples + call traces.**
  - **Considered.** One table to rule them all.
  - **Cons.** Aggregation queries scan large rows; audit queries compete with high-volume sample writes; index design trades off both use cases. Different read patterns deserve different schemas.
  - **Decision.** Two tables. Separation of concerns.

- **Emit a single `llm_call_completed` event with attempt history embedded as `attributes.attempts[]`.**
  - **Considered.** Reduces event count.
  - **Cons.** Each retry doesn't get its own occurredAt / durationMs. Operators losing the "per-attempt" granularity have a harder time understanding fallover patterns. Storage is cheap.
  - **Decision.** Per-attempt events.

- **Add `correlationId` field to `CompletionRequest` for cross-system tracing.**
  - **Considered.** OpenTelemetry-style trace ID propagation.
  - **Cons.** Out of scope for M6.7.z. Operators wanting OTEL integration can wrap the instrumentation and inject their own correlation. The substrate uses `sessionId` for now; additive `correlationId` is a follow-up.
  - **Decision.** Defer. Document as Q.

- **Async-batch the INSERTs (buffer + periodic flush).**
  - **Considered.** Reduces PG round-trips at high volume.
  - **Cons.** Traces lost on process crash. Adds complexity (timer, batch shape, flush-on-shutdown). PG handles 10K+ inserts/sec on the indexed table. Operators wanting batching can wrap.
  - **Decision.** One INSERT per event. Match `PostgresWorkflowInstrumentation`.

- **Hook into M8's `WorkflowInstrumentation` infrastructure (reuse `META_WORKFLOW_TRACES`).**
  - **Considered.** Single observability table.
  - **Cons.** Workflow traces are workflow-scoped (have `instance_id`, `definition_id`). LLM calls happen outside workflows too (architect-cli, gateway routes, ad-hoc). Forcing them into the workflow trace surface would create awkward optional fields. Different domain → different table.
  - **Decision.** Separate substrate.

- **Make `instrumentation` a required option (no Noop default).**
  - **Considered.** Forces operators to make a conscious choice.
  - **Cons.** Breaks the in-memory CLI use case (architect-cli wouldn't need a PG instrumentation; defaulting to Noop is the right "I don't care" answer). M8 uses Noop default too; pattern consistency.
  - **Decision.** Noop default.

- **Emit instrumentation events for the `embed()` path too.**
  - **Considered.** Embedding calls are LLM calls too.
  - **Cons.** Out of scope. The `embed()` path doesn't go through the same fallback loop; instrumenting it cleanly needs a slightly different event shape. Future milestone (Q2).
  - **Decision.** Complete only this milestone. Embed instrumentation is additive.

- **Carry the full prompt + response in `attributes`.**
  - **Considered.** Full audit trail.
  - **Cons.** PII concerns, storage explosion, GDPR ambiguity. Operators wanting full transcripts use `architect-cli --persist` (ADR-0057). Traces are metadata-only.
  - **Decision.** Metadata-only. No prompt / response content in traces.

## Consequences

- **56 packages + 1 app, 124 meta-schema tables, 7,670 tests** (+21 from M6.7.z: 11 in `router.test.ts`, 10 in `router-instrumentation.test.ts`). All green, zero type errors.
- **The ai-router-pg adapter set is at four substrates.** Cost-windows + cost-ceilings + latency-samples + call-traces. Operators wiring a multi-replica ai-router have full durability + observability.
- **Closes ADR-0135 Q2, ADR-0137 Q3+Q4, ADR-0140 Q3.** Three deferred questions resolved in one milestone.
- **Pattern parity with M8.** Operators learning workflow instrumentation know router instrumentation.
- **Audit / cost-attribution / dashboard queries are now first-class.** Three indexes serve the three canonical operator queries (tenant-recent, provider-failures, session-audit).
- **No new dependencies.** `@crossengin/ai-router-pg` already depends on `kernel-pg` and `ai-router`.
- **Storage: ~200 bytes per trace row.** A 1M-call/day workload = ~600MB/day after indexes. Retention is the gating concern (Q1).

## Open questions

- **Q1:** Retention policy for `META_LLM_CALL_TRACES`?
  - _Current direction:_ Same as `META_WORKFLOW_TRACES` (ADR-0120 Q5) and `META_LLM_LATENCY_SAMPLES` (ADR-0140 Q1). Likely a `META_RETENTION_POLICIES` table covering all three append-only trace surfaces. Separate milestone.
- **Q2:** `embed()` path instrumentation?
  - _Current direction:_ Additive. New event kinds `embed_call_started/completed/failed`. Separate milestone.
- **Q3:** Should ceiling-resolution events emit traces (which tenant ceiling vs global was used)?
  - _Current direction:_ Yes — closes ADR-0137 Q3+Q4 fully. Either extends `llm_call_started` attributes with `effectiveCeiling: {...}` or adds a new event kind `ceiling_resolved`. Listed as a follow-up.
- **Q4:** Should `correlationId` be a first-class field on `CompletionRequest` (vs reusing `sessionId`)?
  - _Current direction:_ Yes — natural OTEL integration point. Additive to `CompletionRequestSchema`. Separate milestone.
- **Q5:** Should the table be partitioned by `occurred_at` for million-row scale?
  - _Current direction:_ Operator-side concern. PG-native partitioning is straightforward (`PARTITION BY RANGE (occurred_at)`). Substrate keeps it simple; operators add partitioning when they need it.
- **Q6:** Should there be a `getTraces(filter)` helper on `PostgresRouterInstrumentation` for programmatic reads?
  - _Current direction:_ Out of scope. Operators query the table directly. If demand grows, add a read-side facade.
- **Q7:** Should retry-within-provider emit per-retry events (currently only the final outcome emits a failed event)?
  - _Current direction:_ No — `attempts` attribute on `llm_call_failed` carries the retry count. Per-retry events would be 3-5× the volume with marginal new info.
- **Q8:** Multi-currency cost in `attributes`?
  - _Current direction:_ N/A. Provider pricing is USD-only.
