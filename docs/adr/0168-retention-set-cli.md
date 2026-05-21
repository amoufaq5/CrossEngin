# ADR-0168: `crossengin retention set` CLI action + `setTenantRetention` adapter (Phase 2 M6.7.zz.tenant.retention-set)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0155 (M6.7.zz.tenant META_TENANT_RETENTION_POLICIES), ADR-0160 (opt_out flag), ADR-0161 (opt_out_reason), ADR-0162 (opt_out_until), ADR-0166 (M6.7.zz.tenant.opt-out.cli.mutate opt-out/opt-in actions) |

## Context

ADR-0166 / M6.7.zz.tenant.opt-out.cli.mutate shipped two write actions: `opt-out` and `opt-in`. Both flip the opt-out flag — `opt-out` to `true` (with optional `--until` / `--reason`), `opt-in` to `false`. ADR-0166 Q7 lined up the natural sibling for the **non-opt-out** per-tenant override:

> Q7: `retention set` action for non-opt-out per-tenant policies. `crossengin retention set <tenant> <table> --days N` for the canonical per-tenant override. Defer — operators currently set via SQL; this is the natural next action.

Today an operator wanting to give tenant X a 30-day retention on `workflow_traces` (instead of platform default 90) has to:

```sql
INSERT INTO meta.tenant_retention_policies
  (tenant_id, table_name, retention_days, enabled, opt_out)
VALUES (...) ON CONFLICT (tenant_id, table_name) DO UPDATE SET ...;
```

That's exactly the kind of friction the retention CLI is meant to remove. Two prior milestones (M6.7.zz.tenant.opt-out.cli + M6.7.zz.tenant.opt-out.cli.mutate) closed similar gaps for opt-out workflows. M6.7.zz.tenant.retention-set closes the analogous gap for active per-tenant overrides.

## Decision

Add `setTenantRetention` to `PostgresTraceRetention` + `retention set` CLI action.

### Adapter

```ts
export interface SetTenantRetentionInput {
  readonly tenantId: string;
  readonly tableName: string;
  readonly retentionDays: number;
  readonly enabled?: boolean;  // default true
}

async setTenantRetention(
  input: SetTenantRetentionInput,
): Promise<TenantRetentionPolicyRow>;
```

Single-query `INSERT ... ON CONFLICT (tenant_id, table_name) DO UPDATE` — same atomicity pattern as `setTenantOptOut` from ADR-0166. Sets `opt_out=false` unconditionally (this is the active-policy path, not the opt-out path).

On INSERT (new row): all fields written explicitly. `opt_out=false`, `opt_out_reason=NULL`, `opt_out_until=NULL`.

On UPDATE (existing row):
- `retention_days = EXCLUDED.retention_days` (new value)
- `enabled = EXCLUDED.enabled` (new value)
- `opt_out = false` (always cleared)
- `opt_out_until = NULL` (always cleared)
- `updated_at = now()`
- **`opt_out_reason` is OMITTED from the SET clause** → preserved as historical audit context, per ADR-0161.

Validates `retentionDays` as integer `>= 1` at adapter boundary (clearer than DB CHECK violation).

### Why preserve `opt_out_reason` on `setTenantRetention`

ADR-0161 endorses preservation: lifting an opt-out keeps the reason as a "this tenant was opted out previously due to X" historical signal. The same logic applies when transitioning from opt-out to active per-tenant override — the row's reason still answers "what happened on this row earlier?"

A future raw-SQL cleanup or the deferred history-table milestone can clear historical context. The substrate doesn't destroy audit signals.

### Why clear `opt_out_until` on update

`opt_out_until` semantically belongs to the opt-out lifecycle. When `set` flips `opt_out=false`, leaving a stale `opt_out_until` set would be confusing — operators reading the row would see "opt_out_until=2027-01-01 but opt_out=false" and wonder if it's pre-staged for re-opt-out (which is technically valid per ADR-0162's "operators may pre-stage" rationale, but rarer than the "stale value from previous opt-out" case).

Clearing matches the most common operator intent: "set this tenant's retention to N days, period." Pre-staging operators can still do it via raw SQL or future `opt-out --until X --opt-out=false` (if we ever ship that — not planned).

### CLI

```
crossengin retention set <tenant-id> <table-name>
                         --days N
                         [--enabled true|false]
                         [--format human|json]
```

Validates at the CLI boundary:

- `<tenant-id>` + `<table-name>` required (exit 2 missing arguments).
- `--days N` required (no default — operators must explicitly state the policy). Must parse as `Number.isFinite() && integer >= 1` (exit 2).
- `--enabled true|false` optional (default `true`). Anything else exits 2 with a clear error.

Why no default for `--days`: setting retention without specifying the value is a bug. The CLI mandates the operator type the number.

Why default `--enabled` to `true`: the common case is "give this tenant a custom retention." Operators wanting "disabled stand-by row" pass `--enabled=false` explicitly.

Human output via the shared `formatPolicyChange("retention set", policy)` helper — same rendering pattern as `opt-out` and `opt-in` from ADR-0166.

JSON output: `{ action: "set", policy: TenantRetentionPolicyRow }`.

### Action verb naming

`set` (verb) follows the existing `retention` action-verb pattern. The full command (`crossengin retention set ...`) carries enough context that `set` alone isn't ambiguous.

