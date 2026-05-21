# ADR-0172: History-table retention (Phase 2 M6.7.zz.tenant.opt-out.history-retention)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0143 (META_RETENTION_POLICIES + PostgresTraceRetention), ADR-0155 (META_TENANT_RETENTION_POLICIES), ADR-0170 (META_TENANT_RETENTION_OPT_OUT_HISTORY) |

## Context

ADR-0170 / M6.7.zz.tenant.opt-out.history shipped the append-only audit-log table writing one row per per-tenant-policy mutation. Every `opt-out`, `opt-in`, `set`, `delete`, and `restore` produces a history row. The table grows unbounded.

At realistic scale (10K tenants × ~5 events/tenant/year average across long-lived production deployments = ~50K rows/year), this isn't catastrophic — but it's also not bounded. Compliance teams running multi-year deployments need retention. The substrate already has the machinery (`PostgresTraceRetention.prune()` + `meta.retention_policies`); the history table just isn't wired in.

ADR-0170 Q1 lined this up:

> Q1: History-table retention. Add to `meta.retention_policies` allowlist + adapter pruning logic. Defer until measured table-growth concern.

M6.7.zz.tenant.opt-out.history-retention closes Q1 with the mechanically simplest change in the retention substrate: widen two CHECK constraints + add one entry to the `PRUNABLE_TABLES` map.

## Decision

Three additive changes:

1. **`META_RETENTION_POLICIES.table_name` CHECK** widens from 3 to 4 values, adding `'tenant_retention_opt_out_history'`.
2. **`META_TENANT_RETENTION_POLICIES.table_name` CHECK** widens from 2 to 3 values, adding `'tenant_retention_opt_out_history'`.
3. **`PRUNABLE_TABLES` map in `PostgresTraceRetention`** gains an entry:
   ```ts
   tenant_retention_opt_out_history: { timeColumn: "occurred_at", hasTenantId: true }
   ```

That's it. No new adapter methods, no new CLI surface, no new tests for the actual pruning logic (already covered by the existing prune/previewPrune tests parameterized by table). The platform inherits the entire ADR-0143 + ADR-0155 + ADR-0162 retention machinery (window-based DELETE, per-tenant overrides, opt-outs with expiry, the dry-run preview, the effectiveRetention resolver, the CLI surface).

### Why include in per-tenant retention allowlist too

The history table has a `tenant_id` column (FK to `meta.tenants`). Operators with strict per-tenant audit-retention requirements (VIP customer "retain 7 years"; free-tier "retain 90 days") can express these via `META_TENANT_RETENTION_POLICIES`. Excluding it would be artificial — the schema supports per-tenant retention, the data has tenant scoping.

The cost: the `tenant_retention_policies` CHECK widens from 2 values to 3. Additive change, no migration friction.

### Why mark `hasTenantId: true`

Three implications:
1. Per-tenant DELETE on the history table fires when a tenant has an explicit override.
2. Platform-default DELETE uses the `tenant_id NOT IN (...)` subquery to exclude tenants with active overrides (or active opt-outs).
3. Per-tenant policies CAN opt out of history pruning (operators wanting "retain forever for this tenant").

### Why no retention-on-the-history-table (turtles all the way down)?

Considered. Rejected. The history table doesn't itself have an audit history — we don't track mutations on the audit log of mutations. The substrate keeps it flat: history rows describe policy mutations; they don't get their own meta-audit history.

Operators wanting "audit the audit log" wrap PG audit (`pgaudit` extension) at the database layer. Out of substrate scope.

### Why no special-case event_kind for "history row pruned"

Pruning DELETEs are NOT mutations on the per-tenant policies — they're maintenance on the audit log. No history row is written when a history row is pruned. (If we did write one, the pruning event would itself be subject to pruning. Loop.)

Operators auditing pruning runs use the `RetentionRunResult[]` returned from `prune()` — those results identify which tables were swept and how many rows.

### Why no schema-level append-only enforcement

The substrate documents history as append-only "by convention." Pruning is the substrate's documented exception. Operators who run the prune-history DELETE explicitly accept that some history is gone forever.

A future REVOKE on a hypothetical audit-write role could enforce append-only at the DB level, except for the system role that runs prune. Deferred per ADR-0170 Q3.

## Use cases unblocked

**1. Set platform-default retention for history**

```sql
INSERT INTO meta.retention_policies (table_name, retention_days, enabled)
VALUES ('tenant_retention_opt_out_history', 365, true);
```

Or via the CLI (if/when a `retention set-platform` action ships — not yet):

```bash
crossengin retention list-policies --table tenant_retention_opt_out_history
```

