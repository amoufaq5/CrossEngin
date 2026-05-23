# ADR-0235: Retention summary cross-tab grouping (`--then-by` second dimension)

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.summary.cross-tab
- **Closes**: ADR-0232 future Q2 (multi-dimensional group-by) + ADR-0234
  future Q3 (cross-tab categorical × temporal)
- **Related**: ADR-0232 (summary action), ADR-0234 (time-bucket grouping),
  ADR-0229 (query builders)

## Context

ADR-0232 introduced single-dimension `retention summary` grouping;
ADR-0234 added temporal dimensions. Both flagged cross-tab (two-
dimensional grouping) as the deepest analytics follow-up. Operators want
breakdowns like "daily volume per event_kind" or "per-tenant daily
activity" — a grid of (primary × secondary) counts.

This ADR adds a `--then-by <dimension>` flag producing composite
`{key, subKey, count}` buckets, closing ADR-0232 Q2 + ADR-0234 Q3.

### Operator use cases

1. **Daily per-kind volume** — `--group-by day --then-by kind` →
   "2026-05-20 / opt_out_set: 5, 2026-05-20 / policy_deleted: 2, ...".
2. **Per-tenant daily activity** — `--group-by tenant --then-by day` →
   each tenant's daily mutation timeline.
3. **Kind × actor cross-tab** — `--group-by kind --then-by actor` →
   which actors drive which mutation kinds.
4. **Filtered cross-tab** — compose with the full filter family.

## Decision

Add an optional `--then-by <dimension>` second grouping dimension. When
set, the result is a cross-tab of composite buckets.

### Adapter

```ts
export interface SummarizeOptOutHistoryInput {
  // ... existing single-dimension fields
  readonly groupBy: OptOutHistorySummaryGroupBy;
  readonly thenBy?: OptOutHistorySummaryGroupBy;  // NEW
}

export interface OptOutHistorySummaryBucket {
  readonly key: string | null;
  readonly subKey?: string | null;  // present only when thenBy set
  readonly count: number;
}

export interface OptOutHistorySummaryResult {
  readonly groupBy: OptOutHistorySummaryGroupBy;
  readonly thenBy?: OptOutHistorySummaryGroupBy;  // NEW
  readonly totalCount: number;
  readonly buckets: ReadonlyArray<OptOutHistorySummaryBucket>;
}
```

### SQL (cross-tab)

```sql
SELECT <primary-key-expr> AS key,
       <secondary-key-expr> AS sub_key,
       COUNT(*)::bigint AS count
FROM meta.tenant_retention_opt_out_history h
WHERE <filters>
GROUP BY <primary-col>, <secondary-col>
ORDER BY <primary-col> ASC, <secondary-col> ASC
```

The dimension resolution (categorical column vs `date_trunc` temporal
expression) is extracted into a `resolveDimension` helper used for both
primary and secondary dimensions. This means any dimension can be
primary OR secondary — categorical × categorical, categorical ×
temporal, temporal × categorical, temporal × temporal all work.

### Ordering: grid vs leaderboard

- **Single-dimension** (no `--then-by`): categorical → `COUNT(*) DESC`
  (leaderboard); temporal → `key ASC` (chronological). [unchanged from
  ADR-0232/0234]
- **Cross-tab** (`--then-by` set): `ORDER BY primary ASC, secondary ASC`
  — a deterministic, readable grid. Count-DESC ordering doesn't apply to
  cross-tab since each (primary, secondary) pair has its own count;
  reading the grid requires stable key ordering. Temporal dimensions
  remain chronological within the grid; categorical sort alphabetically.

### Validation

