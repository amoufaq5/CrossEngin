# ADR-0236: Retention summary gap-filling (`--fill-gaps` zero-count buckets)

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.summary.gap-fill
- **Closes**: ADR-0234 future Q4 + ADR-0235 future Q3 (gap-filling zero-
  count buckets)
- **Related**: ADR-0234 (time-bucket grouping), ADR-0235 (cross-tab),
  ADR-0232 (summary action)

## Context

ADR-0234 added temporal `--group-by` (day/hour/week/month) for histogram-
style reports, but `GROUP BY` only emits buckets for time periods that
have events. A day with zero mutations is simply absent from the output,
leaving gaps in the histogram. Operators plotting activity over time want
a continuous series — empty days should show count=0, not vanish.

This ADR adds `--fill-gaps` to emit zero-count buckets for empty time
periods via PostgreSQL's `generate_series`, closing ADR-0234 Q4 +
ADR-0235 Q3.

### Operator use cases

1. **Continuous daily histogram** — `--group-by day --since 2026-05-01
   --until 2026-05-31 --fill-gaps` → one row per day for the whole month,
   including zero-activity days.
2. **Incident hourly timeline** — `--group-by hour --since/--until
   incident-window --fill-gaps` → every hour shown, even quiet ones.
3. **Charting-ready output** — gap-filled CSV/ndjson feeds directly into
   plotting tools without client-side gap interpolation.

## Decision

Add a `--fill-gaps` boolean flag that, for single-dimension temporal
grouping, emits zero-count buckets spanning the `[since, until]` range
via `generate_series` + LEFT JOIN.

### Preconditions (validated CLI-side + adapter-side)

