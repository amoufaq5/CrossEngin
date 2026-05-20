# ADR-0135: PostgresCostTracker — first persisted ai-router cost accumulator (Phase 2 M6.7)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0059 (M6.5 ai-router), ADR-0006 (LLM provider router), ADR-0132 (M8.1 activity execution instrumentation) |

## Context

`@crossengin/ai-router` ships an `InMemoryCostTracker` (ADR-0059 / M6.5) that maintains a per-tenant tumbling window with `recordUsage()` + `getWindow()` + `checkCeiling()`. The in-memory adapter is sufficient for unit tests, single-process CLIs, and short-lived workers. It is **not** sufficient for:

1. **Multi-process gateway deployments.** Three replicas of the gateway each running their own `InMemoryCostTracker` produce three independent windows; cost ceilings under-enforce 3×.
2. **Cross-restart durability.** When the gateway recycles, the in-memory window resets to zero — a tenant whose `maxUsdPerWindow=100` was at `$99.50` can suddenly burn another `$100` in the new window.
3. **Operator observability.** No external surface inspects "what is tenant X's current per-window cost?" beyond the live process state.

ADR-0059 explicitly deferred this:

> Persistence of cost windows is an open question. M6.5 ships in-memory only; a Postgres-backed adapter will follow once the runtime contracts settle.

The runtime contracts have settled. M6.5/M6.6 are stable. M8.1 (ADR-0132) made cost-attribution traces queryable (activity instrumentation has `durationMs` + tenant-scoped traces). The activity-instrumentation rail is ready for a real `PostgresCostTracker`. M6.7 ships that adapter.

## Decision

Two changes:

1. **Add `META_LLM_COST_WINDOWS` to the kernel meta-schema.** One row per tenant carrying `(window_start_at, window_cost_usd, updated_at)`. Tenant-scoped (RLS enabled). `tenant_id` is the natural primary key.
2. **Create `@crossengin/ai-router-pg` package with `PostgresCostTracker`.** Implements the same `CostTracker` interface as `InMemoryCostTracker`; same contract, same semantics, persisted state.

### Table: `meta.llm_cost_windows`

```ts
export const META_LLM_COST_WINDOWS: TableDefinition = {
  schema: "meta",
  name: "llm_cost_windows",
  columns: [
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "window_start_at", type: "TIMESTAMPTZ", notNull: true },
    {
      name: "window_cost_usd",
      type: "NUMERIC(18,8)",
      notNull: true,
      check: "window_cost_usd >= 0",
    },
    { name: "updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["tenant_id"],
  rls: {
    enabled: true,
    policies: [
      { name: "llm_cost_windows_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};
```

- **`tenant_id` PK** — natural key. One window per tenant. UPSERT semantics.
- **`NUMERIC(18,8)`** — 10 integer + 8 fractional digits. Handles a `$10,000,000` per-window cap with sub-cent precision. Avoids `DOUBLE PRECISION` float-rounding for accumulated cost.
- **`window_cost_usd >= 0`** — invariant; cost is never negative.
- **No `id`, no auditing FK chains.** Operator audit lives in workflow traces (ADR-0132) and is a separate concern.

### Package: `@crossengin/ai-router-pg`

```ts
export class PostgresCostTracker implements CostTracker {
  constructor(opts: {
    conn: PgConnection;
    windowSeconds?: number;  // default 86_400
    clock?: () => number;    // default Date.now
  });

  async getWindow(tenantId: string): Promise<CostUsageWindow | null>;
  async recordUsage(input: { tenantId: string; costUsd: number }): Promise<void>;
  async checkCeiling(input: {...}): Promise<CostCeilingCheck>;
}
```

#### `recordUsage` — atomic UPSERT with expiry-roll

```sql
INSERT INTO meta.llm_cost_windows
  (tenant_id, window_start_at, window_cost_usd, updated_at)
VALUES ($1, to_timestamp($2 / 1000.0), $3, now())
ON CONFLICT (tenant_id) DO UPDATE
  SET window_start_at = CASE
        WHEN ($2 - EXTRACT(EPOCH FROM meta.llm_cost_windows.window_start_at) * 1000) >= $4
        THEN EXCLUDED.window_start_at
        ELSE meta.llm_cost_windows.window_start_at
      END,
      window_cost_usd = CASE
        WHEN ($2 - EXTRACT(EPOCH FROM meta.llm_cost_windows.window_start_at) * 1000) >= $4
        THEN EXCLUDED.window_cost_usd
        ELSE meta.llm_cost_windows.window_cost_usd + EXCLUDED.window_cost_usd
      END,
      updated_at = now()
```

Single round-trip. The expiry check (`$2 - existing.window_start_ms >= windowMs`) decides whether to reset the window or increment it — entirely in SQL. Race-free under concurrent writers.

#### `getWindow` — single SELECT with TS-side expiry check

```sql
SELECT (EXTRACT(EPOCH FROM window_start_at) * 1000)::BIGINT AS window_start_ms,
       window_cost_usd::TEXT AS window_cost_usd
FROM meta.llm_cost_windows
WHERE tenant_id = $1
```

