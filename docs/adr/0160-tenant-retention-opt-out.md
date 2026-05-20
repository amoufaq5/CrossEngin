# ADR-0160: Per-tenant retention `opt_out` flag (Phase 2 M6.7.zz.tenant.opt-out)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0143 (M6.7.zz META_RETENTION_POLICIES), ADR-0155 (M6.7.zz.tenant META_TENANT_RETENTION_POLICIES), ADR-0159 (M6.7.zz.tenant.dashboard effectiveRetention) |

## Context

ADR-0159 / M6.7.zz.tenant.dashboard shipped the `effectiveRetention(tenantId, tableName)` resolver returning a three-variant discriminated union: `tenant`, `platform`, `none`. ADR-0159 Q1 lined up a follow-up:

> Q1: Tenant opt-out semantics. If a per-tenant policy row has `enabled = false`, should we eventually distinguish "fall back to platform" (current) from "tenant explicitly opts out of retention" (hypothetical future enabled=false with opt_out=true)? For now there's only one disabled meaning.

In the current schema, `enabled = false` is overloaded — it means "this override is disabled, use the platform default." Real-world compliance requirements need a distinct meaning:

1. **Legal hold tenants.** A tenant under legal hold (litigation, subpoena, audit) must have *no* data pruned regardless of platform default. Operators currently express this by setting a large per-tenant retention_days (`enabled = true, retention_days = 36500` for 100 years). Two problems: (a) the SQL still issues a DELETE that scans the partition; (b) audit reads "this tenant retains for 100 years" when the semantic is actually "never delete."
2. **Indefinite retention tenants.** Some regulated workloads (clinical trials, 21 CFR Part 11, certain HIPAA scenarios) require retention "until the operator manually purges." Same workaround / same audit confusion.
3. **VIP / enterprise contracts.** Customer contracts can stipulate "we retain your data until you request deletion." Today operators either pick a long retention_days or skip pruning entirely at the application layer.

The shared signal: **opt-out is fundamentally different from "use the platform default."** It's the strongest form of override — overrides both per-tenant retention_days AND platform-default retention.

## Decision

Add an `opt_out BOOLEAN NOT NULL DEFAULT false` column to META_TENANT_RETENTION_POLICIES with a cross-column CHECK preventing the contradictory state `enabled = true AND opt_out = true`. Extend the resolver's discriminated union with a new variant `tenant_opt_out`. Extend the prune + previewPrune paths to skip opt-out tenants and exclude them from platform-default pruning.

### Schema delta

```ts
{
  name: "opt_out",
  type: "BOOLEAN",
  notNull: true,
  default: "false",
  check: "NOT (enabled = true AND opt_out = true)",
}
```

Backward compatible: existing rows get `opt_out = false` by default (DDL default). Existing policies continue working identically. New rows opt in by setting `opt_out = true`.

The cross-column CHECK `NOT (enabled = true AND opt_out = true)` rejects the contradictory state at INSERT/UPDATE time. Operators wanting opt-out write `enabled = false, opt_out = true`. The active-policy state is `enabled = true, opt_out = false`. The fallback-to-platform state is `enabled = false, opt_out = false`.

### Resolver delta

```ts
export type EffectiveRetentionResolution =
  | { source: "tenant"; retentionDays: number; enabled: true; tenantId: string }
  | { source: "tenant_opt_out"; retentionDays: null; enabled: false; tenantId: string }  // NEW
  | { source: "platform"; retentionDays: number; enabled: boolean }
  | { source: "none"; retentionDays: null; enabled: false };
```

Resolution algorithm becomes:

1. Query `meta.tenant_retention_policies WHERE tenant_id = $1 AND table_name = $2`.
2. If row exists:
   - If `opt_out = true` → return `{source: "tenant_opt_out", retentionDays: null, enabled: false, tenantId}`. **Highest priority — skip platform query.**
   - Else if `enabled = true` → return `{source: "tenant", retentionDays, enabled: true, tenantId}`. Skip platform query.
   - Else (enabled=false, opt_out=false) → fall through to platform.
3. Query `meta.retention_policies WHERE table_name = $1`.
4. If row exists → return `{source: "platform", retentionDays, enabled}`.
5. Else → return `{source: "none", retentionDays: null, enabled: false}`.

### Prune semantics

Per-tenant DELETE loop gains an opt-out branch BEFORE the enabled check:

