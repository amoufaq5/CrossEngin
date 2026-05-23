# ADR-0232: Retention CLI `summary` action (aggregate counts by dimension)

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.summary
- **Closes**: New operator-facing aggregate-reporting feature (implicit
  gap across the retention CLI polish milestones)
- **Related**: ADR-0206 (retention history surface), ADR-0224 (envelope
  conventions), ADR-0226/0230 (contradiction detection), ADR-0227/0231
  (output formats), ADR-0229 (query builders)

## Context

The retention CLI has rich row-level query surfaces (history, diff-
history, diff-timeline) but no aggregate-reporting surface. Operators
wanting "how many opt_out_set vs policy_deleted events per tenant this
month" must either:
1. Pull all rows via `retention history` and aggregate client-side
   (slow, memory-heavy for large audit logs).
2. Write custom SQL against `meta.tenant_retention_opt_out_history`.

This milestone adds a `retention summary` action that aggregates
opt-out/policy mutation history counts grouped by a single dimension,
returning buckets `{key, count}` plus a total. Operator-dashboard
backing without custom SQL.

### Operator use cases

1. **Kind breakdown** — `retention summary --group-by kind` →
   "12 opt_out_set, 3 opt_out_cleared, 1 policy_deleted".
2. **Tenant cohort report** — `retention summary --group-by tenant
   --since 2026-05-01` → "tenant A: 40, tenant B: 12, ...".
3. **Actor leaderboard** — `retention summary --group-by actor` → which
   actors drive the most mutations (null actor → `<system>`).
4. **Table distribution** — `retention summary --group-by table` →
   mutations per prunable table.
5. **Filtered aggregation** — compose with the existing filter family
   (`--kind`, `--actor-id-not`, `--system-only`, `--since`/`--until`)
   for scoped reports.

## Decision

Add a `retention summary` action that aggregates history counts grouped
by one dimension (kind / tenant / actor / table) with the existing
filter family.

### Adapter

New types + method on `PostgresTraceRetention`:

```ts
export type OptOutHistorySummaryGroupBy = "kind" | "tenant" | "actor" | "table";

export interface SummarizeOptOutHistoryInput {
  readonly tenantId?: string;
  readonly tableName?: string;
  readonly eventKinds?: ReadonlyArray<OptOutHistoryEventKind>;
  readonly eventKindsNot?: ReadonlyArray<OptOutHistoryEventKind>;
  readonly actorIds?: ReadonlyArray<string>;
  readonly actorIdsNot?: ReadonlyArray<string>;
  readonly actorPresence?: ActorPresenceFilter;
  readonly since?: string;
  readonly until?: string;
  readonly groupBy: OptOutHistorySummaryGroupBy;
}

export interface OptOutHistorySummaryBucket {
  readonly key: string | null;
  readonly count: number;
}

export interface OptOutHistorySummaryResult {
  readonly groupBy: OptOutHistorySummaryGroupBy;
  readonly totalCount: number;
  readonly buckets: ReadonlyArray<OptOutHistorySummaryBucket>;
}
```

