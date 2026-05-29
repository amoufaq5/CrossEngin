# ADR-0264: Retention housekeeping unified dashboard

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-29 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0263 Q2 (workflow housekeeping equivalent — closes this Q via substrate-centric naming), ADR-0143 (retention substrate baseline), ADR-0155 (per-tenant retention), ADR-0153 (previewPrune), ADR-0258/0262 (gateway + rate-limit retention adding 2 of the 6 tables), ADR-0167 (retention list-policies), ADR-0174 (retention prune) |

## Context

After ADR-0263 shipped `crossengin gateway housekeeping` as the
operator-domain view scoped to gateway tables, three of the six
retention-substrate-governed tables still had no aggregate
read surface — `workflow_traces`, `llm_call_traces`,
`llm_latency_samples`, and `tenant_retention_opt_out_history`.
ADR-0263 Q2 documented this gap:

> "Workflow housekeeping equivalent for the other 3 prunable
> tables (workflow_traces + llm_call_traces +
> llm_latency_samples + tenant_retention_opt_out_history) —
> the retention substrate's table set has 6 entries today
> (M4.11.x) and only 3 are surfaced by this dashboard."

The naming-by-domain framing from that Q is partially right
but partially wrong. The 4 tables it lists span THREE distinct
operator domains:

- `workflow_traces` — workflow runtime observability (M8 lineage).
- `llm_call_traces` + `llm_latency_samples` — ai-router
  observability (M6.7.z / M6.7.y).
- `tenant_retention_opt_out_history` — retention substrate
  self-management (the audit log of policy mutations from
  ADR-0170).

A hypothetical `workflow housekeeping` action would only
cover one of those three domains. The other two would still
need their own dashboards (`ai-router housekeeping`,
`retention history housekeeping`, etc.) — fragmenting the
operator surface 4-way for what is conceptually one question:
*"how is my retention substrate doing across every table it
governs?"*

The common thread across the 4 non-gateway tables is exactly
that they're governed by `PostgresTraceRetention`'s
`PRUNABLE_TABLES` map. Naming the action by domain (workflow
/ ai-router / etc.) splits the dashboard along arbitrary
package boundaries. Naming by substrate (retention) keeps it
unified — and gives the action a clean dual to ADR-0263's
gateway dashboard:

| Action | Scope | Question answered |
|---|---|---|
| `gateway housekeeping` (ADR-0263) | 3 gateway-domain tables (`gateway_pipeline_executions`, `rate_limit_decisions`, `gateway_idempotency_records`) | "How is my GATEWAY's housekeeping doing?" |
| `retention housekeeping` (this ADR) | 6 retention-substrate-governed tables (all 6 PRUNABLE_TABLES) | "How is my RETENTION SUBSTRATE doing across every table it governs?" |

The two views deliberately OVERLAP on the 3 retention-
governed gateway tables (`gateway_pipeline_executions` and
`rate_limit_decisions`) — they ARE in BOTH views. That
overlap is intentional and informative:

- `gateway housekeeping` is the **operator-domain view** —
  what an SRE running the gateway cares about, including
  the idempotency table which uses its own `expires_at`
  TTL semantic (NOT retention-governed).
- `retention housekeeping` is the **substrate-centric view**
  — what an operator managing retention policies cares
  about, including all 6 tables uniformly under the
  retention-days semantic.

Operators choose the surface that matches their question.
A retention-policy manager sees all 6 tables in one place
without having to know which packages own which tables.
A gateway SRE sees the 3 gateway tables (including the
non-retention idempotency one) without having to know which
of those happen to also be retention-governed.

## Decision

Add `crossengin retention housekeeping` as the 16th retention
CLI action — a unified read-only dashboard scoped to ALL 6
PRUNABLE_TABLES from `PostgresTraceRetention`.

### Surface

```
$ crossengin retention housekeeping [--format human|json|...]
```

No filter flags. No mutating sub-options. Pure snapshot read.

### Per-table report

For each of the 6 tables, the report includes:

| Field | Source | Notes |
|---|---|---|
| `tableName` | hardcoded `RETENTION_HOUSEKEEPING_TABLES` list | the 6 PRUNABLE_TABLES entries |
| `totalRowCount` | `SELECT COUNT(*)::TEXT FROM meta.<tableName>` | direct PG read |
| `oldestAt` | `MIN(<time_col>)::TEXT FROM meta.<tableName>` | direct PG read; null when empty |
| `wouldPruneCount` | `previewPrune()` filtered to platform-level entries | per-tenant entries are distinct rows in preview output and intentionally skipped — they belong under `retention list-policies --tenant` |
| `retentionDays` | `listPolicies()` lookup by tableName | null when no platform policy |
| `enabled` | `listPolicies()` lookup | null when no policy |
| `lastPrunedAt` | `listPolicies()` lookup | null when no policy or never pruned |
| `perTenantPolicyCount` | `listTenantPolicies()` grouped by tableName | new field beyond ADR-0263's shape — gives operators "how much per-tenant noise is on this table?" at a glance |

