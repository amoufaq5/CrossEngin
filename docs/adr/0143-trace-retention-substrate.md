# ADR-0143: META_RETENTION_POLICIES + PostgresTraceRetention — cross-cutting trace retention substrate (Phase 2 M6.7.zz)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0120 (M8 workflow instrumentation), ADR-0140 (M6.7.y PostgresLatencyTracker), ADR-0141 (M6.7.z RouterInstrumentation), ADR-0132 (M8.1 workflow activity instrumentation) |

## Context

Three append-only trace tables have shipped across the recent milestones:

- `META_WORKFLOW_TRACES` (M8 / ADR-0120) — workflow lifecycle events.
- `META_LLM_LATENCY_SAMPLES` (M6.7.y / ADR-0140) — per-provider latency samples.
- `META_LLM_CALL_TRACES` (M6.7.z / ADR-0141) — per-LLM-call audit traces.

Each table grows linearly with workload. At 1M LLM calls/day, `llm_call_traces` adds ~600MB/day after indexes. Without retention, the substrate becomes unworkable within months.

Each of the three ADRs explicitly deferred retention to a follow-up:

- ADR-0120 Q5: "Should there be a periodic compaction job for old workflow_traces?"
- ADR-0140 Q1: "Should there be a retention policy (e.g., delete samples older than 30 days)?"
- ADR-0141 Q1: "Retention policy for META_LLM_CALL_TRACES?"

All three Qs converged on the same answer: a unified retention substrate. M6.7.zz delivers it.

## Decision

Two additions: one meta-schema table + one PG adapter.

### Table: `meta.retention_policies`

```ts
export const META_RETENTION_POLICIES: TableDefinition = {
  schema: "meta",
  name: "retention_policies",
  columns: [
    {
      name: "table_name",
      type: "TEXT",
      notNull: true,
      check: "table_name IN ('workflow_traces', 'llm_latency_samples', 'llm_call_traces')",
    },
    {
      name: "retention_days",
      type: "INTEGER",
      notNull: true,
      check: "retention_days >= 1",
    },
    { name: "enabled", type: "BOOLEAN", notNull: true, default: "true" },
    { name: "last_pruned_at", type: "TIMESTAMPTZ" },
    { name: "updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["table_name"],
};
```

- **`table_name` PK** — one policy per table. UPSERT semantics.
- **CHECK constraint on `table_name`** — the DB rejects unknown table values at INSERT/UPDATE time. The allowlist is the source of truth.
- **`retention_days >= 1`** — zero days would delete everything immediately. Operators wanting "no retention" disable the policy via `enabled = false`.
- **`enabled` kill switch** — quick disable without losing the configured retention value.
- **`last_pruned_at` nullable** — NULL = never pruned. Audit value.
- **No tenant scoping, no RLS.** Retention is a platform-policy concern. Per-tenant retention is a future Q.

### Adapter: `PostgresTraceRetention` in `@crossengin/kernel-pg`

```ts
export class PostgresTraceRetention {
  constructor(opts: { conn: PgConnection; clock?: () => number });
  async listPolicies(): Promise<ReadonlyArray<RetentionPolicyRow>>;
  async prune(): Promise<ReadonlyArray<RetentionRunResult>>;
  static knownPrunableTables(): ReadonlyArray<string>;
}
```

The `prune()` method:

1. Reads all rows from `META_RETENTION_POLICIES` (ordered by table name).
2. For each row:
   - If `enabled === false`: skip with `status: "skipped_disabled"`.
   - If `tableName` not in the hardcoded `PRUNABLE_TABLES` map: skip with `status: "skipped_unknown_table"` (defense-in-depth; DB CHECK catches first).
   - Otherwise: compute `cutoffMs = clock() - retentionDays * 86_400_000`, issue `DELETE FROM meta.{tableName} WHERE {timeColumn} < to_timestamp($1 / 1000.0)`, then update `last_pruned_at`.
3. Returns the per-table result list.

### Why `kernel-pg`?

The retention adapter could live in `ai-router-pg` (since 2 of 3 tables are ai-router), but `workflow_traces` is from `workflow-runtime-pg`. Putting it in either domain package would create a cross-package dependency that violates layering.

`kernel-pg` is the natural home:

- It already owns the foundational Postgres infrastructure (`PgConnection`, applier, introspection).
- The retention adapter operates on meta-schema tables, and the meta-schema is defined in `@crossengin/kernel`.
- The hardcoded prunable-table map (`workflow_traces` → `occurred_at`, etc.) is operational config — not domain logic.

