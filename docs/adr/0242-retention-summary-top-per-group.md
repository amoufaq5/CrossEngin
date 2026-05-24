# ADR-0242: Retention summary `--top-per-group N` (window-function cross-tab leaderboards)

- **Status**: Proposed
- **Date**: 2026-05-24
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.summary.top-per-group
- **Closes**: ADR-0238 future Q1 (`--top-per-group` window function cross-tab)
- **Related**: ADR-0232 (summary action), ADR-0235 (cross-tab
  `--then-by`), ADR-0238 (`--top` / `--min-count`)

## Context

ADR-0238 added `--top N` (limit to the highest-count buckets) and
`--min-count N` (HAVING threshold) to `retention summary`. In cross-tab
mode (`--group-by X --then-by Y`, ADR-0235), `--top N` limits the
**total** bucket count globally by count-DESC. But operators reporting
on cross-tab grids usually want a *per-group* leaderboard — "the top 3
actors **per day**", not "the 3 highest-count (day, actor) pairs
overall" (which could all come from one busy day, leaving other days
unrepresented).

ADR-0238 deferred this as future Q1 ("--top-per-group window function
cross-tab"). This ADR adds `--top-per-group N`: within each primary
group, keep the top-N secondary keys by count, computed with a
`ROW_NUMBER()` window.

### Per-group vs global top

- `--top N` (ADR-0238): global cap — the N highest-count buckets across
  all primary groups. Answers "what are the busiest cells overall?"
- `--top-per-group N` (this ADR): per-partition cap — for each primary
  key, the N highest-count secondaries. Answers "what's the leaderboard
  *within* each group?"

They are different axes and are **mutually exclusive** at the CLI.

## Decision

Add `topPerGroup?: number` to `SummarizeOptOutHistoryInput` and a
windowed cross-tab branch in `buildSummarizeOptOutHistoryQuery`. The CLI
gains `--top-per-group N`, validated and threaded only in cross-tab
mode.

### Window-function SQL

In the cross-tab branch (`thenBy` set), when `topPerGroup` is set the
builder emits a ranked subquery instead of the plain `GROUP BY ... ORDER
BY ... LIMIT`:

```sql
SELECT key, sub_key, count FROM (
  SELECT <primary>::text AS key, <secondary> AS sub_key, COUNT(*)::bigint AS count,
         ROW_NUMBER() OVER (PARTITION BY <primary> ORDER BY COUNT(*) DESC, <secondary> ASC) AS rn
  FROM meta.tenant_retention_opt_out_history h
  <where>
  GROUP BY <primary>, <secondary>
  <having>            -- minCount, if set
) ranked
WHERE rn <= $N
ORDER BY key ASC, count DESC, sub_key ASC
```

Key design points:

- **`ROW_NUMBER()` runs after `GROUP BY`/`HAVING`.** Window functions
  are evaluated after aggregation, so `--min-count` (HAVING) filters
  buckets *before* ranking — the two compose cleanly (filter, then rank
  the survivors per group).
- **`PARTITION BY <primary>`** ranks secondaries independently within
  each primary group; `ORDER BY COUNT(*) DESC, <secondary> ASC` makes
  rank 1 the highest-count secondary (ties broken alphabetically /
  chronologically by the secondary expression).
- **Outer `WHERE rn <= $N`** keeps the top N per partition.
- **Outer `ORDER BY key ASC, count DESC, sub_key ASC`** renders a grid:
  primary groups ascending (chronological for temporal, alphabetical for
  categorical — matching the existing cross-tab grid order), and within
  each group the secondaries as a count-descending leaderboard.
- **`topPerGroup` is the last positional param** (after filters + the
  HAVING `minCount` param); param numbering is captured at push time so
  it stays correct regardless of which earlier params are present.

The bucket shape is unchanged (`{key, subKey, count}`); only *which*
buckets appear changes. `totalCount` is the sum of the returned (per-
group top-N) buckets — consistent with ADR-0238's `--top` (where
`totalCount` is the sum of returned buckets, not the grand total).

### CLI validation

- **Positive integer**: `--top-per-group 0` / negative / non-integer →
  exit 2 (same rule as `--top`).