```ts
for (const policy of tenantPolicies) {
  if (policy.optOut) {
    results.push({ ..., status: "skipped_opt_out", deletedCount: 0 });
    continue;
  }
  if (!policy.enabled) { ...skipped_disabled... }
  // else DELETE
}
```

Platform-default DELETE's NOT IN subquery expands to also exclude opt-out tenants:

```sql
tenant_id NOT IN (
  SELECT tenant_id FROM meta.tenant_retention_policies
  WHERE table_name = $2 AND (enabled = true OR opt_out = true)
)
```

Same change applies to the COUNT subquery in `previewPrune()`.

`RetentionRunStatus` enum gains `"skipped_opt_out"`. `RetentionPreviewStatus` enum gains `"skipped_opt_out"`. Operators reading run results filter by status to distinguish "no work needed because tenant opts out" from "no work needed because tenant override is currently disabled."

### Why `retention_days = NULL` in the resolver but NOT in the column

Schema choice: keep `retention_days NOT NULL` with `CHECK retention_days >= 1`. Operators inserting opt-out rows still provide a placeholder retention_days value — typically the previously-configured value, so flipping `opt_out` back to `false` restores the prior policy without re-prompting the operator for a number.

Resolver choice: the `tenant_opt_out` variant returns `retentionDays: null` because semantically there IS no retention applied — emitting the placeholder value would mislead consumers reading the resolver output (a dashboard would show "365 days" when the actual semantic is "never delete").

The two choices are independent and serve different concerns: the schema stores the stand-by value; the resolver communicates the actual policy.

## Use cases unblocked

**1. Legal hold tenant**

```sql
INSERT INTO meta.tenant_retention_policies
  (tenant_id, table_name, retention_days, enabled, opt_out)
VALUES
  ('11111111-...', 'workflow_traces', 90, false, true),  -- legal hold on workflow_traces
  ('11111111-...', 'llm_call_traces', 90, false, true);  -- legal hold on llm_call_traces
```

Prune runs against the tenant produce `status: "skipped_opt_out"` for both tables. Platform-default DELETE excludes this tenant via the NOT IN subquery. Zero rows deleted for this tenant. Dashboard reads `effectiveRetention(tenantId, ...) → {source: "tenant_opt_out", ...}` — distinct badge "Legal Hold" possible.

**2. Lift legal hold**

```sql
UPDATE meta.tenant_retention_policies
SET opt_out = false, enabled = true, updated_at = now()
WHERE tenant_id = '11111111-...';
```

Next prune treats the tenant as a normal per-tenant policy with the previously-stored `retention_days = 90`.

**3. Operator audit query "tenants opted out"**

```sql
SELECT tenant_id, table_name, retention_days, last_pruned_at
FROM meta.tenant_retention_policies
WHERE opt_out = true;
```

Compliance teams enumerate which tenants are currently exempt from retention — a documented surface, not buried in heuristics like "retention_days > 9999."

**4. Compliance dashboard differentiation**

```ts
const r = await retention.effectiveRetention(tenantId, "llm_call_traces");
switch (r.source) {
  case "tenant_opt_out":
    ui.showBadge("Legal Hold / Indefinite Retention", { kind: "alert" });
    break;
  case "tenant":
    ui.showBadge(`Custom: ${r.retentionDays}d`, { kind: "info" });
    break;
  case "platform":
    ui.showBadge(r.enabled ? `Platform: ${r.retentionDays}d` : "DISABLED", {...});
    break;
  case "none":
    ui.showBadge("No Policy", { kind: "warn" });
    break;
}
```

Operators distinguish four states in their UI without inferring from numeric thresholds.

## Why a separate column vs encoding in enabled/retention_days

Three rejected alternatives:

1. **`retention_days = -1` sentinel for opt-out.** Reuse existing column. Rejected — overloads numeric semantics with a magic value; existing `CHECK retention_days >= 1` would have to change; operators reading raw rows might miss the convention. Cross-column flags are clearer.
2. **`enabled = false AND retention_days = NULL` (make retention_days NULLABLE).** Two states encoded in two columns. Rejected — operators flipping `opt_out` on/off lose the previously-configured retention_days value (need to re-enter it). The two-flag design preserves the placeholder.
3. **Replace `enabled BOOLEAN` with `policy_state TEXT` enum (`active` / `disabled` / `opt_out`).** Cleanest type-theoretically but a breaking schema migration — all existing rows need an UPDATE, all client code reading `enabled` needs to switch. The additive `opt_out` column is migration-free.