Adding a new trace surface (e.g., a future `meta.security_audit_traces`) requires two edits: the CHECK constraint in `META_RETENTION_POLICIES` and the `PRUNABLE_TABLES` map in `trace-retention.ts`. Both are mechanical.

### Why hardcoded allowlist (vs dynamic time-column from policy row)?

Two options were on the table:

- **Hardcoded map in the adapter (chosen).** `workflow_traces → occurred_at`, etc.
- **Dynamic `time_column` column on the policy row.** Operators configure both.

The hardcoded approach wins on safety:

- **No SQL injection.** The table name AND column name come from the adapter's static map, not the row.
- **Schema knowledge stays in code.** Operators don't need to know that `latency_samples` uses `recorded_at` while `workflow_traces` uses `occurred_at`.
- **Defense-in-depth.** The DB CHECK constraint validates `table_name`, the adapter validates that AGAIN against its own map. Two layers of "is this safe to prune?"

The defensive `status: "skipped_unknown_table"` path catches a row that somehow bypassed the CHECK constraint (e.g., schema migration in progress, manual data insertion).

## Cross-cutting invariants enforced

- **No silent destructive ops.** The adapter only fires DELETE against tables explicitly in its allowlist. A new trace table doesn't get pruned until the adapter and CHECK constraint are both updated.
- **Static SQL string assembly.** Even though table + column names are interpolated, both values come from the hardcoded map — not from runtime data.
- **`retention_days >= 1` enforced.** No accidental "delete everything" via a zero retention.
- **Per-policy audit via `last_pruned_at`.** Operators can verify "when was retention last run for table X?"
- **Per-policy kill switch via `enabled`.** Toggle without losing configuration.
- **No tenant_id, no RLS.** Platform-policy concern. Per-tenant retention is a future Q.
- **Clock injection for testability.** Tests inject deterministic clocks; production uses `Date.now`.
- **Single transaction per policy is NOT required.** The adapter is idempotent — re-running prune() is safe (subsequent calls just find fewer rows to delete).

## End-to-end semantic

```ts
import { createNodePgConnection } from "@crossengin/kernel-pg";
import { PostgresTraceRetention } from "@crossengin/kernel-pg";

const conn = createNodePgConnection(parsePgEnvConfig());

// One-time policy setup (e.g., via migration or admin tool):
await conn.query(
  `INSERT INTO meta.retention_policies (table_name, retention_days, enabled)
   VALUES ('workflow_traces', 90, true),
          ('llm_latency_samples', 30, true),
          ('llm_call_traces', 365, true)
   ON CONFLICT (table_name) DO UPDATE
     SET retention_days = EXCLUDED.retention_days,
         enabled = EXCLUDED.enabled,
         updated_at = now()`,
);

// Periodic prune (cron, scheduler, or workflow):
const retention = new PostgresTraceRetention({ conn });
const results = await retention.prune();
for (const result of results) {
  console.log(
    `${result.tableName}: ${result.status} (deleted ${result.deletedCount.toString()})`,
  );
}

// Operator dashboard query:
//   SELECT table_name, retention_days, enabled, last_pruned_at,
//          now() - last_pruned_at AS time_since_prune
//   FROM meta.retention_policies;
```

The three trace substrates from M8 + M6.7.y + M6.7.z now have a unified retention story.

## Alternatives considered

- **Per-package retention (one adapter per trace table).**
  - **Considered.** `WorkflowTraceRetention` in `workflow-runtime-pg`, `LlmTraceRetention` in `ai-router-pg`.
  - **Cons.** Duplicated machinery (policy reads, time-column logic, audit updates). Operators wiring three separate cron jobs. No central "what's the retention status across all trace tables?" view.
  - **Decision.** Single substrate.

- **Dynamic time-column from policy row.**
  - **Considered.** `time_column TEXT NOT NULL` on the policy row.
  - **Cons.** SQL-injection risk if the column name is wrong. Operators have to know schema details. Defense-in-depth lost. See "Why hardcoded allowlist" above.
  - **Decision.** Hardcoded map.

- **Use a `META_RETENTION_HISTORY` table for per-run audit logs.**
  - **Considered.** Each prune() writes one row per processed policy.
  - **Cons.** Out of scope for M6.7.zz. `last_pruned_at` covers the most common audit need ("when did retention last run?"). Full per-run history is a future Q.
  - **Decision.** No history table. `last_pruned_at` is enough.

- **Soft-delete (set `deleted_at` instead of physical DELETE).**
  - **Considered.** Preserves data for recovery; physical purge can be a second-stage job.
  - **Cons.** Defeats the purpose (storage cost). Operators wanting recovery use PG point-in-time recovery or table-level backups. The trace tables are observability, not source-of-truth.
  - **Decision.** Physical DELETE.