Plus `buildSummarizeOptOutHistoryQuery(input): {sql, params}` (following
ADR-0229's builder pattern for `--explain` support) and
`summarizeOptOutHistory(input): Promise<OptOutHistorySummaryResult>`.

### SQL shape

```sql
SELECT <group-col> AS key, COUNT(*)::bigint AS count
FROM meta.tenant_retention_opt_out_history h
WHERE <filters>
GROUP BY <group-col>
ORDER BY COUNT(*) DESC, <group-col> ASC
```

Where `<group-col>` maps:
- `kind` → `h.event_kind`
- `tenant` → `h.tenant_id`
- `actor` → `h.actor_id` (null preserved → `<system>` in human format)
- `table` → `h.table_name`

`COUNT(*)::bigint` cast ensures consistent numeric handling; the
adapter parses string bigint into JS number and accumulates
`totalCount`.

### Filter reuse

The summary input reuses the established filter family from
`listOptOutHistory`: tenantId, tableName, eventKinds, eventKindsNot,
actorIds, actorIdsNot, actorPresence, since, until. The WHERE-building
mirrors the other adapter builders (parameterized IN / NOT IN / IS
NULL / range conditions).

### CLI handler

`runRetentionSummary` parses:
- `--group-by kind|tenant|actor|table` (default `kind`; invalid → exit 2)
- The full filter family (--tenant / --table / --kind / --kind-not /
  --actor-id / --actor-id-not / --system-only / --no-system / --since /
  --until)
- `--format`, `--explain`, `--csv-separator` (output controls)

Reuses contradiction detection (ADR-0226 same-dimension + ADR-0230
cross-dimensional) — `--kind X --kind-not X`, `--actor-id Y
--actor-id-not Y`, `--system-only --actor-id Z` all exit 2.

### Output formats

- **human**: `Summary by {dim} (total: N events)` + aligned `key  count`
  table; null key → `<system>`; empty → `(no events match the given
  filters)`.
- **json**: `{action: "summary", groupBy, totalCount, buckets}`.
- **csv/tsv**: header `{dim},count` + bucket rows.
- **ndjson**: one bucket `{key, count}` per line.
- **--explain**: query plan + raw SQL (via builder, per ADR-0229).

### Dispatch + help

Added `summary` to the retention action dispatch + usage strings + a
dedicated help block documenting the group-by dimensions + filter
reuse + format support.

## Rejected alternatives

1. **Multi-dimensional group-by (`--group-by kind,tenant`)** — would
   require composite-key buckets + cross-tab rendering; significant
   scope. Single-dimension is the common operator need; defer multi-dim.
2. **Time-bucket grouping (`--group-by day|hour|week`)** — would
   require `date_trunc` + timezone handling; valuable but separate
   scope. Defer as future Q.
3. **Top-N limit (`--top 10`)** — buckets are already ordered by count
   DESC; operators can pipe through `head`. Defer.
4. **Percentage column** — operators can compute from count/total.
   Defer; keep output minimal.
5. **Aggregate functions beyond COUNT (MIN/MAX/AVG occurred_at)** —
   COUNT is the canonical aggregate for event logs; other aggregates
   are niche. Defer.
6. **Reuse `listOptOutHistory` + client-side aggregation** — defeats
   the purpose (server-side GROUP BY is far more efficient for large
   audit logs).
7. **Separate `retention count` action for just totals** — `summary`
   with buckets subsumes a pure count (total is included). No need for
   a separate action.
8. **`--group-by none` for grand-total-only** — operators can read
   `totalCount` from any group-by; a dedicated none mode adds little.
9. **Pagination on summary buckets** — bounded cardinality (4 event
   kinds; tenant/actor/table counts are typically small); pagination
   premature. Defer.
10. **GROUP BY with HAVING count filter (`--min-count 5`)** — operators
    can post-filter; HAVING adds query complexity. Defer.

## Future questions

1. **Time-bucket grouping (`--group-by day|hour|week|month`)** — adds
   `date_trunc('<unit>', occurred_at)` grouping for histogram-style
   reports. Requires timezone handling decision (UTC default). Defer —
   high-value follow-up.

2. **Multi-dimensional group-by** — `--group-by kind --then-by tenant`
   for cross-tab. Composite buckets + tabular rendering. Defer.

3. **`--top N` limit** — limit buckets to top N by count. Defer —
   operators can `head` the output.

4. **HAVING-style `--min-count N`** — filter buckets below a threshold.
   Defer — operators can post-filter.

5. **Percentage / cumulative columns** — `count`, `percent`,
   `cumulative` columns. Defer — operators compute from count/total.

6. **Summary across retention diff-timeline / diff-history surfaces** —
   currently summary only aggregates the history table. Diff-timeline
   and diff-history are comparison surfaces, not naturally aggregatable.
   N/A — summary is a history-table aggregate.

## Consequences

- **Operators get aggregate reporting without custom SQL** — kind /
  tenant / actor / table breakdowns with the full filter family;
  server-side GROUP BY is efficient for large audit logs.
- **15th retention CLI action** — joins expiring, effective, effective-
  batch, opt-out, opt-in, set, delete, list-policies, history, restore,
  diff-history, diff-timeline, diff, prune.
- **Test count: 9,257 → 9,280** (+23 net: 10 adapter tests for builder +
  method, 13 CLI tests for handler + formats + explain + contradictions).
- **Reuses established infrastructure** — filter family, contradiction
  detection (ADR-0226/0230), output formats (ADR-0227/0231), query
  builder pattern (ADR-0229).
- **All 5 output formats supported** — human (aligned table), json, csv,
  tsv, ndjson; plus --explain raw SQL.
- **No breaking changes** — `summary` is a NEW action; existing actions
  unchanged.
- **Adapter contract enriched** — `summarizeOptOutHistory` +
  `buildSummarizeOptOutHistoryQuery` public methods; downstream
  consumers can aggregate directly.
- **Time-bucket grouping is the natural follow-up** — `--group-by day`
  for histogram-style retention activity reports.
