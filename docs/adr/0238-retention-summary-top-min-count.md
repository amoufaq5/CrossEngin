# ADR-0238: Retention summary result limiting (`--top N` + `--min-count N`)

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.summary.top-min-count
- **Closes**: ADR-0232 future Q3 (`--top N`) + Q4 (`--min-count N`)
- **Related**: ADR-0232 (summary action), ADR-0234 (time-bucket),
  ADR-0235 (cross-tab), ADR-0236 (gap-filling)

## Context

ADR-0232 introduced `retention summary` and deferred two result-reduction
flags: `--top N` (Q3, limit to highest-count buckets) and `--min-count N`
(Q4, filter low-count buckets). For high-cardinality dimensions (tenant /
actor with thousands of values), operators want "top 10 actors by
mutation count" or "tenants with >= 100 events" rather than the full
bucket list.

This ADR adds both as a small bulk milestone, closing ADR-0232 Q3+Q4.

### Operator use cases

1. **Top-N leaderboard** — `--group-by actor --top 10` → the 10 actors
   driving the most mutations.
2. **Busiest days** — `--group-by day --top 5` → the 5 highest-volume
   days (overrides chronological ordering with count-DESC).
3. **Threshold filter** — `--group-by tenant --min-count 100` → tenants
   with at least 100 mutations (noise-floor cutoff).
4. **Combined** — `--group-by actor --min-count 5 --top 20` → up to 20
   actors, each with >= 5 events.

## Decision

Add `--top N` (LIMIT with count-DESC ordering) and `--min-count N`
(HAVING threshold) to `retention summary`.

### `--top N`

Limits the result to the N highest-count buckets. Implementation:
- Forces `ORDER BY COUNT(*) DESC, <col> ASC` (overrides the default
  ordering — chronological for temporal, count-DESC for categorical).
- Adds `LIMIT $N`.

`--top` is a "top N by count" query, so it ALWAYS orders by count DESC to
select the highest. For temporal dimensions, this overrides the
chronological ordering (the operator asked for "busiest N", not
"chronological N").

### `--min-count N`

Filters out buckets with count < N. Implementation:
- Adds `HAVING COUNT(*) >= $N` after `GROUP BY`.
- `N >= 0` (0 is a no-op; useful for scripting).

`--min-count` is a server-side aggregate filter; it works for all
grouping modes (single-dimension categorical/temporal, cross-tab).

### Composition

`--top` + `--min-count` compose: `HAVING COUNT(*) >= $minCount ... ORDER
BY COUNT(*) DESC LIMIT $top`. First filter to buckets >= minCount, then
take the top N of those.

### Parameterization + param ordering

Both are parameterized (`$N`):
- `minCount` param is pushed when building HAVING.
- `top` param is pushed when building LIMIT.
- Both follow the filter params + timezone param (which come first).

Example: `--group-by kind --tenant X --min-count 2 --top 5` →
`tenant_id = $1 ... HAVING COUNT(*) >= $2 ... LIMIT $3`.

### Incompatibility with `--fill-gaps`

`--top` / `--min-count` (>= 1) are **incompatible with `--fill-gaps`**:
- `--fill-gaps` ADDS zero-count buckets for completeness.
- `--top` / `--min-count` REMOVE buckets for reduction.

These are opposite intents; combining them is contradictory (a
zero-count gap-filled bucket would never survive `--top` count-DESC or
`--min-count >= 1`). The CLI exits 2 with an explanatory error.
(`--min-count 0` is a no-op and technically compatible, but the check
only blocks `--min-count >= 1`.)

### CLI validation

- `--top N`: positive integer (`>= 1`); exit 2 otherwise.
- `--min-count N`: non-negative integer (`>= 0`); exit 2 otherwise.
- `--fill-gaps` + (`--top` or `--min-count >= 1`): exit 2.

### Adapter

`SummarizeOptOutHistoryInput` gains `top?: number` + `minCount?: number`.
The builder adds HAVING (minCount) + count-DESC-ordering + LIMIT (top) to
both the single-dimension and cross-tab branches. The gap-filling branch
doesn't implement them (blocked at CLI).