TypeScript-side check: if `now - window_start_ms >= windowSeconds * 1000`, return `null` (treat as no window). Mirrors the in-memory `isExpired` semantic exactly.

#### `checkCeiling` — same logic as `InMemoryCostTracker`

Per-request gate first (no DB hit when over per-request cap). Window gate second (one SELECT). No DB writes during the check itself.

## Cross-cutting invariants enforced

- **Same `CostTracker` contract as `InMemoryCostTracker`.** Drop-in substitution — `new DefaultLlmRouter({ ..., costTracker: new PostgresCostTracker({ conn }) })` works without other code changes.
- **Same tumbling-window semantic.** When the first request arrives after the window expires, the window resets to "now". Not a sliding window.
- **Clock injection.** Identical to `InMemoryCostTracker` — `clock` defaults to `Date.now` but is overridable for tests. The clock is the source of truth for "now"; PG `now()` is only used for the `updated_at` timestamp (auditing convenience).
- **No transactions needed.** Each `recordUsage` is a single UPSERT — PG atomically applies the ON CONFLICT branch. Concurrent `recordUsage` calls from multiple gateway replicas safely increment.
- **No new dependencies.** `@crossengin/ai-router-pg` depends only on `@crossengin/ai-router` (for types) + `@crossengin/kernel-pg` (for PgConnection).
- **Tenant isolation via RLS.** The table has the standard `TENANT_ISOLATION_USING` policy. Even a misconfigured gateway can't read another tenant's window if RLS is enforced on the connection.
- **`NUMERIC` precision preserved.** `window_cost_usd::TEXT` round-trips to TS as a string, parsed via `Number()`. Sub-cent precision retained.

## End-to-end semantic

```ts
import { createNodePgConnection } from "@crossengin/kernel-pg";
import { DefaultLlmRouter } from "@crossengin/ai-router";
import { PostgresCostTracker } from "@crossengin/ai-router-pg";

const conn = createNodePgConnection(parsePgEnvConfig());
const router = new DefaultLlmRouter({
  providers,
  taskPolicies,
  getTenantResidency,
  costTracker: new PostgresCostTracker({ conn, windowSeconds: 86_400 }),
  costCeiling: { maxUsdPerWindow: 100.0, maxUsdPerRequest: 5.0 },
});

// Three gateway replicas now share a single durable cost window per tenant.
for await (const chunk of router.complete(req)) {
  // ...
}
```

Operator query: "what is tenant X's current per-window cost?"

```sql
SELECT window_cost_usd
FROM meta.llm_cost_windows
WHERE tenant_id = 'tenant-uuid'
  AND (EXTRACT(EPOCH FROM now()) - EXTRACT(EPOCH FROM window_start_at)) < 86400;
```

## Alternatives considered

- **Per-event ledger table (append-only `META_LLM_USAGE_EVENTS`).**
  - **Considered.** Each LLM call inserts one row; the "current window cost" is a `SUM(cost_usd) WHERE tenant_id = $1 AND occurred_at > now() - interval '86400 seconds'` aggregation.
  - **Pros.** Full auditability; per-request observability built-in.
  - **Cons.** Every `checkCeiling` becomes an aggregation query (full window scan, even with an index). At 100 calls/sec per tenant, the aggregate is expensive vs the single-row read of the UPSERT approach. Operators wanting per-request observability already have workflow traces (ADR-0132); cost-attribution rows would duplicate. Adding the aggregate later is an additive ADR.
  - **Decision.** Single-row window state. Per-event observability is a separate concern.

- **Use `meta.workflow_traces` (M8) as the cost ledger.**
  - **Considered.** `workflow_traces` already has `attributes` JSONB — operator could put `{ "costUsd": 0.1 }` in the activity_completed trace, aggregate from there.
  - **Cons.** Workflow traces are workflow-scoped, not ai-router-scoped. Many LLM calls happen outside the workflow runtime (architect-cli, gateway routes, direct calls). Cost would need a parallel ai-router trace event — that's a separate proposal. M6.7 is the simplest "make the existing CostTracker contract persisted" milestone.
  - **Decision.** Keep separate. A future "router instrumentation" milestone could wire ai-router into `workflow_traces` or a sibling table.

- **Redis instead of Postgres.**
  - **Considered.** Redis INCR + TTL is the canonical multi-replica counter pattern.
  - **Cons.** Adds a new dependency outside the substrate. CrossEngin's persistence story is Postgres-only; adding Redis as the cost rail breaks that. The UPSERT in Postgres is fast enough (single-row write to a small PK-indexed table).
  - **Decision.** Postgres. Redis is not part of the substrate.

- **Add `costCeiling` as a tenant-scoped table (not just an in-process router config).**
  - **Considered.** Ceilings are operator policy; storing them per-tenant in a `META_LLM_COST_CEILINGS` table would let operators raise/lower ceilings without redeploying.
  - **Cons.** Out of scope for M6.7. The current API takes `costCeiling` at router-construction time; reading per-tenant ceilings is a follow-up. Listed in open questions.
  - **Decision.** Single-row window state only this milestone.