- **Transactional prune (one transaction across all policies).**
  - **Considered.** Atomic "all-or-nothing" run.
  - **Cons.** A long-running prune holds locks on all three tables. Per-policy autonomy (one prune can succeed while another fails) is more operationally friendly.
  - **Decision.** No outer transaction. Each policy is independent.

- **Use PG's pg_cron extension for scheduling.**
  - **Considered.** No external scheduler needed.
  - **Cons.** Adds an extension dependency. CrossEngin substrate is Postgres-only without extensions beyond uuid-ossp + pgcrypto. Operators wire their own scheduler (cron, K8s CronJob, workflow_runtime timer).
  - **Decision.** Substrate is the adapter; scheduling is operator-side.

- **Run as part of a workflow definition.**
  - **Considered.** A `RetentionWorkflow` running on workflow_runtime.
  - **Cons.** Bootstrapping problem — workflow_runtime depends on its own meta tables which would be the prune target. Out-of-band scheduling is safer.
  - **Decision.** External scheduling.

- **Per-tenant retention policies.**
  - **Considered.** Different tenants have different retention requirements.
  - **Cons.** Adds a `tenant_id NULLABLE` column (NULL = platform-wide default). Requires the prune SQL to fan out per-tenant. Out of scope. Listed as Q1.
  - **Decision.** Platform-wide only this milestone.

- **Variable retention by event kind (e.g., 90 days for failed traces, 30 days for completed).**
  - **Considered.** Different audit value per kind.
  - **Cons.** Significant complexity (kind-aware policies, per-policy time + kind predicate). Defer.
  - **Decision.** All-or-nothing per table.

## Consequences

- **56 packages + 1 app, 125 meta-schema tables, 7,720 tests** (+16 from M6.7.zz: all in `trace-retention.test.ts`). All green, zero type errors.
- **Closes ADR-0120 Q5, ADR-0140 Q1, ADR-0141 Q1.** Three deferred questions resolved in one milestone.
- **The trace substrates are now operationally sustainable.** Operators wiring `prune()` on a schedule cap the unbounded growth.
- **Pattern established for future trace tables.** Adding a new trace surface = update the CHECK constraint + add an entry to `PRUNABLE_TABLES`.
- **No new dependencies.** `PostgresTraceRetention` only uses `PgConnection` from kernel-pg itself.
- **Single-source-of-truth for prunable tables.** The hardcoded map IS the schema knowledge.
- **Defense-in-depth on destructive ops.** DB CHECK + adapter allowlist + parametrized cutoff = no silent "drop everything."

## Open questions

- **Q1:** Per-tenant retention policies?
  - _Current direction:_ Additive — add `tenant_id NULLABLE` column, change PK to `(tenant_id, table_name)` with NULL meaning "platform default." Adapter resolves "this tenant's policy" → fallback to platform default. Future milestone.
- **Q2:** Per-event-kind retention (e.g., keep `llm_call_failed` longer than `llm_call_completed`)?
  - _Current direction:_ Defer. Operators wanting this can use PG partitioning + per-partition retention.
- **Q3:** Should there be a `META_RETENTION_HISTORY` table tracking per-run results?
  - _Current direction:_ Yes if operators ask for it. `last_pruned_at` covers the simple case. Defer.
- **Q4:** Should the adapter support a `--dry-run` mode (count what WOULD be deleted)?
  - _Current direction:_ Useful. Additive method `previewPrune()` returning counts without DELETEs. Future enhancement.
- **Q5:** Should retention also clean up orphaned rows in dependent tables (e.g., if `workflow_instances` is deleted, do `workflow_traces` rows referencing it get cleaned too)?
  - _Current direction:_ FK CASCADE handles parent-child relationships at the schema level. Retention is time-based, not lineage-based. Distinct concern.
- **Q6:** Multi-region / sharded retention?
  - _Current direction:_ Each region/shard's substrate has its own retention policies (rows). Same adapter; same DB-side allowlist.
- **Q7:** Should there be a `RetentionInstrumentation` interface emitting events on each prune run?
  - _Current direction:_ Out of scope. `last_pruned_at` + the per-run result list are enough audit. If operators want event-stream observability, wire the adapter inside a workflow.
- **Q8:** Should `prune()` enforce a max-rows-per-run safety cap (avoid locking the table for too long on the first run)?
  - _Current direction:_ Useful for the first-run case where retention is being introduced over millions of accumulated rows. Additive option `maxRowsPerTable?: number`. Future enhancement.
