# ADR-0269: Retention housekeeping `--tenant <uuid>` drill-down filter

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-29 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0264 Q3 (closes), ADR-0263 (gateway housekeeping companion), ADR-0266 (composes with threshold-alert) |

## Context

After ADR-0264 shipped `crossengin retention housekeeping`
as the substrate-centric dashboard across all 6
PRUNABLE_TABLES, the report surfaced a
`perTenantPolicyCount` integer per table — useful for "how
much override noise is on this table" at a glance, but
silent about WHO. Operators investigating per-tenant
configuration ("does tenant X have a per-tenant policy on
workflow_traces?", "is tenant Y in opt-out?", "what's
tenant Z's retention compared to platform default?") had
to chain multiple commands:

```bash
# To answer "what's tenant X's retention substrate footprint?"
crossengin retention housekeeping  # cross-tenant aggregates
crossengin retention list-policies --tenant X  # tenant overrides
crossengin retention effective X workflow_traces  # per-pair effective
crossengin retention effective X llm_call_traces
crossengin retention effective X llm_latency_samples
crossengin retention effective X tenant_retention_opt_out_history
crossengin retention effective X gateway_pipeline_executions
crossengin retention effective X rate_limit_decisions
```

8 commands to get one tenant's full picture.

ADR-0264 Q3 explicitly listed this gap:

> "`--tenant <uuid>` filter mode. Scopes
> `perTenantPolicyCount` to one tenant and adds drill-
> down detail (per-tenant overrides + their values).
> Operators answer 'what's this tenant's substrate
> footprint?'"

This ADR closes that Q.

## Decision

Add `--tenant <uuid>` boolean-valued flag to `crossengin
retention housekeeping`. When set:

1. Validates the value is a well-formed UUID (regex
   check at CLI boundary; exits 2 on mismatch BEFORE any
   PG query).
2. Echoes the tenantId in the report envelope (top-level
   `tenantId: string` field; absent when filter not set).
3. Adds a per-table `tenantPolicy` field to each table
   report:
   - `TenantRetentionPolicyRow` when the tenant has an
     override on this table.
   - `null` when the tenant has no override (inherits
     platform default).
   - The field is `undefined` (omitted from the JSON
     envelope) when --tenant is not set.
4. Human format adds a "tenant policy:" section per
   table showing the override detail or "(no override —
   inherits platform default)".
5. Aggregate fields (`totalRowCount`, `oldestAt`,
   `wouldPruneCount`, platform `retentionDays`/`enabled`/
   `lastPrunedAt`, `perTenantPolicyCount`) stay cross-
   tenant. The filter is a drill-down ADDITION, not a
   re-scoping of the aggregate semantic.

### Why aggregates stay cross-tenant

Two designs were considered:

**Option A — full per-tenant scoping**: aggregates
become `WHERE tenant_id = $1` filtered. Operators see
"this tenant's row count + this tenant's oldest row +
this tenant's would-prune count for the effective policy."

**Option B — drill-down only**: aggregates stay cross-
tenant; only the new `tenantPolicy` field reflects the
tenant filter.

Option B was chosen because:

1. **Mental model continuity.** Operators reading the
   report in both `--tenant`-set and `--tenant`-unset
   modes see consistent aggregates. Switching contexts
   doesn't reshape the numbers.

2. **No new queries.** Option A would require per-tenant
   `SELECT COUNT(*) WHERE tenant_id = $1` queries plus
   `effectiveRetention()` calls per table. Option B
   reuses the existing `listTenantPolicies()` call and
   client-side filtering — zero new PG round-trips.

3. **`llm_latency_samples` has no tenant_id.** Option A
   would have to special-case this table; Option B
   treats it uniformly (the `tenantPolicy` field is
   null for it, same as any table where the tenant
   has no override).

4. **Composes cleanly with `--threshold-alert`.** Alerts
   evaluate against cross-tenant aggregates. Under
   Option A, `--tenant X --threshold-alert
   wouldPruneCount:>1M` would have ambiguous semantics
   (the platform sweep affecting X vs the tenant
   override). Option B keeps alerts unambiguous —
   they always evaluate the same cross-tenant
   aggregates regardless of the drill-down filter.

