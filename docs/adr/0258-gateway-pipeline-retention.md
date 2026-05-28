# ADR-0258: Gateway pipeline-execution retention

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-26 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0143 (META_RETENTION_POLICIES + PostgresTraceRetention), ADR-0155 (per-tenant overrides), ADR-0172 (history-table retention), ADR-0050 (API gateway runtime), ADR-0044 (gateway pipeline-execution table) |

## Context

After ADR-0172 (M6.7.zz.tenant.opt-out.history-retention), the
retention substrate covered FOUR platform-prunable tables:

| Table                              | Time column     | Tenant-bearing |
|------------------------------------|-----------------|----------------|
| workflow_traces                    | occurred_at     | NOT NULL       |
| llm_call_traces                    | occurred_at     | NOT NULL       |
| tenant_retention_opt_out_history   | occurred_at     | NOT NULL       |
| llm_latency_samples                | recorded_at     | absent         |

`META_GATEWAY_PIPELINE_EXECUTIONS` (the gateway's M4.5 audit
substrate) was the 5th and final append-only operational surface
without retention coverage. At 1M requests/day, JSONB-stage rows
add ~500 MB/day after indexes — the table becomes unworkable
within months without pruning. Operators wanting bounded retention
had to drop to raw SQL DELETEs run from cron.

**The new shape this milestone exposes.** Unlike the four existing
prunable tables where `tenant_id` is either `NOT NULL` (3 tables)
or absent (1 table), `META_GATEWAY_PIPELINE_EXECUTIONS.tenant_id`
is **NULLABLE** — platform-level requests (anonymous /__ping,
/__health, requests that fail auth before principal resolution)
have `tenant_id IS NULL`, while tenant-scoped requests carry the
authenticated tenant. The RLS policy reflects this: `tenant_id IS
NULL OR tenant_id = current_setting(...)::UUID` — operators see
their own rows + platform rows.

This nullable shape is a SQL semantic trap for the existing
`PrunableTableSpec.hasTenantId: true` path, whose platform-default
DELETE uses:

```sql
DELETE FROM meta.<table>
WHERE <time> < to_timestamp($1 / 1000.0)
  AND tenant_id NOT IN (
    SELECT tenant_id FROM meta.tenant_retention_policies
    WHERE table_name = $2 AND (...override OR opt-out active...)
  )
```