### Output

`--top` / `--min-count` only change which buckets appear; the bucket
shape (`{key, count}` or `{key, subKey, count}`) and all output formats
are unchanged. The `totalCount` reflects the SUM of the RETURNED buckets
(after HAVING + LIMIT), so a `--top 5` total is the sum of the top 5, not
the grand total. [Operators wanting the grand total should run without
`--top`.]

## Rejected alternatives

1. **`--top` preserves natural ordering (chronological for temporal)** —
   "top N" inherently means "highest count"; selecting top-N then
   re-sorting chronologically would require a subquery + adds complexity.
   Count-DESC ordering for `--top` is the natural semantic.
2. **`--limit` instead of `--top`** — `--limit` implies "first N in
   natural order"; `--top` clearly means "N highest by count". The
   distinct name avoids confusion with pagination `--limit` on other
   surfaces.
3. **`--min-count` as a WHERE filter** — count is an aggregate; it must
   be HAVING (post-aggregation), not WHERE (pre-aggregation).
4. **Allow `--top` + `--fill-gaps`** — contradictory intents
   (completeness vs reduction); blocking is clearer than silently
   producing a confusing result.
5. **`totalCount` = grand total even with `--top`** — would require a
   second aggregate query; the returned-buckets sum is simpler +
   operators can omit `--top` for the grand total.
6. **`--max-count N`** (filter HIGH-count buckets) — niche; operators
   rarely want to exclude busy buckets. Defer.
7. **`--top` as a percentage (`--top 10%`)** — percentile selection is
   more complex (window functions); absolute N covers the common need.
   Defer.
8. **Apply `--top` per-primary-group in cross-tab (top N secondaries per
   primary)** — would need window functions (`ROW_NUMBER() OVER
   (PARTITION BY primary ORDER BY count DESC)`); defer to a future
   `--top-per-group` flag.

## Future questions

1. **`--top-per-group N` for cross-tab** — top N secondary values within
   each primary group (window function). Defer.

2. **`--max-count N`** — exclude high-count buckets. Defer — niche.

3. **`--top` percentile (`--top 10%`)** — percentile-based selection.
   Defer.

4. **`totalCount` grand-total alongside returned-sum** — emit both
   `totalCount` (returned) + `grandTotal` (all). Defer — operators omit
   `--top` for grand total.

5. **`--min-count` with `--fill-gaps` semantics** — `--min-count 0` +
   `--fill-gaps` is technically coherent (keep zeros); currently
   `--min-count >= 1` is blocked. Document the `--min-count 0` no-op
   case. Defer.

6. **Ordering control (`--order count|key`)** — explicit ordering choice
   independent of `--top`. Defer — `--top` implies count-DESC; default
   is dimension-natural.

## Consequences

- **Operators get leaderboards + threshold filters** — top-N busiest
  actors/tenants/days; noise-floor cutoffs for high-cardinality
  dimensions.
- **Test count: 9,328 → 9,342** (+14 net: 6 adapter tests for HAVING +
  LIMIT + count-DESC + composition + param ordering + cross-tab; 8 CLI
  tests for threading + validation + fill-gaps incompatibility +
  explain echo).
- **`--top` forces count-DESC** — overrides chronological ordering for
  temporal dimensions (a "busiest N" query, not "chronological N").
- **`--min-count` is a HAVING filter** — server-side post-aggregation
  filter; works across all grouping modes.
- **Both parameterized** — `$N` placeholders following filter + timezone
  params; no injection surface.
- **Incompatible with `--fill-gaps`** — opposite intents (completeness
  vs reduction); CLI exits 2.
- **`totalCount` reflects returned buckets** — a `--top 5` total is the
  sum of the top 5, documented behavior.
- **Backward compatible** — both flags ADDITIVE; without them, summary
  behaves exactly as before.
- **`--top-per-group` (window function) is the natural follow-up** for
  cross-tab leaderboards.
