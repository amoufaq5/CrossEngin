# ADR-0166: `crossengin retention opt-out` / `opt-in` mutation actions (Phase 2 M6.7.zz.tenant.opt-out.cli.mutate)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0160 (M6.7.zz.tenant.opt-out flag), ADR-0161 (M6.7.zz.tenant.opt-out.reason), ADR-0162 (M6.7.zz.tenant.opt-out.expiry), ADR-0164 (M6.7.zz.tenant.opt-out.cli expiring action), ADR-0165 (M6.7.zz.tenant.opt-out.cli.effective action) |

## Context

ADRs 0164 and 0165 shipped two read-side actions under the `retention` subcommand: `expiring` (list opt-outs in a window) and `effective` (resolve current policy for a tenant/table). Operators can now *inspect* retention state from the CLI but still need raw SQL to *change* it — flipping `opt_out=true`, setting `opt_out_until`, lifting an opt-out at end of legal hold.

The closing trio of CLI actions promised by ADR-0160 Q5 + ADR-0161 Q4 + ADR-0162 Q4 is the mutation pair:

> `crossengin retention opt-out <tenant> <table> [--until DATE] [--reason TEXT]` + `retention opt-in <tenant> <table>`.

M6.7.zz.tenant.opt-out.cli.mutate ships both, plus the supporting adapter methods `setTenantOptOut` and `clearTenantOptOut` on `PostgresTraceRetention`.

## Decision

Two new adapter methods + two new CLI actions.

### Adapter: `setTenantOptOut(input)`

```ts
export interface SetTenantOptOutInput {
  readonly tenantId: string;
  readonly tableName: string;
  readonly retentionDays?: number;       // default 365 for new rows; preserved on existing
  readonly optOutUntil?: string | null;  // null = indefinite (default)
  readonly optOutReason?: string | null; // null = no reason (default)
}

async setTenantOptOut(
  input: SetTenantOptOutInput,
): Promise<TenantRetentionPolicyRow>;
```

Single-query `INSERT ... ON CONFLICT (tenant_id, table_name) DO UPDATE` against `meta.tenant_retention_policies`. Sets `enabled=false, opt_out=true` unconditionally. On conflict:

- `retention_days`: **preserved** (omitted from the UPDATE SET clause).
- `opt_out_reason`: set from `EXCLUDED.opt_out_reason` (the new value, including NULL when not provided).
- `opt_out_until`: set from `EXCLUDED.opt_out_until` (same).
- `updated_at`: `now()`.

For new rows, `retention_days` defaults to **365** when not provided — placeholder value matching the ADR-0160 stand-by semantic. Operators wanting a specific value pass `--retention-days N`.

`retention_days` validation throws `Error` for non-integer or `< 1` values; the underlying DB CHECK `retention_days >= 1` would catch this server-side, but CLI-side validation produces clearer error messages.

### Adapter: `clearTenantOptOut(input)`

```ts
export interface ClearTenantOptOutInput {
  readonly tenantId: string;
  readonly tableName: string;
}

async clearTenantOptOut(
  input: ClearTenantOptOutInput,
): Promise<TenantRetentionPolicyRow | null>;
```

Single `UPDATE ... WHERE tenant_id = $1 AND table_name = $2 AND opt_out = true` — sets `opt_out=false, opt_out_until=NULL, updated_at=now()`. **Preserves `opt_out_reason`** as historical audit context, per ADR-0161:

> Historical context preservation. An operator lifting opt-out (opt_out flips false) may want to KEEP the reason on the row as a "this tenant was opted out previously due to X" historical signal.

Returns `null` when no matching opt-out row exists — idempotent semantic. Operators running `opt-in` on a tenant that isn't opted out see a no-op success (exit 0); the CLI prints "idempotent no-op."

The `AND opt_out = true` clause in the WHERE prevents accidentally clearing fields on a non-opt-out row. Without it, an `opt-in` on a regular per-tenant policy would NULL out `opt_out_until` even though there was no opt-out to lift.

### CLI: `retention opt-out`

```
crossengin retention opt-out <tenant-id> <table-name>
                             [--until DATE] [--reason TEXT]
                             [--retention-days N]
                             [--format human|json]
```

Validates at the CLI boundary:

- `<tenant-id>` and `<table-name>` are required (exit 2).
- `--until` must parse via `Date.parse()` to a finite timestamp; otherwise exit 2. Normalised to canonical ISO 8601 via `new Date().toISOString()` before passing to the adapter — operators can pass `2027-01-01` and get `2027-01-01T00:00:00.000Z` stored.
- `--reason` must have length `1..256` if provided (length 0 / 257+ exit 2); the underlying DB CHECK constraint would catch this server-side, but CLI-side validation gives clearer error messages.
- `--retention-days` must be an integer `>= 1` if provided (exit 2).