5. **Per-tenant aggregate drill-down is a separate
   workflow.** Operators wanting per-tenant row counts
   compose with `retention effective <tenant> <table>`
   or a future ADR for tenant-scoped aggregates. This
   ADR's scope is policy drill-down.

### Validation

UUID format checked at CLI boundary against
`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`.
Operators with a typo (extra dash, wrong length, etc.)
get an immediate exit 2 with a clear error before any PG
connection is opened. The regex is lightweight — PG
validates again at query time, so a regex-passing-but-
PG-rejecting UUID (highly unusual) would error at query
boundary, propagating to exit 1.

### Output

**Human format**:

```
retention housekeeping (as of 2026-05-29T12:00:00.000Z, filtered to tenant 00000000-...-A):

  workflow_traces
    total rows:      1,000,000
    oldest row:      2026-04-01T00:00:00.000Z
    would prune:     50,000
    retention:       90 day(s) (enabled)
    last pruned:     2026-05-28T00:00:00.000Z
    tenant overrides: 47
    tenant policy:
      retention:     365 day(s) (enabled)
      opt-out:       no
      last pruned:   2026-05-20T00:00:00.000Z

  llm_call_traces
    ...
    tenant policy:
      retention:     30 day(s) (disabled)
      opt-out:       yes (until 2099-01-01T00:00:00.000Z, reason: legal_hold:case#42)
      last pruned:   never

  rate_limit_decisions
    ...
    tenant policy:   (no override — inherits platform default)
```

The header includes "filtered to tenant <uuid>" callout
so operators reading saved output (logs, screenshots)
know the context.

**JSON envelope**:

```json
{
  "action": "retention.housekeeping",
  "asOf": "2026-05-29T12:00:00.000Z",
  "tenantId": "00000000-0000-4000-8000-00000000000A",
  "tables": [
    {
      "tableName": "workflow_traces",
      "totalRowCount": 1000000,
      ...,
      "perTenantPolicyCount": 47,
      "tenantPolicy": {
        "tenantId": "00000000-...-A",
        "tableName": "workflow_traces",
        "retentionDays": 365,
        "enabled": true,
        "optOut": false,
        "optOutReason": null,
        "optOutUntil": null,
        "lastPrunedAt": "2026-05-20T00:00:00.000Z"
      }
    },
    {
      "tableName": "rate_limit_decisions",
      ...,
      "tenantPolicy": null
    }
  ]
}
```

`tenantPolicy: null` (not absent) when filter is set but
no override exists — operators can JSON-parse without
defensive presence checks. `tenantPolicy` is OMITTED
when filter is not set (backward compat for pre-M4.14.u
JSON consumers).

### Composition

`--tenant` composes with every prior housekeeping flag:

- `--format json` — JSON envelope includes the new
  fields.
- `--watch` — each tick re-renders with the tenant
  filter; under live monitoring, the operator can see
  the tenant's overrides change (e.g., during a tier
  migration).
- `--watch-keep-going` — keep-going + tenant filter
  works as expected; the filter is purely additive.
- `--threshold-alert` — alerts evaluate against the
  cross-tenant aggregates (unchanged). Operators wanting
  tenant-scoped alerts compose with `retention effective
  --exit-on-divergence` for now (future Q).

### Implementation

`gatherRetentionHousekeepingReport` now accepts
`tenantId?: string` in its input. When set:

1. Index `listTenantPolicies()` output by tableName for
   the filtered tenant (client-side filter; zero extra
   queries).
2. For each table row, populate `tenantPolicy` from the
   index (or null if absent).

The envelope conditionally includes `tenantId` and per-
table `tenantPolicy` via object spread:

```ts
return {
  asOf: input.now.toISOString(),
  ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
  tables,
};
```

CLI parsing in `runRetentionHousekeeping`:

```ts
const tenantFlag = getStringFlag(command, "tenant");
if (tenantFlag !== null && !isValidUuid(tenantFlag)) {
  printError(ctx.io, `retention housekeeping: invalid --tenant '${tenantFlag}' ...`);
  return 2;
}
const tenantId = tenantFlag ?? undefined;
```

