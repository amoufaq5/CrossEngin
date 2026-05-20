# ADR-0140: PostgresLatencyTracker + LatencyTracker contract async-ification (Phase 2 M6.7.y)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0059 (M6.5 ai-router), ADR-0135 (M6.7 PostgresCostTracker), ADR-0137 (M6.7.x per-tenant cost ceiling) |

## Context

`@crossengin/ai-router` exposes two trackers wired into `DefaultLlmRouter`: `CostTracker` (gated request budgets) and `LatencyTracker` (provider p50/p95 for routing decisions / dashboards). M6.7 (ADR-0135) made the cost tracker durable via `PostgresCostTracker`. M6.7.x (ADR-0137) added per-tenant cost ceilings via `PostgresCostCeilingResolver`. The remaining tracker — latency — is still in-memory only.

The pain without a persisted latency tracker:

1. **Multi-replica gateway loses provider health signals on every redeploy.** Three replicas each track their own samples; restart wipes the whole picture.
2. **No cross-replica view of provider health.** Replica A might be seeing Anthropic timeouts while Replica B reports p50=200ms. Operators have to aggregate manually.
3. **Operator dashboards can't query historical latency.** "Was Anthropic slow last Tuesday?" — currently un-answerable.

The substrate that closes this is symmetric with M6.7: a `@crossengin/ai-router-pg` adapter + a new meta-schema table.

## Decision

Three changes:

1. **Make the `LatencyTracker` interface async.** `record()` returns `Promise<void>`. `stats()` returns `Promise<LatencyStats>`. Both `InMemoryLatencyTracker` (existing) and `PostgresLatencyTracker` (new) implement it.
2. **`META_LLM_LATENCY_SAMPLES` table (123rd).** Append-only sample log. No tenant scoping (provider-level observability, not per-tenant). Indexed `(provider_id, recorded_at DESC)` for the "last N samples per provider" window query.
3. **`PostgresLatencyTracker` in `@crossengin/ai-router-pg`.** Same `LatencyTracker` contract. `record` issues one INSERT; `stats` issues one windowed SELECT with PG's native `percentile_cont` aggregate.

### Why async the interface?

The existing sync `record(): void` and `stats(): LatencyStats` are fundamentally incompatible with PG. Two options were on the table:

- **(a) Fire-and-forget INSERT in `record()`, sync-impossible stats.** `record()` queues PG call, returns void immediately. `stats()` returns a cached snapshot. The PostgresLatencyTracker maintains its own rolling in-memory window AND writes to PG asynchronously. Complex.
- **(b) Make both async.** Single clean contract. Router `await`s record (1-2 awaits per `complete()` call). PG INSERT is sub-millisecond; ~1ms overhead per LLM request (which itself takes hundreds of ms). Acceptable.

We picked (b). The async contract is consistent with `CostTracker` (already async). The performance cost is bounded and visible — operators choosing PG persistence understand the round-trip.

### Table: `meta.llm_latency_samples`

```ts
export const META_LLM_LATENCY_SAMPLES: TableDefinition = {
  schema: "meta",
  name: "llm_latency_samples",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "provider_id", type: "TEXT", notNull: true },
    {
      name: "latency_ms",
      type: "INTEGER",
      notNull: true,
      check: "latency_ms >= 0",
    },
    { name: "success", type: "BOOLEAN", notNull: true },
    { name: "recorded_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_llm_latency_samples_provider_recorded",
      columns: ["provider_id", "recorded_at"],
    },
  ],
};
```

- **No tenant_id, no RLS.** Latency is a provider-level signal, not tenant-scoped. Operators wanting per-tenant breakdowns add tenant columns in a follow-up (paired with the LatencyTracker contract extension).
- **Append-only.** No UPSERTs, no overwrites. The table grows linearly with LLM request volume — retention is a future milestone (Q1 below).
- **`uuid_generate_v7()` for `id`.** Lex-orderable UUIDs serve as a natural insertion timestamp + deterministic primary key.
- **Composite index `(provider_id, recorded_at)`.** Drives the windowed SELECT. PG's index-only scans handle the typical "last 100 anthropic samples" lookup in microseconds even at millions of rows.

### PostgresLatencyTracker

