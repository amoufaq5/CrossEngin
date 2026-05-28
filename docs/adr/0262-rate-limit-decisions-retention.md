# ADR-0262: Rate-limit-decisions retention

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-26 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0258 (the M4.11 pattern this milestone replicates), ADR-0143 (retention substrate baseline), ADR-0172 (history-table retention — same 2-edit shape), ADR-0043 (rate-limiting baseline that writes the table) |

## Context

After ADR-0258 (M4.11) added `gateway_pipeline_executions` to
PRUNABLE_TABLES via the new `nullableTenantId` flag, ADR-0258's
own Q6 listed `gateway_idempotency_records` as the next gap —
closed by ADR-0259/0260 (M4.12/M4.13) via a separate
`expires_at`-aware CLI prune because that table has its own TTL
contract. The substrate still had one operational hot-write
audit table without retention coverage:

| Table                              | Time column     | Tenant-bearing | Retention status |
|------------------------------------|-----------------|----------------|------------------|
| workflow_traces                    | occurred_at     | NOT NULL       | ✓ ADR-0143       |
| llm_call_traces                    | occurred_at     | NOT NULL       | ✓ ADR-0143       |
| tenant_retention_opt_out_history   | occurred_at     | NOT NULL       | ✓ ADR-0172       |
| llm_latency_samples                | recorded_at     | absent         | ✓ ADR-0143       |
| gateway_pipeline_executions        | started_at      | NULLABLE       | ✓ ADR-0258       |
| **`rate_limit_decisions`**         | **`decided_at`**| **NULLABLE**   | **(this ADR)**   |

`META_RATE_LIMIT_DECISIONS` is the gateway-runtime's per-request
rate-limit audit substrate (ADR-0043): one row per
allowed/denied/bypassed decision, indexed by `(tenant_id,
decided_at)` for "tenant rate-limit history" queries +
`(policy_id)` for per-policy SLA reports. At gateway load
(thousands of req/sec), this table grows faster than any other
audit surface — without retention it becomes the largest table
in the substrate within weeks.

**Same shape as `gateway_pipeline_executions`.** The
`tenant_id` column is **NULLABLE** (anonymous requests + pre-
auth rate-limit gates have `tenant_id IS NULL`), RLS policy is
`tenant_or_platform` (the same M4.11 shape that motivated the
`nullableTenantId` SQL flag). This means M4.11.x is a
mechanical replica of M4.11 — same `nullableTenantId: true`
flag, same `(tenant_id IS NULL OR tenant_id NOT IN (...))`
platform-DELETE shape, same CHECK widening on both retention
tables.

## Decision

Add `rate_limit_decisions` as the 6th `PRUNABLE_TABLES` entry in
`PostgresTraceRetention` + widen the two META CHECK
constraints additively. Total: 2 edits to `meta-schema.ts`, 1
edit to `trace-retention.ts`, 3 updated existing test
assertions, 1 new test block (5 tests).

**Substrate changes:**

1. **`PRUNABLE_TABLES` entry:**
   ```ts
   rate_limit_decisions: {
     timeColumn: "decided_at",
     hasTenantId: true,
     nullableTenantId: true,
   },
   ```

2. **`META_RETENTION_POLICIES.table_name` CHECK:**
   5 → 6 values, adds `rate_limit_decisions`.

3. **`META_TENANT_RETENTION_POLICIES.table_name` CHECK:**
   4 → 5 values, adds the same.

**SQL behavior** (identical to M4.11's
`gateway_pipeline_executions` path):

```sql
-- platform-default DELETE
DELETE FROM meta.rate_limit_decisions
WHERE decided_at < to_timestamp($1 / 1000.0)
  AND (tenant_id IS NULL OR tenant_id NOT IN (
    SELECT tenant_id FROM meta.tenant_retention_policies
    WHERE table_name = $2 AND (...override OR opt-out active...)
  ))

-- per-tenant DELETE
DELETE FROM meta.rate_limit_decisions
WHERE tenant_id = $1 AND decided_at < to_timestamp($2 / 1000.0)
```

NULL-tenant rows (anonymous principals + pre-auth gates) are
swept by the platform-default policy — operators wanting
forensic retention of anonymous rate-limit history set the
platform retention high; per-tenant overrides apply only to
tenant-bearing rows.

**Operator workflows unblocked** (all via existing CLI
surfaces — no new actions):

- Platform-default 30-day rate-limit history via
  `INSERT INTO meta.retention_policies (table_name,
  retention_days) VALUES ('rate_limit_decisions', 30)`.
- VIP forensic-class tenant 1-year retention via
  `crossengin retention set <vip> rate_limit_decisions --days 365`.
- Litigation-hold opt-out via
  `crossengin retention opt-out <hold-tenant> rate_limit_decisions
  --reason legal_hold:case#42`.
- Self-management via `crossengin retention history /
  effective / expiring` — the new table is just another entry on
  the existing surfaces, no CLI change.

## Alternatives considered

- **Don't add retention; let operators DROP/recreate the table
  periodically.**
  - **Why not:** destroys per-tenant retention overrides (they're
    in a separate table but operators can't keep BOTH the new
    audit + the long history). Drops are also single-point
    operations that lose all granularity.

- **Add a separate `rate_limit_decisions_retention` policy
  table with policy-keyed retention (per `policy_id`).**
  - **Why not:** the existing per-table + per-tenant model is
    already two-axis. A third axis (per-policy) would require a
    new policy table + new prune logic + new CLI. Operators
    wanting per-policy retention compose per-tenant overrides;
    if measured demand emerges, a future ADR adds it.