Alternatives considered: `update` (implies row exists), `configure` (verbose), `override` (specific to per-tenant override semantic but verbose). `set` is the canonical operator vocabulary for "make this configuration take effect."

## Use cases unblocked

**1. Per-tenant tier upgrade**

```bash
crossengin retention set <tenant> workflow_traces --days 365
```

Tenant moved from free tier (90-day platform default) to enterprise tier (365-day retention).

**2. Per-tenant tier downgrade**

```bash
crossengin retention set <tenant> llm_call_traces --days 7
```

Free-tier tenant reduces retention to minimum legal threshold.

**3. Disable a per-tenant override (stand-by)**

```bash
crossengin retention set <tenant> workflow_traces --days 365 --enabled false
```

Per-tenant policy disabled (tenant falls back to platform default) but the configured `retention_days=365` is stored as the "restore value" if `--enabled=true` is set later.

**4. End of legal hold → resume custom retention**

```bash
crossengin retention opt-in <tenant> workflow_traces      # lift opt-out
crossengin retention set <tenant> workflow_traces --days 90  # restore custom policy
```

Two-step workflow. The first command clears `opt_out`; the second sets `retention_days=90` + `enabled=true`. The `set` step also clears `opt_out_until` (defensive — handles any residual staging from the lift).

**5. Compliance reset (lift everything, set platform-default)**

```bash
crossengin retention opt-in <tenant> workflow_traces
crossengin retention set <tenant> workflow_traces --days 90 --enabled false
```

Lift opt-out, then disable per-tenant override. Tenant inherits platform default for both axes.

**6. JSON pipeline for bulk tier migration**

```bash
jq -r '.[] | "\(.tenantId) \(.newDays)"' new-tier-assignments.json | \
  while read tenant days; do
    crossengin retention set "$tenant" workflow_traces --days "$days"
  done
```

Operator running a tier-migration script after a pricing-plan update.

## Drawbacks

1. **`opt_out_reason` persists silently after `set`.** Operators inspecting the row via raw SQL see a historical reason that no longer applies. The CLI `effective` and `list-policies` actions surface this clearly (tenant_opt_out variant doesn't appear; `opt-out=no` shows). Future history-table milestone moves the reason out of the live row entirely.
2. **No bulk variant.** `retention set` operates on one (tenant, table) pair. Shell loops cover the common case; built-in bulk would conflict with the per-pair atomicity the substrate provides.
3. **No `--restore-from-platform` flag.** Operators wanting "reset to platform default by deleting the row" use raw SQL `DELETE FROM meta.tenant_retention_policies WHERE ...`. The CLI surface stays focused.
4. **Mandatory `--days`.** Setting `--enabled=false` alone (preserving existing `retention_days`) requires the operator to re-pass the days value. Same incremental-vs-fresh trade-off as ADR-0166's mutation actions — explicit is clearer.
5. **`enabled` boolean only.** Three-state enum (`active` / `disabled` / `opt_out`) would be cleaner type-theoretically but is a more invasive schema change. The boolean pair maps mechanically to the existing columns.

## Alternatives considered

1. **`retention update` instead of `retention set`.** Rejected — implies row exists; `set` is symmetric across new-row and existing-row cases.
2. **`retention override` instead of `retention set`.** Rejected — verbose and specific to the per-tenant override semantic; `set` reads more naturally for both first-time and re-set workflows.
3. **Allow `--days` to be optional (preserve existing on update).** Rejected — operators may forget to pass it on a new row and create an inconsistent state; making it mandatory catches the bug at the CLI boundary.
4. **Default `--enabled` to `false` (require explicit `true`).** Rejected — the common case is "give this tenant a custom retention with the new value taking effect"; default `true` matches.
5. **Preserve `opt_out_until` on update.** Rejected — stale value from previous opt-out is more common than pre-staging; clearing matches operator intent.
6. **Clear `opt_out_reason` on update.** Rejected — contradicts ADR-0161 documented historical-context preservation.
7. **Refuse to `set` a row currently with `opt_out=true`.** Rejected — operators may want a one-shot transition from "opted out" to "custom retention." The current behavior (clears `opt_out` + `opt_out_until` while preserving `opt_out_reason`) is exactly that one-shot.
8. **Reject `--enabled=false` with `--days` (since the days don't apply when disabled).** Rejected — operators legitimately stage a future retention with disabled flag for later activation.
9. **Two-query SELECT-then-INSERT-or-UPDATE.** Rejected — race window. `INSERT ... ON CONFLICT DO UPDATE` is atomic.

## Open questions

1. **`retention delete <tenant> <table>` action.** Remove the per-tenant policy row entirely (operators currently use raw SQL `DELETE FROM ...`). Defer.
2. **Auto-detect "already opted out → set` flow.** A future `--confirm-clear-opt-out` flag would force operators to explicitly acknowledge they're clearing an active opt-out. Defer — current behavior is documented.
3. **`--days inherit` to drop the per-tenant policy and inherit platform default.** Sugar for `DELETE FROM`. Defer.
4. **Bulk variant.** `retention set --bulk <file.csv>` for tier-migration scripts. Defer — shell loops cover it.
5. **Confirmation prompt for destructive transitions.** When `set` overwrites an existing opt-out, prompt operator. Defer — `--confirm` flag pattern matches the existing `apply --confirm`.
6. **Audit columns (`set_by` / `set_at`).** Pair with the deferred actor-attribution + history-table milestones.