All three flag values default to "null in the input" (which becomes NULL in the DB column for opt_out_reason/until, and 365 for retention_days on new rows). Operators wanting "preserve existing reason while extending until" run the `opt-in` then `opt-out` sequence, or accept that re-passing the same `--reason` value is the canonical pattern.

Output (human format):

```
Tenant opted out: <uuid> / workflow_traces
  Retention:  365 day(s)
  Enabled:    no
  Opt-out:    yes
  Until:      2027-01-01T00:00:00.000Z
  Reason:     legal_hold:case#42
```

JSON format: `{ action: "opt-out", policy: TenantRetentionPolicyRow }`.

### CLI: `retention opt-in`

```
crossengin retention opt-in <tenant-id> <table-name>
                            [--format human|json]
```

No optional flags. Validates `<tenant-id>` and `<table-name>` are required.

Human output when a policy was updated:

```
Tenant opted in: <uuid> / workflow_traces
  Retention:  90 day(s)
  Enabled:    no
  Opt-out:    no
  Reason:     legal_hold:case#42
```

Human output when no active opt-out exists (idempotent no-op):

```
no active opt-out for tenant <uuid> on workflow_traces (idempotent no-op)
```

JSON format: `{ action: "opt-in", policy: TenantRetentionPolicyRow | null }`. The `policy: null` value is the idempotent-no-op signal.

### Shared output renderer: `formatPolicyChange(action, policy)`

Exported helper rendering a `TenantRetentionPolicyRow` with an action verb header. Used by both `opt-out` and `opt-in` action functions. Omits the `Until:` line when opt-out is false AND opt_out_until is null (avoids printing "Until: null"). Omits the `Reason:` line when opt_out_reason is null.

## Why preserve `opt_out_reason` on opt-in (vs clear)

ADR-0161 explicitly endorses preservation: lifting opt-out keeps the reason as audit history. The `clearTenantOptOut` SQL deliberately omits `opt_out_reason` from the UPDATE SET clause.

Operators wanting a fully-cleared row run raw SQL (`DELETE FROM meta.tenant_retention_policies WHERE ...`) or wait for the deferred history-table milestone where the audit context lives in a dedicated append-only log instead of the live policy row.

## Why preserve `retention_days` on subsequent opt-out (vs overwrite)

The substrate's ADR-0160 placeholder semantic: `retention_days` is the value that would apply if opt_out is lifted. Operators flipping the opt-out flag back and forth shouldn't lose the configured retention.

`setTenantOptOut` therefore preserves `retention_days` on conflict — the UPDATE SET clause omits the column. New rows get `retention_days = 365` (placeholder default) or whatever the operator passes via `--retention-days`.

## Why `INSERT ... ON CONFLICT DO UPDATE` (vs check-then-INSERT-or-UPDATE)

Single round-trip atomicity. Two-query patterns are subject to a race window — between the SELECT and the INSERT, a concurrent writer could insert the row, breaking the second-query INSERT. The PG upsert pattern is the canonical solution.

The adapter-side cost: `EXCLUDED` references make the SET clause less readable than a pure UPDATE. But the safety win is worth it.

## Why action-verb naming `opt-out` and `opt-in` (vs `set-opt-out` / `clear-opt-out`)

Matches the user-facing vocabulary. Operators say "opt this tenant out" not "set their opt-out flag." The `set-` / `clear-` prefixes are accurate but verbose.

The actions sit under `retention` so the full command (`crossengin retention opt-out ...`) carries enough context that `opt-out` alone isn't ambiguous.

## Why no `--clear-reason` / `--clear-until` flags

Considered but rejected:

- `--clear-reason` would explicitly null out the reason on a subsequent `opt-out`. But operators wanting that workflow run `opt-in` (which preserves reason but lifts the opt-out) followed by `opt-out` (which writes new values, defaulting to null when no `--reason` flag).
- Same logic for `--clear-until`.

The CLI surface stays minimal; the workflow chains existing actions.

## Use cases unblocked

**1. Set a legal hold**

```bash
crossengin retention opt-out <tenant> workflow_traces \
  --until "2027-01-01T00:00:00.000Z" \
  --reason "legal_hold:case#42"
```

One command. Workflow with the existing CLI: `crossengin retention effective` confirms; periodic `crossengin retention expiring --within-days 30` alerts on approach.

**2. Lift a legal hold**

```bash
crossengin retention opt-in <tenant> workflow_traces
```

Idempotent. Re-runnable in CI / Inngest workflows without errors.

**3. Extend an existing opt-out**

```bash
crossengin retention opt-out <tenant> workflow_traces \
  --until "2028-01-01T00:00:00.000Z" \
  --reason "legal_hold:case#42"
```