- **Treat `rate_limit_decisions` like
  `gateway_idempotency_records` (M4.12 expires_at-based CLI).**
  - **Why not:** the table has no `expires_at` column.
    `decided_at` is the audit timestamp; "delete EXPIRED" makes
    no sense for an audit row. Retention semantics ("delete
    older than N days") are the right shape.

- **Skip the M4.11-replica path and write custom prune logic.**
  - **Why not:** the
    M4.11 `nullableTenantId` flag was designed to support
    exactly this shape. Reusing it keeps the SQL shape uniform
    + the test assertions follow the established pattern.

- **Default to a much shorter retention (e.g. 7 days) for this
  table since it grows fastest.**
  - **Why not:** the substrate ships empty by default (no rows
    in META_RETENTION_POLICIES) — operators set values per
    their compliance regime. Defaulting on the kernel side
    would be operator-policy intrusion.

- **Add a separate operator action `rate-limiting prune` with
  policy-scoped flags.**
  - **Why not:** would duplicate the retention CLI vocabulary.
    The existing `crossengin retention ...` surface works
    unchanged on the new table — operators get the full action
    set (set / opt-out / history / effective / expiring / list-
    policies / prune --dry-run) for free.

## Consequences

- **Positive:** the substrate now covers **6 operational
  prunable tables** uniformly. Every high-write audit/trace
  surface has retention support: workflow + llm + history +
  gateway pipeline + rate-limit decisions.
- **Positive:** zero new CLI surface area, zero new adapter
  methods. Operators with existing `crossengin retention`
  muscle memory work on the new table without learning
  anything new.
- **Positive:** the SQL is byte-identical to M4.11's
  `gateway_pipeline_executions` path (same `nullableTenantId`
  flag, same NULL-OR-NOT-IN subquery). One pattern, two tables.
- **Neutral:** PRUNABLE_TABLES grows 5 → 6.
  `knownPrunableTables()` + `tablesWithTenantId()` static
  accessors reflect the change; three pre-existing tests
  updated (count 5→6, set additions, safety-properties length).
- **Neutral:** META CHECK widenings are additive; no migration.
- **Neutral:** kernel-pg test count 668 → 673 (+5 in the new
  M4.11.x block); the 3 updated tests don't add to the total.
  Workspace test count 9,507 → 9,512.
- **Reversibility:** trivial — drop the PRUNABLE_TABLES entry
  + revert the 2 CHECK widenings + revert the 3 test
  assertions. Purely additive at the substrate level.

## Implementation notes

- The shared `nullableTenantId` SQL flag added in ADR-0258 is
  reused as-is — the `buildExpiredScope`-equivalent path in
  `PostgresTraceRetention.prune` / `.previewPrune` already
  branches on `spec.nullableTenantId` for the
  `(tenant_id IS NULL OR ...)` prefix. No code change needed
  beyond the PRUNABLE_TABLES entry.
- The 5 new tests in `trace-retention.test.ts` under
  `describe("PostgresTraceRetention rate-limit-decisions retention
  (M4.11.x)")` mirror the M4.11 test block one-for-one:
  DELETE uses `decided_at`; platform DELETE has the
  `IS NULL OR NOT IN` branch; per-tenant DELETE works
  (standard `tenant_id = $1`); `effectiveRetention` resolves;
  `previewPrune` COUNT subquery includes the same prefix.
- 3 existing tests updated for the new counts
  (`knownPrunableTables` 5→6, `tablesWithTenantId` 4→5,
  safety-properties allowlist length 5→6).
- Coverage gate (ADR-0261) verified: `pnpm coverage` exits 0;
  no threshold violations. All packages including kernel-pg
  stay above the 80% statements / 70% branches floor.
- Workspace test count 9,507 → **9,512**. kernel-pg test count
  668 → 673 (+5 new).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Default shipped retention policy for `rate_limit_decisions` at substrate-bootstrap time (e.g. 30 days) — same Q as ADR-0172/0258 left open; the substrate still ships empty | platform | _deferred_ |
| Per-policy retention (third axis beyond table + tenant) for operators wanting different windows by rate-limit policy | platform | _deferred_ |
| Time-based partitioning on `rate_limit_decisions.decided_at` to make prune DELETEs O(partition drop) at very high write rates (same Q as ADR-0258 Q5 / ADR-0259 Q5) | platform | _deferred_ |
| Pruning audit table — `meta.retention_pruning_runs` capturing every prune execution with affected-table list + row counts + duration (same Q as ADR-0172/0258) | platform | _deferred_ |
| Operator UI surface for rate-limit retention specifically — currently shares the generic `crossengin retention *` actions; a gateway-focused dashboard could combine pipeline + rate-limit + idempotency prune metrics | platform | _deferred_ |
| Anonymous-rate-limit-decision retention as a separate axis — operators might want different retention for `tenant_id IS NULL` rows (pre-auth gates) vs tenant-bearing rows | platform | _deferred_ |

## References

- ADR-0143 — META_RETENTION_POLICIES + PostgresTraceRetention
  baseline + PRUNABLE_TABLES pattern.
- ADR-0155 — per-tenant overrides via
  META_TENANT_RETENTION_POLICIES.
- ADR-0172 — history-table retention (the prior 4th-table
  addition; same 2-edit additive shape).
- ADR-0258 — gateway pipeline-execution retention (the
  `nullableTenantId` flag this milestone reuses).
- ADR-0043 — rate-limiting baseline (the writer of the table
  this milestone covers).
- `packages/kernel/src/bootstrap/meta-schema.ts`
  (`META_RATE_LIMIT_DECISIONS` + the two widened CHECK
  constraints).
- `packages/kernel-pg/src/trace-retention.ts` (the
  `PRUNABLE_TABLES` entry).