- `--then-by` must be a valid dimension (same enum as `--group-by`).
- `--then-by` must DIFFER from `--group-by` (can't cross-tab a dimension
  with itself — that's just the single dimension). Exit 2 with explicit
  error.

### Result shape discrimination

- Single-dimension result: buckets are `{key, count}` (no `subKey`); the
  result has no `thenBy`.
- Cross-tab result: buckets are `{key, subKey, count}`; the result has
  `thenBy`.

The adapter conditionally includes `subKey` / `thenBy` based on whether
`input.thenBy` is set, preserving backward compatibility with single-
dimension consumers.

### Output formats

- **human**: `Summary by {primary} × {secondary} (total: N events)` +
  3-column grid (`key  subKey  count`).
- **json**: `{action, groupBy, thenBy, totalCount, buckets[{key, subKey,
  count}]}`.
- **csv/tsv**: 3-column header `{primary},{secondary},count` + grid rows.
- **ndjson**: one composite bucket per line.
- **--explain**: plan includes `thenBy` + cross-tab SQL.

## Rejected alternatives

1. **Three or more dimensions (`--then-by X --then-by Y`)** — n-way
   cross-tabs have exponential row growth + complex rendering; two
   dimensions cover the common operator need. Defer.
2. **Count-DESC ordering for cross-tab** — scrambles the grid; each
   (primary, secondary) pair has its own count, so a single count
   ordering is meaningless for grid reading. Grid order (primary ASC,
   secondary ASC) is canonical.
3. **Pivot/wide format (one column per secondary value)** — would
   require dynamic column generation + sparse handling; the long format
   (one row per (primary, secondary)) is simpler + streams to CSV/ndjson
   naturally. Operators can pivot client-side.
4. **Separate `--bucket` flag only for temporal secondary** — less
   general than `--then-by` (which allows any × any); `--then-by`
   subsumes the temporal-secondary case.
5. **Reject temporal × temporal (day × hour)** — unusual but valid
   (e.g., day-of-week × hour-of-day patterns would need extract not
   trunc, but day × hour cross-tab is coherent); allow it.
6. **Allow `--then-by` == `--group-by` (degenerate to single)** —
   confusing; exit-2 forces operator clarity.
7. **Composite key as a single concatenated string (`day|kind`)** —
   loses structured access; separate `key` + `subKey` fields are
   cleaner for JSON/programmatic consumers.
8. **Gap-filling the cross-tab grid (zero-count cells)** — sparse grid
   is the natural GROUP BY output; gap-filling both dimensions is
   complex (cartesian product). Defer (ADR-0234 Q4 family).

## Future questions

1. **N-way cross-tab (3+ dimensions)** — `--group-by` + multiple
   `--then-by`. Exponential rows; defer.

2. **Pivot/wide rendering** — `--pivot` flag rendering secondary values
   as columns. Defer — long format streams better.

3. **Gap-filling cross-tab cells** — zero-count cells for missing
   (primary, secondary) combinations via cartesian `generate_series` ×
   `DISTINCT`. Defer — ADR-0234 Q4 family.

4. **Cross-tab totals (row/column subtotals)** — `GROUPING SETS` /
   `ROLLUP` for marginal totals. Defer — operators compute from buckets.

5. **`--then-by` temporal with custom timezone** — pairs with ADR-0234
   Q1 (`--timezone`). Defer.

6. **Sort cross-tab by count within primary group** — `ORDER BY primary
   ASC, count DESC` (each primary group's secondaries leaderboard-
   ordered). Defer — grid order (both ASC) is the default; count-within-
   group could be a `--then-by-order count` future flag.

## Consequences

- **Operators get cross-tab analytics** — daily-per-kind, per-tenant-
  daily, kind-by-actor breakdowns; the deepest summary analytics feature.
- **`resolveDimension` helper extracted** — dimension → SQL column/expr
  resolution is now reusable for both primary + secondary; any dimension
  can be primary OR secondary.
- **Test count: 9,292 → 9,304** (+12 net: 5 adapter cross-tab tests, 7
  CLI cross-tab tests).
- **Backward compatible** — single-dimension summary unchanged (no
  `subKey` / `thenBy` when `--then-by` not set); ADDITIVE.
- **Grid ordering** — cross-tab orders (primary ASC, secondary ASC) for
  readable grids; single-dimension retains count-DESC / chronological.
- **All output formats support cross-tab** — human 3-column grid, json
  with subKey, csv/tsv 3-column, ndjson composite buckets, --explain
  cross-tab SQL.
- **`--then-by` validation** — must be valid + differ from `--group-by`;
  exit 2 otherwise.
- **Any × any dimension combination** — categorical × categorical,
  categorical × temporal, temporal × categorical, temporal × temporal
  all supported via the shared dimension resolver.
- **Pivot + gap-filling + n-way are the natural follow-ups** — this
  long-format cross-tab is the foundation.