## Why the cross-column CHECK over leaving it unconstrained

Without `CHECK NOT (enabled = true AND opt_out = true)`:

```sql
INSERT INTO meta.tenant_retention_policies
  (tenant_id, table_name, retention_days, enabled, opt_out)
VALUES ('...', 'workflow_traces', 90, true, true);  -- ambiguous
```

What does the application do? Adapter currently checks `opt_out` first, so opt-out wins. But the DB row's semantics are unclear ("retention is active AND tenant opts out" is incoherent). The CHECK forces operators to pick one mode — no ambiguity at the data layer.

PG evaluates column-level CHECK as a row-level constraint that can reference other columns of the same row — standard SQL.

## Drawbacks

1. **Placeholder retention_days for opt-out rows.** Operators must provide a numeric value even when `opt_out = true`. Mitigated by treating it as the "restore value" if opt-out is lifted later. ADR documents this as the intended pattern.
2. **One additional column on a small table.** META_TENANT_RETENTION_POLICIES is bounded by (number of tenants) × (number of prunable tables with tenant_id), which is small even at 10K-tenant deployments. The schema cost is trivial.
3. **Schema migration story.** Existing META_TENANT_RETENTION_POLICIES rows in production deployments need an ALTER TABLE adding `opt_out BOOLEAN NOT NULL DEFAULT false` + the CHECK. Default ensures existing rows get `opt_out = false` automatically — no operator action required. New rows opt in.
4. **Resolver branching.** `effectiveRetention` now has 4 outcomes instead of 3. TypeScript discriminated union handles this cleanly; consumers updating to exhaustive matching see compile-time errors on missed branches.

## Alternatives considered

1. **Sentinel retention_days value (e.g., -1 or 0 or very-large).** Cross-cuts numeric semantics. Rejected.
2. **NULL retention_days with NULLABLE column.** Operator loses the previously-set value when toggling opt-out. Rejected.
3. **policy_state TEXT enum.** Breaking change to existing rows. Rejected for additive opt_out flag.
4. **opt_out as a separate table `meta.tenant_retention_opt_outs(tenant_id, table_name)`.** Cleaner separation of "configured retention" from "opt-out kill switch" but introduces a join in the resolver + a second NOT IN subquery in prune. Rejected for two-table complexity.
5. **opt_out on the platform-default table instead of per-tenant.** Doesn't match the use case — platform default IS the default; opt-out is per-tenant by definition. Rejected.
6. **No CHECK on `enabled = true AND opt_out = true`.** Adapter could prefer opt_out and silently ignore enabled. Rejected — DB constraint catches inconsistent state at INSERT/UPDATE time, before the adapter sees the row.

## Open questions

1. **Opt-out reason field.** A future `opt_out_reason TEXT` column for audit context ("legal_hold:case#42", "vip_contract:tenant-xyz", "21cfr11:trial-9"). Useful for compliance dashboards. Defer until operators demand structured reason tracking.
2. **Opt-out expiry.** A `opt_out_until TIMESTAMPTZ NULLABLE` column for time-bound opt-outs (a 1-year legal hold). Currently operators manage expiry application-side; future milestone could push into the schema.
3. **Opt-out for platform tables.** Per-tenant opt-out doesn't apply to `llm_latency_samples` (no tenant_id column). For platform-wide opt-out (e.g., "freeze ALL latency-sample pruning during an incident"), the workflow is to disable the platform policy directly via `meta.retention_policies.enabled = false`. The new CHECK constraint doesn't reach there.
4. **Opt-out impact on retention dashboard alerts.** Future ADR-0143 Q5-style "alert if tenant's retention exceeds 365 days" needs to skip opt_out=true tenants (they're intentionally exempt). Tracking item for the alerting milestone.
5. **CLI exposure.** `crossengin retention opt-out <tenant> <table>` and `crossengin retention opt-in <tenant> <table>` subcommands wrapping the INSERT/UPDATE. Defer to the M6.7.zz.tenant.cli milestone listed in ADR-0159 Q5.
6. **Tenant-initiated opt-out.** Currently operators flip opt_out via direct INSERT/UPDATE. A future tenant-API endpoint letting customers self-serve opt-out would route through compliance approval workflows — separate substrate concern.
