# ADR-0234: Retention summary time-bucket grouping (`--group-by day|hour|week|month`)

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.summary.time-bucket
- **Closes**: ADR-0232 future Q1 (time-bucket grouping)
- **Related**: ADR-0232 (summary action), ADR-0229 (query builders),
  ADR-0227/0231 (output formats)

## Context

ADR-0232 introduced `retention summary` with categorical grouping
(kind / tenant / actor / table) and flagged time-bucket grouping as the
highest-value follow-up (Q1). Operators want histogram-style activity
reports: "daily opt-out activity over the last month", "hourly mutation
volume during an incident window".

This ADR extends `--group-by` with temporal dimensions (day / hour /
week / month) using PostgreSQL's `date_trunc`, closing ADR-0232 Q1.

### Operator use cases

1. **Daily activity histogram** — `retention summary --group-by day
   --since 2026-05-01` → one row per day with mutation counts.
2. **Incident-window hourly volume** — `retention summary --group-by
   hour --since '2026-05-20T00:00' --until '2026-05-20T23:59'` →
   hourly breakdown during an incident.
3. **Monthly trend** — `retention summary --group-by month` → long-term
   retention-activity trend.
4. **Filtered time-series** — compose with `--kind opt_out_set
   --group-by day` → daily opt-out volume specifically.

## Decision

Extend `OptOutHistorySummaryGroupBy` with four temporal dimensions and
map them to `date_trunc` in the SQL builder, with chronological ordering.

### Type extension

```ts
export type OptOutHistorySummaryGroupBy =
  | "kind" | "tenant" | "actor" | "table"   // categorical (ADR-0232)
  | "day" | "hour" | "week" | "month";       // temporal (this ADR)
```

### SQL builder — temporal grouping

```sql
SELECT date_trunc('<unit>', h.occurred_at AT TIME ZONE 'UTC')::text AS key,
       COUNT(*)::bigint AS count
FROM meta.tenant_retention_opt_out_history h
WHERE <filters>
GROUP BY date_trunc('<unit>', h.occurred_at AT TIME ZONE 'UTC')
ORDER BY date_trunc('<unit>', h.occurred_at AT TIME ZONE 'UTC') ASC
```

Where `<unit>` ∈ {day, hour, week, month}.

Key design points:

1. **UTC normalization** — `h.occurred_at AT TIME ZONE 'UTC'` ensures
   deterministic bucketing regardless of the PG session timezone.
   `occurred_at` is `timestamptz`; `AT TIME ZONE 'UTC'` converts to the
   UTC wall-clock `timestamp` before truncating. Day boundaries are UTC
   midnight.

2. **`::text` cast** — the truncated timestamp is cast to text so the
   bucket `key` is a string (matching the `OptOutHistorySummaryBucket.key:
   string | null` shape). Format: `2026-05-20 00:00:00`.

3. **Chronological ordering** — temporal dimensions sort by `key ASC`
   (chronological), NOT `COUNT(*) DESC`. A histogram reads left-to-right
   in time order; a leaderboard reads top-down by count. The builder
   branches: categorical → `COUNT(*) DESC, col ASC`; temporal → `col ASC`.

4. **Literal unit mapping** — the unit string comes from a fixed map
   (`{day: "day", hour: "hour", ...}`), NOT free-form interpolation. The
   CLI validates `--group-by` against the enum before the builder runs,
   so only known literals reach `date_trunc('<unit>', ...)`. No SQL
   injection surface.

### Adapter behavior

`summarizeOptOutHistory` is unchanged — it parses the bigint count and
accumulates `totalCount`. The `key` for temporal buckets is the
timestamp text string (never null, since `occurred_at` is NOT NULL).

### CLI

`isSummaryGroupBy` extended to accept the 4 temporal values. The
`--group-by` error message lists all 8 valid values. Help text documents
the categorical-vs-temporal ordering distinction + UTC bucketing.

### Output formats

All existing summary formats work unchanged for temporal grouping:
- **human**: `Summary by day (total: N events)` + chronological key/count
  table.
- **json**: `{action: "summary", groupBy: "day", totalCount, buckets}`.
- **csv/tsv**: `day,count` header + chronological rows.
- **ndjson**: one `{key, count}` per line.
- **--explain**: raw SQL showing the `date_trunc` expression.