- **Requires `--then-by`**: without a second dimension there is no
  "per-group" concept; plain `--top` is the global-limit tool. Exit 2
  with a message pointing at `--then-by` / `--top`.
- **Mutually exclusive with `--top`**: the two are different limit
  semantics; combining them is almost never intended, so it's blocked
  (exit 2) rather than silently double-filtering.
- **Incompatible with `--fill-gaps`** transitively: `--fill-gaps`
  forbids `--then-by` (ADR-0236) and `--top-per-group` requires it, so
  the two can never validly co-occur — whichever precondition is
  checked first fires exit 2. No separate explicit check is needed.

`--top-per-group` composes with `--min-count` (HAVING inside the
subquery) and the full filter family (WHERE inside the subquery). It is
echoed in the `--explain` plan and (like `--top`/`--min-count`) is an
input flag, so it appears in the plan but not in the result JSON
envelope.

## Rejected alternatives

1. **Compose `--top` + `--top-per-group`** (per-group rank, then global
   cap) — coherent but a confusing double-limit; mutual exclusivity is
   clearer. Matches ADR-0238's stance on blocking opposite/confusing
   intents.
2. **`--top-per-group` without `--then-by`** (treat as plain `--top`) —
   overloads one flag with two meanings; `--top` already covers the
   single-dimension case.
3. **`DISTINCT ON` instead of `ROW_NUMBER()`** — `DISTINCT ON` returns
   only ONE row per group, not N; doesn't generalize to top-N.
4. **`LATERAL` join with per-group `LIMIT`** — works but is more verbose
   and the window function is the idiomatic top-N-per-group pattern.
5. **Application-side ranking** (fetch full grid, slice per group in JS)
   — breaks at scale (transfers every bucket) and re-implements ranking
   the DB does natively.
6. **Rank ascending (bottom-N)** — operators want leaders; a `--bottom`
   variant can be added later if demanded.
7. **`--top-per-group` on single-dimension summaries** — meaningless
   (one partition = the whole result = plain `--top`).
8. **Annotate the human header with "(top N per group)"** — ADR-0238's
   `--top` doesn't annotate the header; kept consistent. The `--explain`
   plan + JSON echo provide transparency.

## Future questions

1. **`--bottom-per-group N`** — least-active secondaries per group
   (`ORDER BY COUNT(*) ASC`). Defer — leaders are the common ask.
2. **`--top-per-group` + global `--top` composition** — if a real use
   case emerges, allow both with documented ordering (per-group rank,
   then global cap). Defer.
3. **Rank ties via `RANK()`/`DENSE_RANK()`** — `ROW_NUMBER()` breaks
   ties arbitrarily (by secondary ASC); `RANK()` would include all ties
   at the boundary. Defer — deterministic tiebreak is sufficient.
4. **N-way `--then-by` + per-group** — pairs with ADR-0235 Q1 (n-way
   cross-tab). Defer.
5. **Window-function gap-filling per group** — combine with ADR-0236.
   Defer; cross-tab gap-filling is itself deferred.
6. **Expose `rn` (the rank) in output** — operators wanting the explicit
   rank column. Defer — count ordering conveys it.

## Consequences

- **Per-group leaderboards** — `--group-by day --then-by actor
  --top-per-group 3` gives the top 3 actors *per day*; every day is
  represented, unlike global `--top`.
- **Cross-tab-only** — requires `--then-by`; meaningless on single-
  dimension summaries (use `--top`).
- **Composes with `--min-count` + filters** — HAVING and WHERE apply
  inside the ranked subquery before windowing.
- **Mutually exclusive with `--top`** — two distinct limit semantics;
  exit 2 if both set. Transitively incompatible with `--fill-gaps`.
- **`totalCount` reflects returned buckets** — sum of the per-group
  top-N (documented; same as `--top`).
- **Test count: 9,371 → 9,383** (+12 net: 6 adapter tests for the
  windowed query shape + composition + bucket return, 6 CLI tests for
  threading / validation / mutual exclusivity / explain echo).
- **No breaking changes** — `--top-per-group` is ADDITIVE; all existing
  summary behavior is unchanged when the flag is absent.
- **The retention summary action is now exhaustively analytic** —
  8 dimensions + cross-tab (any × any) + gap-filling + timezone +
  global `--top`/`--min-count` + per-group `--top-per-group`.