PG's `NOT IN` returns `NULL` (not `TRUE`) for a `NULL` row
value, so **NULL-tenant rows are silently EXCLUDED** from the
platform-default sweep — the opposite of operator intent (operators
want NULL-tenant rows swept by the platform default since per-tenant
policies can't possibly cover them).

## Decision

Add `gateway_pipeline_executions` to PRUNABLE_TABLES as the 5th
entry + extend `PrunableTableSpec` with a new optional
`nullableTenantId` flag. Widen META CHECK constraints additively.

```ts
interface PrunableTableSpec {
  readonly timeColumn: string;
  readonly hasTenantId: boolean;
  readonly nullableTenantId?: boolean;  // NEW
}

const PRUNABLE_TABLES = {
  workflow_traces: { timeColumn: "occurred_at", hasTenantId: true },
  llm_latency_samples: { timeColumn: "recorded_at", hasTenantId: false },
  llm_call_traces: { timeColumn: "occurred_at", hasTenantId: true },
  tenant_retention_opt_out_history: { timeColumn: "occurred_at", hasTenantId: true },
  gateway_pipeline_executions: {
    timeColumn: "started_at",
    hasTenantId: true,
    nullableTenantId: true,
  },
};
```

**SQL change.** Both the platform-default DELETE (`prune`) and the
platform-default COUNT (`previewPrune`) gain a conditional
`tenant_id IS NULL OR` prefix to the NOT IN clause when
`spec.nullableTenantId === true`:

```sql
DELETE FROM meta.gateway_pipeline_executions
WHERE started_at < to_timestamp($1 / 1000.0)
  AND (tenant_id IS NULL OR tenant_id NOT IN (
    SELECT tenant_id FROM meta.tenant_retention_policies
    WHERE table_name = $2 AND (...)
  ))
```

For the three pre-existing tenant-bearing tables the SQL is
byte-identical to before (the `IS NULL OR` prefix is omitted) —
existing tests assert the substring `tenant_id NOT IN` and pass
unchanged.

**Per-tenant DELETE unchanged.** The per-tenant DELETE uses `WHERE
tenant_id = $1` — null-tenant rows can never match a per-tenant
policy (META_TENANT_RETENTION_POLICIES.tenant_id is NOT NULL +
operators can't insert null-tenant per-tenant policies). NULL-
tenant rows therefore correctly fall through to the platform
default, exactly as intended.

**META CHECK widenings (additive).**

- `meta.retention_policies.table_name CHECK IN (...)` grows from 4
  to 5 values (adds `gateway_pipeline_executions`).
- `meta.tenant_retention_policies.table_name CHECK IN (...)` grows
  from 3 to 4 values (adds the same).

No data migration — pre-existing rows continue to satisfy the
widened CHECK. Future deployments enable retention via the
documented INSERT or `crossengin retention set` path.

**Operator workflows unblocked.**

- Platform-default gateway audit retention via
  `INSERT INTO meta.retention_policies (table_name, retention_days)
   VALUES ('gateway_pipeline_executions', 90)`.
- VIP tenant longer retention via
  `crossengin retention set <vip> gateway_pipeline_executions --days 2555`
  (per ADR-0168).
- Compliance opt-out for litigation hold via
  `crossengin retention opt-out <hold-tenant>
   gateway_pipeline_executions --reason legal_hold:case#42`
  (per ADR-0166).
- Self-management via the same `crossengin retention history` /
  `effective` / `expiring` surfaces (per ADR-0163/0164/0165 — the
  new table is just another entry on existing surfaces).

## Alternatives considered

- **Don't add `gateway_pipeline_executions` to retention.**
  - **Why not:** the table grows ~500 MB/day at 1M req/day and
    becomes unworkable. Operators end up dropping to raw SQL or
    skipping audit altogether.

- **Always emit `(tenant_id IS NULL OR tenant_id NOT IN (...))`
  for every `hasTenantId: true` table.**
  - **Why not:** byte-changes the SQL string for the 3 pre-existing
    tables. Their tests assert substring shapes; the IS NULL branch
    would be dead code on NOT NULL columns (PG optimizer constant-
    folds, but the SQL text changes). Additive flag keeps existing
    behavior identical and surfaces the new shape opt-in.

- **Treat `gateway_pipeline_executions` as `hasTenantId: false`
  and let null-tenant rows + tenant rows ride one global sweep.**
  - **Why not:** loses per-tenant override capability. Regulated
    tenants couldn't keep their gateway audit longer than the
    platform default. The whole `nullableTenantId` extension exists
    so per-tenant policies still apply to tenant-bearing rows.

- **Add a `WHERE tenant_id IS NULL` separate DELETE for the null-
  tenant rows.**
  - **Why not:** two DELETEs vs one combined predicate; same logical
    result with more round-trips. The combined `(IS NULL OR NOT IN)`
    is the simpler shape.

- **Move pruning into the gateway substrate (api-gateway-pg)
  instead of `kernel-pg`.**
  - **Why not:** retention is already cross-cutting in kernel-pg
    (workflow + llm + history tables). Splitting per-table by owning
    substrate would fan out the policy + prune + CLI surface across
    every X-pg package. Operators expect one `retention` CLI and one
    META_RETENTION_POLICIES table for all platform retention.

- **Refuse `previewPrune` / `prune` on the new table until a CLI
  flag enables it.**
  - **Why not:** the table is in PRUNABLE_TABLES; the CHECK accepts
    it; existing operator paths (`crossengin retention set` /
    `opt-out`) work out of the box. Hidden until enabled would
    surprise operators reading docs.

## Consequences

- **Positive:** the 5th and final operational append-only table
  has retention coverage. The substrate is now retention-complete
  across workflow + llm + history + gateway surfaces.
- **Positive:** `nullableTenantId` flag is a documented pattern;
  future tables with nullable tenant_id (when they land) opt in
  with one flag.
- **Positive:** existing 3 tenant-bearing tables' SQL is byte-
  identical — backward-compat preserved without code edits beyond
  the test set/count updates.
- **Neutral:** PRUNABLE_TABLES grows 4 → 5. `knownPrunableTables()`
  + `tablesWithTenantId()` static accessors reflect the change;
  three pre-existing tests updated (count 4→5, set additions).
- **Neutral:** the META CHECK widenings are additive; no migration.
- **Neutral:** kernel-pg test count 662 → 668 (+6 in the new M4.11
  block); the 3 existing tests are mutated to reflect new counts
  but don't add to the total.
- **Reversibility:** trivial — revert the PRUNABLE_TABLES entry,
  the conditional SQL prefix, and the CHECK widenings. The new
  table is purely additive at the substrate level.

## Implementation notes

- `nullableTenantId` is `boolean | undefined` — the existing 3
  tables get `undefined` (default branch); only the new table opts
  in to the `IS NULL OR` prefix. SQL strings for the 3 existing
  tables are byte-identical to before this milestone.
- The `gateway_pipeline_executions` table's RLS policy already
  permits operator-visible null-tenant rows (`tenant_id IS NULL OR
  tenant_id = current_setting(...)::UUID`); retention's reach
  matches that.
- 6 new tests in `trace-retention.test.ts` under
  `describe("PostgresTraceRetention gateway-pipeline-executions
  retention (M4.11)")`: DELETE uses `started_at` column; platform-
  default DELETE contains `tenant_id IS NULL OR tenant_id NOT IN`;
  the three pre-existing tenant-bearing tables still use plain
  `tenant_id NOT IN` (backward compat); per-tenant retention applies
  via the standard tenant_id = $1 DELETE; `effectiveRetention`
  resolves to source=`platform`; `previewPrune` count subquery uses
  the same `IS NULL OR` prefix.
- 3 existing tests updated (count 4→5, set additions for
  knownPrunableTables / tablesWithTenantId / safety-properties
  allowlist length).
- kernel-pg test count 662 → **668** (+6 new minus 0 removed).
  Workspace test count 9,475 → **9,481**.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Default platform retention shipped row (substrate ships META_RETENTION_POLICIES rows by default, or leaves empty for opt-in?) — same Q as ADR-0172 left open | platform | _deferred_ |
| Pruning audit table — `meta.retention_pruning_runs` capturing every prune execution with affected-table list + row counts + duration (same Q as ADR-0172) | platform | _deferred_ |
| Operator UI surface for `gateway_pipeline_executions` retention specifically — currently shares the generic `crossengin retention *` actions, but the gateway audit surface may want its own quick-set defaults | platform | _deferred_ |
| Per-route retention overrides (regulatory routes need longer audit than health-check routes) — would need a new policy axis beyond tenant + table | platform | _deferred_ |
| Time-based partitioning on `gateway_pipeline_executions.started_at` to make prune DELETEs O(partition drop) instead of O(row scan) at very high write rates | platform | _deferred_ |
| `meta.idempotency_records` is the next operational table that grows under request load — needs the same retention treatment but has its own time column (`expires_at` already serves the role; pure DELETE WHERE expires_at < now() works without a policy table) | platform | _deferred_ |

## References

- ADR-0143 — META_RETENTION_POLICIES + PostgresTraceRetention
  baseline + PRUNABLE_TABLES pattern.
- ADR-0155 — per-tenant overrides via META_TENANT_RETENTION_POLICIES.
- ADR-0172 — history-table retention (the prior 4th-table addition;
  same mechanical 2-edit shape).
- ADR-0044 — gateway pipeline-execution lifecycle (the table this
  milestone covers).
- ADR-0050 — gateway runtime (writer of the table).
- `packages/kernel/src/bootstrap/meta-schema.ts`
  (`META_GATEWAY_PIPELINE_EXECUTIONS` + the two widened CHECK
  constraints).
- `packages/kernel-pg/src/trace-retention.ts`
  (`PRUNABLE_TABLES`, `nullableTenantId` flag, conditional SQL).