## Rejected alternatives

1. **Separate `--bucket day|hour` flag orthogonal to `--group-by`** —
   would enable cross-tab (group by kind AND bucket by day), but that's
   multi-dimensional (ADR-0232 Q2, deferred). Single `--group-by`
   dimension keeps the model simple; temporal is just more dimension
   options.
2. **Session-timezone bucketing (no `AT TIME ZONE 'UTC'`)** — non-
   deterministic; the same data would bucket differently depending on
   the PG session timezone. UTC is the canonical audit-log timezone.
3. **`--timezone <tz>` flag for custom bucketing timezone** — adds
   complexity; UTC is the right default for audit logs; operators
   needing local-time buckets can post-process. Defer.
4. **Return truncated timestamp as epoch millis (number) instead of
   text** — text ISO-ish format is more human-readable + sorts
   correctly; epoch would require client-side formatting.
5. **Chronological ordering as count DESC like categorical** — a time-
   series histogram MUST read in time order; count DESC would scramble
   the timeline.
6. **`quarter` / `year` / `minute` units** — day/hour/week/month cover
   the common operator needs; additional units can be added later
   following the same pattern. Defer.
7. **ISO-8601 `T`-separated timestamp keys (`2026-05-20T00:00:00Z`)** —
   PG's `::text` cast gives `2026-05-20 00:00:00` (space-separated, no
   TZ suffix); reformatting to ISO-8601 would add adapter complexity;
   the space-separated form sorts identically + is readable. Defer
   reformatting.
8. **Interpolate `--group-by` value directly into `date_trunc`** — even
   though validated, using a fixed literal map is clearer + defends
   against future validation regressions.

## Future questions

1. **`--timezone <tz>` for non-UTC bucketing** — operators wanting local-
   time day boundaries (e.g., "America/New_York midnight"). Defer — UTC
   default covers most audit use cases.

2. **`quarter` / `year` / `minute` temporal units** — extend the
   temporal unit map. Defer — current 4 cover common needs.

3. **Cross-tab (categorical × temporal)** — `--group-by kind --bucket
   day` for "daily opt_out_set vs policy_deleted volume". This is
   ADR-0232 Q2 (multi-dimensional group-by). Defer.

4. **Gap-filling (zero-count buckets for empty days)** — a histogram
   with missing days has gaps; `generate_series` could fill zero-count
   buckets. Defer — operators can detect gaps client-side; gap-filling
   adds query complexity.

5. **ISO-8601 `T`-separated + TZ-suffixed key format** — reformat the
   `date_trunc::text` output to canonical ISO-8601. Defer — current
   space-separated form is readable + sorts correctly.

6. **Time-bucket on diff-timeline / diff-history** — those are
   comparison surfaces, not aggregatable; N/A. Summary is the
   aggregate surface.

## Consequences

- **Operators get histogram-style time-series reports** — daily/hourly/
  weekly/monthly mutation-volume breakdowns; the canonical operator-
  dashboard need.
- **`summary` now supports 8 grouping dimensions** — 4 categorical
  (kind / tenant / actor / table) + 4 temporal (day / hour / week /
  month).
- **Test count: 9,284 → 9,292** (+8 net: 5 adapter tests for temporal
  builders + ordering, 3 CLI tests for temporal group-by + human-format
  histogram).
- **UTC bucketing is deterministic** — `AT TIME ZONE 'UTC'` ensures
  consistent day boundaries regardless of PG session timezone.
- **Chronological ordering for temporal** — histograms read left-to-
  right in time order; categorical dimensions retain count-DESC
  leaderboard ordering.
- **No SQL injection surface** — `--group-by` validated against the enum
  + fixed literal unit map; no free-form interpolation.
- **All output formats work unchanged** — human / json / csv / tsv /
  ndjson / --explain all support temporal grouping via the existing
  bucket rendering.
- **No breaking changes** — temporal dimensions are ADDITIVE to the
  existing categorical `--group-by` values.
- **Time-bucket is the foundation for future analytics** — gap-filling,
  cross-tab, and custom timezones build on this `date_trunc` foundation.