```ts
export class PostgresLatencyTracker implements LatencyTracker {
  constructor(opts: { conn: PgConnection; windowSize?: number });

  async record(input: {
    providerId: string;
    latencyMs: number;
    success: boolean;
  }): Promise<void> {
    // INSERT INTO meta.llm_latency_samples (provider_id, latency_ms, success) VALUES (...)
  }

  async stats(providerId: string): Promise<LatencyStats> {
    // WITH recent AS (
    //   SELECT latency_ms, success FROM meta.llm_latency_samples
    //   WHERE provider_id = $1 ORDER BY recorded_at DESC LIMIT $2
    // )
    // SELECT COUNT(*), COUNT(*) FILTER (WHERE success), COUNT(*) FILTER (WHERE NOT success),
    //        percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms),
    //        percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
    // FROM recent
  }
}
```

The `stats` query is a single round-trip even at millions of rows: the CTE limits to `windowSize` samples (default 100), then aggregates within PG. No data transferred beyond the 5-value result row.

`percentile_cont` is a **continuous** percentile interpolator. For small windows it returns interpolated values (e.g., 9 samples → p50 is the average of indices 4 and 5). This is slightly different from the in-memory tracker which uses `floor(N * p)` index selection. The difference is observably nil for window sizes >= 20 (the common case).

## Cross-cutting invariants enforced

- **Same `LatencyTracker` contract for InMemory + Postgres.** Drop-in substitution.
- **No breaking change for the router.** The router already calls `latencyTracker.record(...)` in two spots; M6.7.y simply adds `await`.
- **No breaking change for `architect-cli`.** `InMemoryLatencyTracker()` continues to work as before — the only difference is its method signatures are now async, but it's used internally by the router which awaits.
- **Append-only history.** Latency samples are never deleted by the tracker. Operators run retention jobs externally (Q1).
- **Index-driven reads.** The `(provider_id, recorded_at)` index serves every `stats` query.
- **No tenant scoping (yet).** Provider-level only. Adding tenant comes paired with an interface change (Q2).
- **PG `percentile_cont` ≈ in-memory percentile**. Continuous interpolation differs only for tiny windows; semantically equivalent at production scale.

## End-to-end semantic

```ts
import { createNodePgConnection } from "@crossengin/kernel-pg";
import { DefaultLlmRouter } from "@crossengin/ai-router";
import {
  PostgresCostCeilingResolver,
  PostgresCostTracker,
  PostgresLatencyTracker,
} from "@crossengin/ai-router-pg";

const conn = createNodePgConnection(parsePgEnvConfig());
const router = new DefaultLlmRouter({
  providers,
  taskPolicies,
  getTenantResidency,
  costTracker: new PostgresCostTracker({ conn }),
  getTenantCostCeiling: new PostgresCostCeilingResolver({ conn }).resolve,
  latencyTracker: new PostgresLatencyTracker({ conn, windowSize: 200 }),
});

// Operator dashboard query:
//   SELECT provider_id,
//          COUNT(*) AS calls,
//          percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
//          percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
//          COUNT(*) FILTER (WHERE NOT success)::FLOAT / COUNT(*) AS failure_rate
//   FROM meta.llm_latency_samples
//   WHERE recorded_at > now() - INTERVAL '1 hour'
//   GROUP BY provider_id;
```

The ai-router-pg adapter set is now complete: cost-windows, cost-ceilings, latency-samples. Three of the three trackers are persistable.

## Alternatives considered

- **Keep `record()` sync via fire-and-forget INSERT.**
  - **Considered.** Avoids router-side awaits.
  - **Cons.** Silent failures, unbounded queue if PG is degraded, inconsistency with the async `CostTracker` contract. The 1ms overhead per LLM request is negligible compared to the LLM call itself.
  - **Decision.** Both methods async. Consistency wins.

- **Sample-batched flush (record buffers locally, flush every N records or T ms).**
  - **Considered.** Reduces PG INSERT volume at high throughput.
  - **Cons.** Latency samples lost on process crash. Adds complexity (timer, batch shape, flush-on-shutdown). Operators wanting batched ingestion can wrap the tracker. PG handles 10K+ inserts/sec on a single connection.
  - **Decision.** Direct INSERT per sample. Simple. Add batching as an additive Q later.

- **Per-tenant latency samples (`tenant_id` column).**
  - **Considered.** Some operators want "anthropic latency for tenant X."
  - **Cons.** Requires changing the `LatencyTracker.record(...)` signature to include `tenantId`. Out of scope. Adding the column later is additive: `ALTER TABLE ... ADD COLUMN tenant_id UUID` (NULLABLE → backfill optional).
  - **Decision.** Provider-level only this milestone. Q2 documents the extension path.