Same reason re-passed. The UPDATE SET via `EXCLUDED.opt_out_reason` sets the (same) value; `opt_out_until` extends.

**4. Bulk opt-out via shell loop**

```bash
for tenant in $(cat tenants.txt); do
  crossengin retention opt-out "$tenant" workflow_traces \
    --until "2027-01-01" --reason "soc2_evidence_freeze"
done
```

Audit team freezes retention across a tenant cohort for SOC 2 evidence collection.

**5. Compliance cleanup**

```bash
crossengin retention expiring --within-days 0 --include-expired --format json | \
  jq -r '.results[] | "\(.tenantId) \(.tableName)"' | \
  while read tenant table; do
    crossengin retention opt-in "$tenant" "$table"
  done
```

Auto-lift every already-expired opt-out (which currently still has `opt_out=true` in the row, even though the resolver treats it as expired). Re-runnable.

## Drawbacks

1. **No actor attribution.** Who flipped the opt-out? `opt_out_set_by` is deferred (ADR-0161 Q2, ADR-0162 Q3). The mutation is recorded only via the underlying PG audit log (if enabled by the operator). The deferred history-table milestone (ADR-0161 alt-1) would close this gap.
2. **No `--dry-run` flag.** Operators can't preview the row state before mutation. Workflow: `retention effective` before, `retention effective` after.
3. **Re-passing reason for extend.** "Extend without changing reason" requires the operator to type the same reason value. Documented; the CLI stays mechanical.
4. **No bulk action.** Single tenant + table per invocation. Operators bulk via shell loops.
5. **Default `retention_days = 365` for new rows.** Arbitrary; matches the ADR-0160 placeholder convention. Operators wanting a specific stand-by retention pass `--retention-days N`.
6. **`opt_out_reason` preservation on opt-in could surprise operators.** After `opt-in`, the row still has the historical reason. A subsequent `retention effective` returns `source: "platform"` (or other), so the reason is invisible via the resolver — but raw queries against `meta.tenant_retention_policies` show it. Documented in ADR-0161.

## Alternatives considered

1. **Single `retention set` action with `--opt-out=true|false` flag.** Rejected — verbose, less natural English; the verb pair `opt-out` / `opt-in` matches operator vocabulary.
2. **Auto-clear `opt_out_reason` on opt-in.** Rejected — contradicts ADR-0161's documented audit-preservation semantic.
3. **DELETE the row on opt-in instead of UPDATE.** Rejected — destroys historical retention_days + opt_out_reason. Operators can DELETE manually via SQL when they want a clean slate.
4. **Mandatory `--reason` on opt-out.** Rejected — operators may want to record an opt-out before the reason is fully scoped (e.g., during incident response when the cause is still under investigation). Allowing null gives flexibility; compliance teams enforce non-null via review process.
5. **`--reason TEXT` interpreted as "preserve existing if not provided".** Rejected — too magical. Explicit null default is mechanically clearer.
6. **Adapter-level helpers like `extendOptOut` and `changeReason`.** Rejected — `setTenantOptOut` is general enough; specialized helpers add API surface without semantic gain.
7. **Two-query SELECT-then-INSERT-or-UPDATE.** Rejected — race window. ON CONFLICT is atomic.
8. **Validate `--until` against future-date constraint at CLI boundary.** Rejected — operators may legitimately pass past dates (testing expiry semantics, backfilling historical holds). The substrate's read-time expiry handles both.

## Open questions

1. **Actor attribution columns.** `opt_out_set_by UUID` + `opt_out_set_at TIMESTAMPTZ` added in a future milestone. The CLI would pass `--actor <uuid>` or derive from a `CROSSENGIN_ACTOR_ID` env var.
2. **Append-only history table.** `META_TENANT_RETENTION_OPT_OUT_HISTORY` capturing every flip / extend / lift with actor + reason + diff. Defer to ADR-0161 alt-1's deferred milestone.
3. **`--dry-run` flag.** Print the would-be query + expected result without executing. Defer.
4. **Bulk action.** `crossengin retention bulk-opt-out --tenants tenants.txt --table workflow_traces --until DATE --reason TEXT`. Defer — shell loops cover the common case.
5. **Confirmation prompt for destructive actions.** `opt-out` could prompt before flipping a tenant currently under per-tenant retention. Defer — `--confirm` flag would mirror the existing `apply --confirm`.
6. **Bulk `opt-in --expired`.** Convenience flag to lift every expired opt-out in one command. Defer — the shell loop in use case 5 above covers it.
7. **`retention set` action for non-opt-out per-tenant policies.** `crossengin retention set <tenant> <table> --days N` for the canonical per-tenant override. Defer — operators currently set via SQL; this is the natural next action.