### Round-trip count

5 PG round-trips per invocation, bounded regardless of how
many policies / tenants exist:

1. `retention.listPolicies()` once.
2. `retention.listTenantPolicies()` once.
3. `retention.previewPrune()` once.
4. 6 × `SELECT COUNT(*), MIN(time_col) FROM meta.<table>` (3 round-trips if PG batches; effectively bounded).

(The 6 stats SELECTs run sequentially in a `for` loop. PG
pipelining is operator-side concern — at typical scales the
sequential overhead is negligible.)

### Output formats

Reuses the standard 6-format support from ADR-0241 via
`printJson` (default human format renders multi-section text
report). JSON envelope:

```json
{
  "action": "retention.housekeeping",
  "asOf": "<ISO 8601>",
  "tables": [
    {
      "tableName": "workflow_traces",
      "totalRowCount": 1234567,
      "oldestAt": "<ISO 8601>" | null,
      "wouldPruneCount": 12345,
      "retentionDays": 90 | null,
      "enabled": true | null,
      "lastPrunedAt": "<ISO 8601>" | null,
      "perTenantPolicyCount": 2
    },
    ...
  ]
}
```

Always emits all 6 tables with null fields surfaced rather
than omitted — stable consumer parsing.

### Human format

Multi-section text report — one block per table with:

- Locale-formatted (en-US) row counts: `1,234,567`.
- `(empty)` fallback for null oldest.
- `(no platform policy configured)` for missing retention
  policy line.
- `tenant overrides: N` line for per-tenant policy count.

```
retention housekeeping (as of 2026-05-29T12:00:00.000Z):

  workflow_traces
    total rows:      1,234,567
    oldest row:      2026-04-01T00:00:00.000Z
    would prune:     12,345
    retention:       90 day(s) (enabled)
    last pruned:     2026-05-28T00:00:00.000Z
    tenant overrides: 2

  llm_call_traces
    total rows:      9,876,543
    ...
```

### Substrate-vs-domain naming rationale

The naming choice (`retention housekeeping` not `workflow
housekeeping` per ADR-0263 Q2) is the load-bearing decision
of this milestone:

- The 4 tables ADR-0263 Q2 grouped under "workflow
  housekeeping" span 3 distinct operator domains (workflow,
  ai-router, retention substrate).
- A workflow-named action would only cover 1 of those 3
  domains. The other 2 would need their own dashboards.
- The substrate-centric naming covers all 6 tables uniformly
  because all 6 ARE governed by `PostgresTraceRetention`.
- Operators choose the surface that matches their question:
  domain-centric (`gateway housekeeping`) or substrate-
  centric (`retention housekeeping`). The deliberate overlap
  on the 3 gateway-retention tables is informative not
  duplicative.

### Implementation

- New module `apps/architect-cli/src/retention-housekeeping.ts`
  housing `gatherRetentionHousekeepingReport` +
  `runRetentionHousekeeping` + `RETENTION_HOUSEKEEPING_TABLES`
  const + `RetentionHousekeepingContext` interface.
- New action branch in `apps/architect-cli/src/retention.ts`
  switch — short-circuits BEFORE `resolveRetention` because
  housekeeping manages its own connection lifecycle (needs
  raw PG for per-table COUNT/MIN queries on top of the
  retention adapter).
- `RetentionContext` widened to include
  `pgConnectionOverride?` + `clockOverride?` (matching the
  `GatewayContext` pattern from ADR-0263). All existing
  call sites remain valid since the new fields are optional.
- `cli.ts` `SUBCOMMANDS` unchanged (retention was already
  registered); help-text adds the new action with its full
  description.
- Dispatcher's missing-action + unknown-action error
  messages now list `housekeeping` in the action list.

## Rejected alternatives

1. **Name the action `workflow housekeeping` per ADR-0263 Q2
   verbatim.** Q2 grouped the 4 non-gateway tables as
   "workflow housekeeping" but the 4 tables span 3 distinct
   operator domains (workflow / ai-router / retention
   substrate). A workflow-named action would only cover 1
   of those 3 domains; the others would need their own
   fragmented dashboards. Substrate-centric naming covers
   all uniformly without forcing operators to know which
   package owns which table.

2. **Add the 4 non-gateway tables to ADR-0263's
   `gateway housekeeping` action.** Would muddle the
   operator-domain scope honesty of that ADR — a gateway
   SRE running `gateway housekeeping` would be surprised
   to see workflow_traces in the output. Two distinct
   surfaces is correct.

3. **Make the action mutating with `--prune` flag.** Same
   reasoning as ADR-0263 — separation of concerns; `retention
   prune` already exists for the destructive operation;
   `retention housekeeping --prune` would create two paths
   to the same outcome.

4. **Drop the per-tenant entries from previewPrune.**
   ADR-0263 didn't have this concern because none of its
   3 gateway-domain tables had per-tenant overrides. The
   retention-substrate surface DOES have per-tenant overrides
   on workflow_traces + llm_call_traces +
   tenant_retention_opt_out_history + gateway_pipeline_executions
   + rate_limit_decisions. Including them in
   `wouldPruneCount` would double-count and confuse — per-
   tenant detail belongs under `retention list-policies
   --tenant` not the dashboard. The platform-sweep total
   is what the dashboard surfaces; per-tenant noise is
   visible via the new `perTenantPolicyCount` field.