- **Time-window aggregate cache (precomputed p50/p95 per provider per minute).**
  - **Considered.** `stats()` becomes a single-row read of a materialized aggregate.
  - **Cons.** Stale data, complex invalidation, materialized-view rebuild overhead. PG's `percentile_cont` over 100 rows is microseconds — the cache is premature optimization.
  - **Decision.** Live query. Materialize if dashboard load justifies it later.

- **Use TimescaleDB hypertable for the latency table.**
  - **Considered.** Time-series-native storage, automatic chunking.
  - **Cons.** Adds an extension dependency. The substrate is Postgres-only. Operators wanting time-series can wire their own via the same table; CrossEngin core doesn't depend on extensions beyond what kernel-pg currently uses (uuid-ossp, pgcrypto, etc.).
  - **Decision.** Plain Postgres.

- **Skip async-ification: provide a sync wrapper that throws "stats() is async; use statsAsync()".**
  - **Considered.** Backward-compat.
  - **Cons.** Two surfaces, runtime error opportunity, doesn't fix the underlying mismatch. Clean break is simpler.
  - **Decision.** One async surface. Internal-only contract; the change is mechanical for the only consumer (the router).

- **Use a window of samples by TIME (e.g., last 5 minutes) instead of COUNT.**
  - **Considered.** Real-time-window semantic.
  - **Cons.** Requires a `now()` parameter at query time (or clock injection). Sample count is more predictable at variable LLM-call rates. Aligns with the in-memory `windowSize` semantic.
  - **Decision.** Sample-count window. Future enhancement could add `windowSeconds`.

## Consequences

- **56 packages + 1 app, 123 meta-schema tables, 7,649 tests** (+12 from M6.7.y: all in `latency-tracker.test.ts`). All green, zero type errors.
- **The ai-router-pg adapter set is complete.** Three substrates: PostgresCostTracker (M6.7), PostgresCostCeilingResolver (M6.7.x), PostgresLatencyTracker (M6.7.y). Operators wiring an ai-router for multi-replica deployments have a fully-persistent stack.
- **Provider health is now queryable across restarts + replicas.** Operator dashboards can answer "what's anthropic's p95 over the last hour?" with a single SELECT.
- **LatencyTracker contract is async.** Internal-only breaking change. InMemoryLatencyTracker upgraded transparently. Router upgraded with two `await`s.
- **No new dependencies.** `@crossengin/ai-router-pg` depends only on `@crossengin/ai-router` (types) + `@crossengin/kernel-pg` (PgConnection). PG's `percentile_cont` is built-in.
- **Append-only growth.** Sample table grows linearly with request volume. Retention is a follow-up (~M6.7.y.1).

## Open questions

- **Q1:** Should there be a retention policy (e.g., delete samples older than 30 days)?
  - _Current direction:_ Yes — natural next milestone. Either a `PG retention job in `@crossengin/ai-router-pg`, or a generic `META_RETENTION_POLICIES` table. Separate ADR.
- **Q2:** Should the `LatencyTracker.record` API accept `tenantId` for per-tenant breakdowns?
  - _Current direction:_ Probably yes — useful for SLO dashboards. Additive change: `record({providerId, latencyMs, success, tenantId?: string})`. Add column `tenant_id` to the table. Listed for a follow-up.
- **Q3:** Should there be a `RouterInstrumentation` rail that emits per-LLM-call traces (kind=llm_call_completed) carrying full attribution including cost + tokens + tenant?
  - _Current direction:_ Yes — M6.7.z. Separate substrate from latency samples. Latency samples are aggregation-optimized; instrumentation traces are audit-optimized. Different read patterns.
- **Q4:** Should `stats()` also expose p99 and p999 (current contract is p50 + p95 only)?
  - _Current direction:_ Maybe — operators monitoring tail latency want p99. Additive change to `LatencyStats` (new optional fields). Separate milestone or paired with the next router enhancement.
- **Q5:** Should the table track `model_id` too (not just `provider_id`)?
  - _Current direction:_ Probably yes — different Claude models have different latency profiles. Additive: `ALTER TABLE ... ADD COLUMN model_id TEXT`. Listed for follow-up.
- **Q6:** Should `stats()` support a time-bound query (e.g., last 5 minutes) in addition to sample-count?
  - _Current direction:_ Future feature. Operators query the table directly today.
- **Q7:** Failure rate as a stat field?
  - _Current direction:_ Operators can compute from `failures / samples`. Adding `failureRate: number` is additive — listed as a Q.
- **Q8:** Should the tracker drop samples in shed-mode when PG is degraded (rather than blocking the router)?
  - _Current direction:_ Out of scope. Operators wanting circuit-breaker behavior wrap the tracker.