Threaded through gather/render closures.

### Gateway dashboard

`crossengin gateway housekeeping` does NOT get a
`--tenant` flag (this milestone). Two reasons:

1. The gateway-domain view is operator-domain-centric,
   not tenant-centric. Gateway operators reason about
   pipeline executions + rate-limit decisions + idempotency
   records across all tenants.
2. The retention substrate is the canonical home for
   tenant-policy drill-down. Operators wanting to know
   "is this tenant overriding gateway_pipeline_executions
   retention?" use `retention housekeeping --tenant X`
   and see the row for that table in their drill-down.

Future Q if gateway operators have a different per-
tenant question pattern.

## Rejected alternatives

1. **Full per-tenant aggregate scoping (Option A).**
   Adds new queries + changes the mental model. Drill-
   down via additive field is cleaner.

2. **`--tenant` as a positional argument.** Inconsistent
   with all other housekeeping flags (--watch, --threshold-
   alert, etc.). Flag-form keeps the surface uniform.

3. **`--tenant-id` instead of `--tenant`.** The `-id`
   suffix is redundant — the value IS the tenant ID.
   Shorter flag reads better.

4. **Accept tenant slug (e.g., `acme-corp`) instead of
   UUID.** Requires meta.tenants lookup, adds a query,
   and tenant slugs aren't currently part of the
   retention substrate's concept space. UUID is the
   canonical tenant identifier.

5. **Reject malformed UUIDs at adapter (let PG fail).**
   The action's existing error-propagation maps to
   exit 1. CLI-side check upgrades to exit 2 with
   clearer error before any PG connection — better
   operator UX.

6. **Show `tenantPolicy` for every table even without
   --tenant (always include the field).** Bloats the
   default JSON envelope with empty fields. Omit-when-
   filter-not-set is cleaner + backward compat.

7. **Render `tenantPolicy` BEFORE the platform policy
   section in human format.** Operators read top-down
   expecting aggregate-first → policy-second; tenant
   override is a per-tenant detail belonging at the end.

8. **Add an `effectiveRetention` field showing the
   resolved tenant/platform/none decision.** Useful but
   requires per-table `effectiveRetention()` calls (N+
   queries). Operators wanting that use the existing
   `retention effective` command per pair. Future Q.

9. **`--tenant <a>,<b>,<c>` comma-separated for multi-
   tenant drill-down.** Multi-tenant drill-down is a
   different mental model (showing N tenants' overrides
   side-by-side). Single-tenant covers the most common
   "investigate this tenant" workflow; multi-tenant is
   a future Q.

10. **Add `--tenant` flag to gateway housekeeping too.**
    Different domain concept (gateway = operator-domain,
    not tenant-centric). Documented as a deferred
    decision; revisit if gateway operators request it.

## Drawbacks

1. **Operators reading the report at a glance may miss
   the header callout.** "filtered to tenant <uuid>"
   appears once at the top; if scrolled past, the per-
   table sections look the same as the cross-tenant
   view (except for the new `tenant policy:` section).
   Acceptable — the section name + UUID echo in the
   header are sufficient.

2. **Aggregate fields don't reflect the filter.**
   Operators expecting "per-tenant totalRowCount" get
   the cross-tenant value. Documented; the drill-down
   semantic is clear. Future Q for per-tenant
   aggregates.

3. **Per-tenant `listTenantPolicies()` client-filter is
   O(N) where N = total tenant policies across all
   tenants.** At 10K-tenant scale with averaging 3
   policies each = 30K rows; client-filter is sub-
   millisecond. Acceptable for v1; future Q for PG-
   side filtering if scale demands.

4. **No support for tenant slug lookup.** Operators
   maintaining tenant-name → tenant-id mappings outside
   the substrate. Future Q to integrate with
   meta.tenants.

5. **Composing `--tenant` + `--threshold-alert
   wouldPruneCount:>1M` evaluates the alert against
   the cross-tenant aggregate, not the tenant's data.**
   Documented; operators wanting tenant-scoped alerts
   chain with the deferred ADR-0266 Q3 (aggregated
   thresholds across tables) or use `retention effective
   --exit-on-divergence`.