5. **Make `RETENTION_HOUSEKEEPING_TABLES` import the table
   list from `PostgresTraceRetention.knownPrunableTables()`
   dynamically.** Tighter coupling but the substrate doesn't
   expose `timeColumn` publicly (operators don't need that
   detail for the read-only contract). A hardcoded 6-entry
   list with (tableName, timeColumn) tuples is more honest
   about what the dashboard knows + lets the list be
   filtered/reordered without substrate changes.

6. **Reuse ADR-0263's `gather*HousekeepingReport` shape
   verbatim.** ADR-0263's report has `pruneSemantic` field
   distinguishing retention_days vs expires_at — all 6
   retention tables use retention_days so that field is
   pointless here. Instead this ADR adds `perTenantPolicyCount`
   which is meaningful for retention but always 0 for
   gateway (which has no per-tenant overrides on its
   idempotency table). Different reports for different
   surfaces.

7. **Surface listTenantPolicies output directly instead of
   counting.** The 5-field tenant policy row is too much
   detail for a dashboard; the count gives operators the
   "how much override noise?" signal at a glance + the
   detail is one command away via `retention list-policies
   --tenant <uuid>`.

## Drawbacks

1. **6 stats SELECTs run sequentially** — at typical scales
   (millions of rows per table) each SELECT is index-only
   + sub-second; parallel execution via Promise.all is
   future-Q. Sequential is fine for v1.

2. **Deliberate overlap with `gateway housekeeping` on 3
   tables** — gateway_pipeline_executions and
   rate_limit_decisions appear in BOTH surfaces. Documented
   as intentional (substrate-centric vs operator-domain
   views), but operators reading both outputs see those
   tables twice with slightly different framing
   (`pruneSemantic` field in gateway view, `perTenantPolicyCount`
   field in retention view).

3. **No per-table filter flag** — `retention housekeeping
   --table workflow_traces` would be a useful "drill down"
   but adds CLI surface; for v1 operators jq-filter on
   JSON output.

4. **Per-tenant policy count is a single integer** — doesn't
   distinguish enabled overrides from active opt-outs.
   Operators wanting that detail run
   `retention list-policies --table <name>` separately.

5. **PG-env required even on read-only dashboard** — same
   constraint as every other retention action; matches the
   existing pattern.

## Future Qs

1. **Add a `pruneSemantic` field for consistency with
   ADR-0263's envelope shape.** All 6 retention tables
   would have `"retention_days"` so the field is constant
   but its presence would let operators write surface-
   agnostic JSON parsers across both dashboards.

2. **Parallelize the 6 stats SELECTs via Promise.all.**
   At very-high-volume tables (10B+ rows) the sequential
   overhead may become noticeable. Defer until measured.

3. **Add `--tenant <uuid>` filter mode** that scopes the
   `perTenantPolicyCount` to one tenant and adds a
   `tenantOverrides[]` field listing that tenant's
   overrides per table. Closes the "drill-down" gap.

4. **`--threshold-alert <field>:<value>` CI gate flag**
   matching ADR-0263 Q4 — exit non-zero when any of:
   wouldPruneCount > N, oldestAt > N days ago,
   lastPrunedAt > N days ago across any table.

5. **Surface `gateway_idempotency_records` here too via
   `expires_at` semantic.** Would unify the gateway +
   retention views into one super-dashboard. Defer because
   the substrate-vs-domain distinction is the point of this
   milestone.

6. **`--watch` mode** matching ADR-0263 Q3 — re-renders
   every N seconds for incident-room monitoring.

## Operator workflow examples

### Daily-driver dashboard

```bash
crossengin retention housekeeping
```

Reads all 6 tables + their retention state + per-tenant
override counts in one command. Operators see at a glance
which tables are growing fast, which have no platform
policy configured, which haven't been pruned in a while,
and which have a lot of per-tenant override noise.

### JSON snapshot for monitoring

```bash
crossengin retention housekeeping --format json > snapshot.json
jq '.tables[] | select(.lastPrunedAt == null) | .tableName' snapshot.json
```

Lists every table never pruned (operators investigating
why automated pruning isn't running).

### Drilling into a noisy table

After dashboard surfaces "workflow_traces: tenant
overrides: 47", operator runs:

```bash
crossengin retention list-policies --table workflow_traces
```

To see the 47 per-tenant entries individually.

### CI invariant check

```bash
ROWS=$(crossengin retention housekeeping --format json | \
  jq '.tables[] | select(.tableName == "llm_call_traces") | .wouldPruneCount')
if [ "$ROWS" -gt 1000000 ]; then
  echo "WARN: llm_call_traces has $ROWS rows pending prune"
  exit 1
fi
```

Wires the dashboard into deploy-gate pipelines.
