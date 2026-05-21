# ADR-0169: `crossengin retention delete` CLI action + `deleteTenantPolicy` adapter (Phase 2 M6.7.zz.tenant.retention-delete)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0155 (M6.7.zz.tenant META_TENANT_RETENTION_POLICIES), ADR-0166 (M6.7.zz.tenant.opt-out.cli.mutate), ADR-0168 (M6.7.zz.tenant.retention-set) |

## Context

ADRs 0166 and 0168 shipped three mutation CLI actions: `opt-out`, `opt-in`, and `set`. Together they cover **flipping flags and changing values**, but operators still need raw SQL for one fundamental operation: **removing the per-tenant policy row entirely**.

The use case: a tenant moves back to platform-default retention with no historical context to preserve. The per-tenant row no longer serves a purpose — the operator wants it gone:

```sql
DELETE FROM meta.tenant_retention_policies
WHERE tenant_id = $1 AND table_name = $2;
```

That's the last raw-SQL gap in the retention CLI. ADR-0168 Q1 lined this up:

> Q1: `retention delete <tenant> <table>` action. Remove the per-tenant policy row entirely (operators currently use raw SQL `DELETE FROM ...`). Defer.

M6.7.zz.tenant.retention-delete closes Q1 with the mechanically simplest action in the retention CLI surface: a thin wrapper around a single `DELETE` statement.

## Decision

Add `deleteTenantPolicy(input)` to `PostgresTraceRetention` + `retention delete` CLI action.

### Adapter

```ts
export interface DeleteTenantPolicyInput {
  readonly tenantId: string;
  readonly tableName: string;
}

async deleteTenantPolicy(input: DeleteTenantPolicyInput): Promise<boolean>;
```

Single `DELETE FROM meta.tenant_retention_policies WHERE tenant_id = $1 AND table_name = $2`. Returns `true` when a row was deleted (rowCount > 0), `false` when no matching row existed (idempotent no-op signal).

Uses PG's native `rowCount` rather than `RETURNING` — the operator doesn't need the deleted row's content (they can inspect via `effective` or `list-policies` before deleting); a boolean is sufficient.

No `opt_out` filter in the WHERE clause — `deleteTenantPolicy` removes ANY matching row regardless of state. Distinct from `clearTenantOptOut` (which deliberately filters `AND opt_out = true` to avoid clearing fields on non-opt-out rows). The semantic difference is intentional:

- `clearTenantOptOut`: lift opt-out, preserve audit context → UPDATE preserving `opt_out_reason`, fires only on actually-opted-out rows.
- `deleteTenantPolicy`: remove the row entirely → DELETE matching anything that exists for the (tenant, table) pair.

### CLI

```
crossengin retention delete <tenant-id> <table-name> [--format human|json]
```

Validates positional args. No flags beyond `--format`. Idempotent — `deleted=false` on no-op is success (exit code 0); operators can safely re-run scripts.

Human output:

```
deleted per-tenant policy: <tenant-uuid> / workflow_traces
```

Or on no-op:

```
no per-tenant policy for tenant <tenant-uuid> on workflow_traces (idempotent no-op)
```

JSON output:

```json
{
  "action": "delete",
  "deleted": true,
  "tenantId": "<uuid>",
  "tableName": "workflow_traces"
}
```

The JSON envelope echoes `tenantId` + `tableName` so downstream consumers (cron logs, audit trails) can correlate multiple invocations without re-parsing command lines. The `deleted` boolean is the discriminator between actual deletion and idempotent no-op.

### Why no `--confirm` flag

Considered but rejected for v1. Two reasons:

1. **Established CLI pattern.** Sessions and gateway-routes mutation actions (`sessions show`, `gateway routes unregister`) don't prompt for confirmation. Operators chain destructive commands in scripts; `--confirm` prompts would break automation.
2. **Bounded blast radius.** A single per-tenant policy row is small. Worst case: operator deletes the wrong (tenant, table) pair; recovers via `retention set --days N` or `retention opt-out --until X --reason Y`. The substrate keeps `meta.retention_policies` (platform defaults) untouched, so the tenant continues to receive platform-default pruning until the row is re-created.

Future Q if needed: `--confirm` flag with prompt, gated on environment (e.g., production `PGDATABASE` name patterns) matching the existing `apply --confirm` pattern.

### Why `boolean` return vs `TenantRetentionPolicyRow | null`

`clearTenantOptOut` returns the post-mutation row (`TenantRetentionPolicyRow | null`). `deleteTenantPolicy` deliberately returns just a boolean:

- The deleted row no longer exists post-mutation; returning its pre-deletion state via `RETURNING` would be semantically odd ("here's what you just removed").
- The boolean is sufficient for idempotent-flow scripts (`if deleted: log_audit_event`).
- Operators wanting the row state pre-deletion run `retention effective <tenant> <table>` before deleting.

### Idempotent no-op semantic

`deleted=false` is the canonical signal for "no matching row." Operators running `for tenant in $(cat tenants.txt); do crossengin retention delete "$tenant" workflow_traces; done` safely re-run without errors — the first-run-deletes-rows / subsequent-runs-are-no-ops shape mirrors `opt-in` from ADR-0166.

JSON consumers discriminate via `deleted` boolean. Operators wanting "fail if no row to delete" use a future `--exit-on no-op` flag (deferred per the established pattern from ADR-0164 / 0167).