`--fill-gaps` requires:
1. **Temporal `--group-by`** (day/hour/week/month) — categorical
   dimensions (kind/tenant/actor/table) have unbounded or non-enumerable
   domains; gap-filling them is meaningless (you can't enumerate "all
   possible actors"). Exit 2 otherwise.
2. **Both `--since` AND `--until`** — the bucket range must be bounded;
   unbounded gap-filling (all history) is impossible. Exit 2 otherwise.
3. **NOT `--then-by`** — cross-tab gap-filling needs a cartesian product
   of (time-buckets × secondary-values), significantly more complex.
   Deferred. Exit 2 otherwise.

Both the CLI and the adapter builder enforce these (the adapter throws;
the CLI exits 2 with a friendly message before reaching the adapter).

### SQL — generate_series + LEFT JOIN

```sql
SELECT b.bucket::text AS key, COUNT(h.id)::bigint AS count
FROM generate_series(
  date_trunc('<unit>', $1::timestamptz AT TIME ZONE 'UTC'),
  date_trunc('<unit>', $2::timestamptz AT TIME ZONE 'UTC'),
  interval '1 <unit>'
) AS b(bucket)
LEFT JOIN meta.tenant_retention_opt_out_history h
  ON date_trunc('<unit>', h.occurred_at AT TIME ZONE 'UTC') = b.bucket
  AND h.occurred_at >= $1
  AND h.occurred_at <= $2
  [AND <other filters>]
GROUP BY b.bucket
ORDER BY b.bucket ASC
```

Key design points:

1. **`generate_series` spans the range** — buckets from `date_trunc(since)`
   to `date_trunc(until)` stepping by `interval '1 <unit>'`. Every period
   in range appears as a bucket row, even with no matching events.

2. **`COUNT(h.id)` not `COUNT(*)`** — `COUNT(*)` would count the bucket
   row itself (1) even with no matching event; `COUNT(h.id)` counts only
   non-null joined event IDs, yielding 0 for empty buckets.

3. **Filters live in the LEFT JOIN ON clause, NOT WHERE** — if filters
   were in WHERE, the LEFT JOIN would degenerate to INNER (rows with no
   match get NULL h.*, which a WHERE filter would exclude, removing the
   zero-count bucket). Putting filters in ON preserves zero-count buckets.
   This is the canonical LEFT-JOIN-with-filtered-right-side pattern.

4. **`since`/`until` reused as `$1`/`$2`** — bound both the
   `generate_series` range AND the event `occurred_at` range (so events
   slightly outside the truncated bucket boundary but inside [since,
   until] are correctly attributed; events outside [since, until] are
   excluded even if their truncated bucket is in range).

5. **`$1`/`$2` first, filters `$3+`** — the gap-filling path builds its
   own param order (since, until, then other filters) distinct from the
   normal path's ordering.

### Adapter

`SummarizeOptOutHistoryInput` gains `fillGaps?: boolean`. The builder
branches to a private `buildGapFilledSummaryQuery` when `fillGaps ===
true`. The `summarizeOptOutHistory` method is unchanged — it parses the
bigint count (now including explicit zeros) and accumulates totalCount.

### CLI

`--fill-gaps` boolean flag with the 3 precondition validations (temporal,
since+until, no then-by). Threads `fillGaps` to the adapter input. The
`--explain` plan echoes `fillGaps`.

### Output formats

All formats render gap-filled buckets identically to normal buckets —
zero-count buckets are just buckets with `count: 0`. Human format shows
the zero rows; csv/tsv/ndjson include them; json buckets array includes
them.

## Rejected alternatives

1. **Gap-fill categorical dimensions (enumerate all kinds)** — `kind`
   is bounded (4 values) so technically enumerable, but `tenant` /
   `actor` / `table` are unbounded; gap-filling them requires a known
   universe. Inconsistent to support only `kind`; restrict gap-filling
   to temporal where the range bounds the universe. Defer categorical
   gap-fill.
2. **Default `--since`/`--until` to data min/max when gap-filling** —
   would require a pre-query to find the range; two round-trips;
   operators specifying a range is clearer + bounded.
3. **Filters in WHERE with COALESCE** — degenerates LEFT JOIN to INNER;
   zero-count buckets vanish. ON-clause filters are required.
4. **`COUNT(*)` with NULLIF** — `COUNT(*)` counts the bucket row;
   `COUNT(h.id)` is the clean idiom for "count matched events".
5. **Client-side gap-filling (CLI fills gaps after fetching)** — the CLI
   would need to know the unit interval + iterate; SQL `generate_series`
   is the canonical server-side approach + handles DST/leap correctly.
6. **Cross-tab gap-filling in the same milestone** — cartesian product
   of (time-buckets × secondary-values) is significantly more complex;
   defer (ADR-0235 Q3 family).
7. **`--fill-gaps` without requiring `--until` (fill to now())** — `now()`
   is non-deterministic + couples output to query time; explicit
   `--until` is clearer.
8. **A separate `retention histogram` action** — `summary --group-by day
   --fill-gaps` is the histogram; a separate action would duplicate the
   filter family.

## Future questions

1. **Cross-tab gap-filling** — `--group-by day --then-by kind
   --fill-gaps` would fill (day × kind) cells. Cartesian product of
   `generate_series` × `DISTINCT kinds` (or the 4-value enum). Defer —
   ADR-0235 Q3 family; complex for unbounded secondary dimensions.

2. **Categorical gap-filling for bounded `kind`** — enumerate the 4
   event kinds as zero-count buckets when absent. Defer — inconsistent
   to support only `kind` among categorical dimensions.

3. **`--fill-gaps` default range from data min/max** — auto-detect the
   range via a pre-query. Defer — explicit range is clearer.

4. **Custom timezone for gap-fill bucketing** — pairs with ADR-0234 Q1
   (`--timezone`). The `generate_series` + `date_trunc` would use the
   custom TZ. Defer.

5. **Sparse-to-dense threshold** — only gap-fill if the gap ratio
   exceeds a threshold (avoid huge zero-filled ranges). Defer —
   operators control via `--since`/`--until` range.

6. **`generate_series` performance for large ranges** — hourly buckets
   over a year = 8760 rows; fine. Minute buckets over a year = 525k
   rows; could be slow. Document the range × unit cardinality
   consideration. Defer — operators choose sensible ranges.

## Consequences

- **Operators get continuous histograms** — empty time periods show
  count=0 instead of vanishing; charting-ready output without client-
  side gap interpolation.
- **Test count: 9,304 → 9,316** (+12 net: 6 adapter gap-filling tests,
  6 CLI validation + threading + rendering tests).
- **LEFT JOIN ON-clause filter pattern** — filters in ON (not WHERE)
  preserve zero-count buckets; the canonical SQL idiom documented.
- **`COUNT(h.id)` for zero-count** — distinguishes "bucket with no
  events" (0) from "bucket row" (would be 1 with COUNT(*)).
- **3 preconditions enforced** — temporal group-by + since/until +
  no-then-by; CLI exits 2 with friendly messages; adapter throws as
  defense-in-depth.
- **Backward compatible** — `--fill-gaps` is ADDITIVE; without it,
  summary behaves exactly as before (sparse buckets).
- **No SQL injection surface** — `<unit>` from validated enum + fixed
  interval literal; filters parameterized.
- **Cross-tab + categorical gap-fill are the natural follow-ups** — this
  single-dimension temporal gap-fill is the foundation.