6. **Gateway housekeeping doesn't get `--tenant`.**
   Asymmetric across the two dashboards. Documented as a
   deferred decision (gateway is operator-domain, not
   tenant-domain).

## Future Qs

1. **Tenant-slug lookup for `--tenant`.** Allow
   `--tenant acme-corp` resolving via meta.tenants
   slug column. Requires meta.tenants reads + caching.

2. **Per-tenant aggregate scoping (Option A) under a
   different flag** (e.g., `--scope-to-tenant`).
   Operators wanting full per-tenant numbers opt in.
   Adds queries; defer until measured demand.

3. **`effectiveRetention` field per table** showing the
   resolved tenant/platform/none variant. Adds 6
   `effectiveRetention()` calls per gather; defer until
   operators ask for it (the existing `retention
   effective <tenant> <table>` per-pair covers it).

4. **`--tenant <a>,<b>,<c>` for multi-tenant
   comparison.** Side-by-side overrides for N tenants
   in one report. Useful for tier migration verification.

5. **`--threshold-alert tenantPolicy.optOut:=true`** —
   alert when the tenant has opted out of a table. Adds
   a new field type to the alert grammar (boolean
   equality on a nested field). Defer until aggregated
   threshold support lands (ADR-0266 Q3).

6. **Per-table tenant-scoped `wouldPruneCount`** —
   show "if pruning ran now, how many of THIS tenant's
   rows would be deleted?" Requires per-tenant query
   per table; pairs with future per-tenant scoping mode.

7. **`--tenant` for gateway housekeeping.** If gateway
   operators have a tenant-scoped drill-down workflow,
   add the same field shape. Defer until operators ask.

8. **Persist tenant-filter history.** A "recently
   inspected tenants" feature in a shell config or
   localStorage-equivalent. Operator-policy concern;
   defer.

## Operator workflow examples

### Tier migration verification

```bash
crossengin retention housekeeping --tenant <migration-tenant>
# Operator sees: workflow_traces tenant policy = 365 day(s) enabled.
# Migration succeeded — tenant has the post-migration retention.
```

### Pre-deletion safety check

```bash
crossengin retention housekeeping --tenant <offboarding-tenant>
# Operator sees: every table's tenant policy is null OR opt-out=yes.
# Confirms there's nothing to delete tenant-side after offboarding.
```

### Per-tenant audit during compliance review

```bash
crossengin retention housekeeping --tenant <hipaa-tenant> --format json \
  | jq '.tables[] | select(.tenantPolicy != null) | {table: .tableName, retention: .tenantPolicy.retentionDays}'
# Yields a clean per-tenant override list for the audit report.
```

### CI gate combining cross-tenant + tenant drill-down

```bash
# Cross-tenant: alert when ANY table has > 1M rows pending prune.
crossengin retention housekeeping \
  --tenant <regulated-tenant> \
  --threshold-alert wouldPruneCount:>1000000
# Exit 3 if alert trips; tenantPolicy fields show the regulated tenant's
# overrides so reviewers can see "did this tenant's policy contribute?"
```

### Live monitoring during tier upgrade

```bash
crossengin retention housekeeping --watch --watch-interval 10 \
  --tenant <upgrading-tenant>
# 10s refresh; operator watches the tenant's tenantPolicy fields
# change from old retention to new during the migration.
```

## Testing

6 new CLI tests in retention-housekeeping.test.ts:

- Exit 2 on invalid --tenant value (non-UUID).
- Valid UUID renders tenantPolicy sections for the
  filtered tenant.
- Filter discriminates between tenants (TENANT_B sees
  its own override, NOT TENANT_A's).
- JSON envelope includes top-level tenantId + per-table
  tenantPolicy (null when no override).
- WITHOUT --tenant, envelope omits tenantId + per-table
  tenantPolicy entirely (backward compat).
- Composes with --threshold-alert (drill-down + CI gate
  together).

Workspace test count 9,611 → 9,617 (+6).