## Use cases unblocked

**1. Reset a tenant to platform-default**

```bash
crossengin retention delete <tenant> workflow_traces
```

Tenant inherits platform retention for `workflow_traces`. No historical row, no audit baggage.

**2. Tier-migration cleanup**

```bash
jq -r '.[] | .tenantId' tier-downgrades.json | while read tenant; do
  crossengin retention delete "$tenant" workflow_traces
  crossengin retention delete "$tenant" llm_call_traces
done
```

Bulk-revert tenants from custom retention back to platform-default after a pricing-plan rollback.

**3. Compliance audit closure**

```bash
crossengin retention list-policies --format json | \
  jq -r '.tenantPolicies[] | select(.optOut == false and .enabled == false) | "\(.tenantId) \(.tableName)"' | \
  while read tenant table; do
    crossengin retention delete "$tenant" "$table"
  done
```

Sweep up disabled+non-opt-out rows (effectively stand-by overrides that operators stopped maintaining). Pipe `list-policies` JSON through `jq` to find candidates, then delete.

**4. End-of-engagement tenant offboarding**

```bash
crossengin retention delete <tenant> workflow_traces
crossengin retention delete <tenant> llm_call_traces
```

Customer churned. Their per-tenant policy rows no longer serve any purpose. Substrate's normal tenant-offboarding workflow handles the data itself; retention CLI cleans up the policy metadata.

**5. CI test-tenant cleanup**

```bash
crossengin retention delete "$TEST_TENANT_ID" workflow_traces
```

After a CI test creates a per-tenant policy, the teardown deletes it. Idempotent — no error if the test didn't actually create the row.

## Drawbacks

1. **Destroys audit context.** Unlike `opt-in` (which preserves `opt_out_reason` per ADR-0161), `delete` removes the row entirely. Operators wanting "tenant X was once opted out for reason Y" historical signal use `opt-in` (which sets `opt_out=false` but keeps the reason). `delete` is for operators who explicitly DO NOT want audit context preserved on this row. Future history-table milestone (ADR-0161 alt-1) would move audit context out of the live row so `delete` becomes safe for audit-conscious workflows.
2. **No `--confirm` flag.** Single-keystroke deletion. Mitigated by bounded blast radius (one policy row); operators wanting safety run `retention effective <tenant> <table>` first to confirm what they're deleting.
3. **No bulk variant.** Single (tenant, table) per invocation. Shell loops cover the common case.
4. **Doesn't surface what was deleted.** The boolean return doesn't echo the deleted row's pre-deletion state. Operators wanting that run `retention effective` before `retention delete`.
5. **No `--all-tables` flag.** Operators offboarding a tenant must run delete twice (once per prunable table with tenant_id support). A future `retention delete <tenant> --all-tables` would close this; defer.

## Alternatives considered

1. **DELETE with `RETURNING` to surface the deleted row.** Rejected — adds adapter complexity for a boolean question. Operators inspect pre-deletion state via `effective` / `list-policies`.
2. **Soft-delete via `enabled=false`.** Rejected — already covered by `retention set --days N --enabled false`. `delete` is the hard-delete path.
3. **Refuse to delete a row currently with `opt_out=true`.** Rejected — operators explicitly running `delete` know what they're doing; the substrate doesn't gate destructive actions on flag states (mirrors `set`'s willingness to overwrite opted-out rows).
4. **`--confirm` prompt for destructive action.** Rejected this milestone — established CLI pattern doesn't prompt; bounded blast radius; operators chain in scripts. Add as `--confirm` flag if requested.
5. **Bulk delete via `--bulk <file.csv>`.** Rejected — shell loops cover it.
6. **`--all-tables` flag.** Rejected this milestone — defer.
7. **`retention purge` instead of `retention delete`.** Rejected — `purge` implies destructive sweep across many rows; `delete` matches the single-row scope.
8. **Return `Promise<TenantRetentionPolicyRow | null>` (the deleted row via RETURNING).** Rejected — semantically odd ("here's what you just removed"); boolean is cleaner.
9. **Filter on `opt_out` to mirror `clearTenantOptOut`.** Rejected — `delete` is intentionally a hard-delete with no flag-state filter; the operator's intent is "remove this row regardless of its state."

## Open questions

1. **`--confirm` flag.** Add if operators report accidental deletions. Match the `apply --confirm` pattern.
2. **`--all-tables` flag.** Delete all per-tenant policies for one tenant across every prunable table. Useful for tenant offboarding. Defer.
3. **`--include-platform` flag.** Delete the matching platform-default row in `meta.retention_policies` too. Almost certainly never wanted (platform defaults are operator-curated; CLI shouldn't make accidental deletion easy). Reject permanently.
4. **`--exit-on no-op` flag.** Operators wanting CI gates ("fail build if expected row was already missing") would benefit. Mirrors the `--exit-on-found` pattern from ADR-0164 Q4 / ADR-0165 Q4. Defer until requested.
5. **Audit-log integration.** Deferred history-table milestone (ADR-0161 alt-1) should capture every `delete` event with actor + timestamp + pre-deletion row state. Defer.
6. **`retention purge --before <date>` for time-bound bulk cleanup.** Sweep policy rows that haven't been updated since a date. Defer.
7. **`retention restore <backup-id>` for undo.** Would require a deferred history table to store pre-deletion state. Defer.