- **Make the table `instance_id`-scoped (workflow-instance-scoped) instead of tenant-scoped.**
  - **Considered.** Workflows have natural cost boundaries (one workflow = one budget envelope).
  - **Cons.** Many LLM calls don't have a workflow context (REPL chats, validation calls, ad-hoc agents). Tenant scope captures all of them; workflow scope captures only a subset.
  - **Decision.** Tenant scope. A workflow-cost track is a separate proposal.

- **Use `BIGINT` (epoch ms) instead of `TIMESTAMPTZ` for `window_start_at`.**
  - **Considered.** Match the in-memory representation directly.
  - **Cons.** Loses PG-native time arithmetic and breaks the audit-tooling convention (every other timestamp column is `TIMESTAMPTZ` with `now()` defaults). Encoded conversion at the boundary (`to_timestamp($2 / 1000.0)` + `EXTRACT(EPOCH FROM ...) * 1000`) is the cost.
  - **Decision.** `TIMESTAMPTZ` for consistency with the rest of the schema.

- **Skip the package; put `PostgresCostTracker` directly in `@crossengin/ai-router`.**
  - **Considered.** Avoids one new package.
  - **Cons.** Breaks the established `X` / `X-pg` separation (kernel/kernel-pg, workflow-runtime/workflow-runtime-pg, api-gateway-runtime/api-gateway-pg, ai-architect/ai-architect-pg). The contract package must remain free of `pg` dependencies for CLI / test consumers.
  - **Decision.** New `@crossengin/ai-router-pg` package.

## Consequences

- **56 packages + 1 app, 121 meta-schema tables, 7,569 tests** (+18 from M6.7: all in `cost-tracker.test.ts`). All green, zero type errors.
- **First persisted ai-router substrate.** The ai-router can now share cost state across replicas + survive restarts.
- **ADR-0059's deferred-Q (cost-tracker persistence) closed.**
- **Pattern set for future ai-router PG adapters.** When the latency-tracker needs persistence, `@crossengin/ai-router-pg` is the natural home for `PostgresLatencyTracker`.
- **CrossEngin Operate gateway can now enforce ceiling globally.** Three replicas, one cost view per tenant.
- **Operator observability surface added.** `SELECT * FROM meta.llm_cost_windows` is now a primitive for dashboards.
- **Audit invariant preserved.** Tenant isolation via RLS on the new table.

## Open questions

- **Q1:** Should there be a per-tenant `META_LLM_COST_CEILINGS` table so operators can adjust ceilings without redeploying?
  - _Current direction:_ Yes — a natural next milestone (M6.8?). Schema: `(tenant_id, max_usd_per_request, max_usd_per_window, window_seconds, effective_from)`. `PostgresCostTracker` would read it once per `recordUsage` (or cached). Separate ADR.
- **Q2:** Should `recordUsage` emit an event into a router-scoped instrumentation channel (like M8's `WorkflowInstrumentation`)?
  - _Current direction:_ Likely yes — operators want per-LLM-call traces for cost attribution. A `RouterInstrumentation` interface mirroring `WorkflowInstrumentation` (M8/M8.1) is a separate milestone.
- **Q3:** Should there be a periodic compaction job for old windows (where `now - updated_at > N days`)?
  - _Current direction:_ Probably yes — the table grows by one row per tenant forever (cap on size: `tenants` count, but rows for inactive tenants stay around). A retention job is small. Listed as M6.7.x.
- **Q4:** Should the per-request gate (`maxUsdPerRequest`) be configurable per-tenant alongside per-window?
  - _Current direction:_ Yes, paired with Q1. Same table, same migration.
- **Q5:** Should `getWindow` filter expired rows in SQL (not in TS)?
  - _Current direction:_ Either works. TS-side keeps the SQL simpler and the test surface smaller. SQL-side would require `WHERE (now()::TIMESTAMPTZ - window_start_at) < INTERVAL` with `now()` calls. Defer.
- **Q6:** Multi-currency support — `cost_usd` is USD-only by name.
  - _Current direction:_ ai-router pricing is USD-only across all three providers (Anthropic, OpenAI, Bedrock); no immediate need. If multi-currency arrives, add a `cost_currency` column with a default of `'USD'` (additive migration).
- **Q7:** Per-model / per-task cost breakdowns (vs lumped tenant total)?
  - _Current direction:_ Out of scope. Breakdowns belong to a `META_LLM_USAGE_EVENTS` ledger (Q2 above) or to a future `RouterInstrumentation` rail.
- **Q8:** Should the table be hash-sharded for very-high-throughput tenants?
  - _Current direction:_ No. The UPSERT contention is per-tenant; one tenant doing 10k QPS would hit row-level locks, but that's a real signal the per-tenant model is undersized — not a sharding problem. Sharding would scatter the single-row-per-tenant invariant.