**2. Per-tenant retention override for VIP audit**

```bash
crossengin retention set <vip-tenant> tenant_retention_opt_out_history --days 2555
```

7-year retention for the VIP's audit log; platform default applies to everyone else.

**3. Tenant opts out of history pruning entirely**

```bash
crossengin retention opt-out <legal-hold-tenant> tenant_retention_opt_out_history \
  --reason "ongoing_litigation:case#42"
```

The tenant's audit log is preserved indefinitely for litigation hold.

**4. Dry-run before pruning**

```bash
# (Currently the previewPrune adapter is invoked via the scheduled job, not the CLI.
#  A future `crossengin retention preview` action would expose it directly.)
```

The `previewPrune()` adapter method works on the history table the same way it works on workflow_traces — operators get row counts before committing.

**5. Effective retention resolver across all tenant-scoped tables**

```bash
crossengin retention effective <tenant> tenant_retention_opt_out_history
```

Returns the same 4-variant resolution: tenant / tenant_opt_out / platform / none.

## Drawbacks

1. **History pruning is destructive.** Once an event row is pruned, the audit context is gone. Operators wanting indefinite retention set the platform policy to a very large `retention_days` value or `enabled = false`. Document that "retention pruning IS lossy for the audit log."
2. **No event captures pruning runs themselves.** A pruning run on the history table removes rows; the prune action is recorded only in the live policy table's `last_pruned_at` timestamp + the substrate's audit log if operators wire one. Future Q if needed.
3. **No special restriction on aggressive retention.** Operators can set `retention_days = 1` for the history table; pruning would wipe most events. The substrate doesn't gate this — operators choose retention.
4. **CHECK widening requires schema migration for production deployments.** PG ALTER TABLE DROP CONSTRAINT + ADD CONSTRAINT is fast (catalog-only update; no row scan) since the new value is additive. Documented.
5. **Per-tenant overrides on history retention add a small denormalization concern.** A tenant's `tenant_retention_opt_out_history` retention policy is ITSELF a row in `meta.tenant_retention_policies`, with its own history row. Operators auditing the "audit-log retention policy" navigate via the same query surface — no special-case needed.

## Alternatives considered

1. **Don't add the history table to retention at all.** Rejected — table grows unbounded; operators have legitimate compliance need for bounded audit logs.
2. **Add only to platform retention, NOT per-tenant.** Rejected — schema supports tenant scoping, real use cases for per-tenant override (VIP retention tier, legal hold).
3. **Special-case the history table with a separate `prune_history()` method.** Rejected — the existing `prune()` mechanism already does exactly what's needed (window-based DELETE, per-tenant exclusion via NOT IN subquery). Reuse > parallel structure.
4. **Add a `pruned_at` event to the history table itself.** Rejected — recursive concern (the pruning event row is also subject to pruning).
5. **Add a separate `history_retention_policies` table.** Rejected — duplicates the existing infrastructure; one retention substrate is correct.
6. **Refuse `enabled = false` on the history-table platform policy.** Rejected — operators legitimately want "retain forever" for compliance.
7. **Lower-bound CHECK on retention_days for the history table (e.g., >= 30).** Rejected — operator policy choice; substrate doesn't prescribe.
8. **Cascade pruning** (pruning per-tenant `tenant_retention_opt_out_history` rows triggers pruning of related `tenant_retention_policies` rows). Rejected — wrong direction of causation. Live policy rows are the source of truth; history is the audit trail.

## Open questions

1. **Default platform retention.** Should the substrate ship a default `meta.retention_policies` row for `tenant_retention_opt_out_history` (e.g., 365 days)? Today the table is empty by default; operators must explicitly insert. Defer — opt-in matches the existing pattern.
2. **CLI `retention prune` action.** Currently `prune()` is invoked via a scheduled job (operator-side). A `crossengin retention prune [--dry-run]` action would let operators run it ad-hoc. Defer.
3. **Pruning-run audit table.** A `meta.retention_pruning_runs` table capturing every prune execution with affected-table list + row counts + duration. Defer until operators ask.
4. **Append-only enforcement for the history table (REVOKE pattern).** Pair with the deferred roles substrate.
5. **Bound on `retention_days` to prevent accidental aggressive pruning.** A CHECK like `retention_days >= 30 OR table_name != 'tenant_retention_opt_out_history'`. Rejected for now (operator policy choice); revisit if accidental wipes become a problem.
6. **History-table-specific retention defaults.** Some compliance regimes (HIPAA: 6 years; SOX: 7 years) suggest minimum retention for audit logs. Substrate doesn't enforce — operators encode in their deploy scripts.
