# ADR-0237: Retention summary custom timezone bucketing (`--timezone`)

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.summary.timezone
- **Closes**: ADR-0234 future Q1 (custom timezone for time-bucket
  grouping) + ADR-0235 Q5 + ADR-0236 Q4
- **Related**: ADR-0234 (time-bucket grouping), ADR-0235 (cross-tab),
  ADR-0236 (gap-filling)

## Context

ADR-0234 introduced temporal grouping with hardcoded UTC bucketing
(`date_trunc(occurred_at AT TIME ZONE 'UTC')`). UTC is the right default
for audit logs, but operators reporting on a single-region tenant often
want local-time day boundaries — "how many opt-outs per business day in
America/New_York" where a "day" is midnight-to-midnight Eastern, not UTC.

This ADR adds `--timezone <iana-tz>` to bucket temporal dimensions in a
custom timezone, closing ADR-0234 Q1 (+ ADR-0235 Q5 + ADR-0236 Q4 which
referenced the same need for cross-tab + gap-fill).

### Operator use cases

1. **Local-business-day histogram** — `--group-by day --timezone
   America/New_York` → days bounded by Eastern midnight.
2. **Regional incident timeline** — `--group-by hour --timezone
   Europe/London --fill-gaps` → hourly buckets in London time.
3. **Cross-tab in local time** — `--group-by tenant --then-by day
   --timezone Asia/Tokyo` → per-tenant daily activity in Tokyo time.

## Decision

Add `--timezone <iana-tz>` to bucket temporal dimensions in a custom
timezone. The timezone is **parameterized** in the SQL (injection-safe).

### Parameterized timezone (injection defense)

The timezone string is bound as a query parameter, NOT interpolated:

```sql
date_trunc('<unit>', h.occurred_at AT TIME ZONE $N)
```

PostgreSQL's `AT TIME ZONE` operator accepts a text-typed value, so `$N`
(a parameter) works. This eliminates the SQL-injection surface entirely —
even a malicious timezone string like `'; DROP TABLE--` is treated as a
parameter value (and rejected by PG as an invalid timezone at runtime).

### Conditional parameterization (backward compat)

- **No `--timezone`**: SQL keeps the literal `AT TIME ZONE 'UTC'`
  (identical to pre-ADR-0237 SQL; existing tests unchanged).
- **`--timezone X` + temporal grouping**: pushes `X` as the FIRST
  param (`$1`); filter params follow as `$2+`. The `date_trunc`
  expressions reference `$1`.
- **`--timezone X` + categorical-only grouping**: timezone is ignored
  (no `date_trunc`); not pushed as a param.

### Param ordering

- **Standard path**: timezone `$1` (if set + temporal), filters `$2+`.
- **Gap-filling path**: since `$1`, until `$2`, timezone `$3` (if set),
  filters `$4+`. The `generate_series` bounds + LEFT JOIN ON-clause
  `date_trunc` both reference `$3`.

A single timezone param is shared across all `date_trunc` references
(primary dimension, secondary dimension in cross-tab, generate_series
bounds in gap-fill).

### CLI validation

`--timezone` validation (defense-in-depth, even though parameterized):
1. **Charset check** — `^[A-Za-z][A-Za-z0-9_+/:-]*$` (IANA names +
   offset forms). Friendly exit-2 for obvious garbage; PG validates the
   actual name (invalid IANA name → exit 1 PG runtime error).
2. **Temporal requirement** — `--timezone` only applies to temporal
   `--group-by` OR `--then-by` (day/hour/week/month). Categorical-only
   grouping has no `date_trunc`; `--timezone` would be a silent no-op.
   Exit 2 with explanation.

### Adapter

`SummarizeOptOutHistoryInput` gains `timezone?: string`. The builder
computes `tzExpr` (`'UTC'` literal or `$N` param) and threads it through
`resolveDimension` (standard path) and the gap-filling builder.

### Output formats

Bucket keys reflect the chosen timezone's wall-clock time. E.g.,
`--group-by day --timezone America/New_York` yields keys like
`2026-05-20 00:00:00` representing Eastern midnight (which is
`2026-05-20 04:00:00 UTC` or `05:00` depending on DST). All output
formats render the keys identically.

## Rejected alternatives

1. **Interpolate the timezone string with validation only** — even with
   a strict charset regex, parameterization is the gold standard;
   parameterizing closes the injection surface without relying on the
   regex being exhaustive.
2. **Always parameterize (even UTC default)** — would change the
   existing literal-`'UTC'` SQL + break existing tests; conditional
   parameterization preserves backward compat (literal UTC when no
   `--timezone`).
3. **Session-level `SET timezone`** — would require a transaction +
   session state; per-query parameterization is cleaner + stateless.
4. **Store timezone offset as a number** — IANA names handle DST
   transitions correctly; fixed offsets don't. IANA name is the right
   abstraction.
5. **Default to the server's local timezone** — non-deterministic +
   couples output to deployment config; UTC default is canonical for
   audit logs.
6. **Silently ignore `--timezone` for categorical grouping** — silent
   no-ops confuse operators; exit-2 with explanation is clearer.
7. **Allow `--timezone` to also affect `--since`/`--until` parsing** —
   `--since`/`--until` are already parsed as absolute ISO-8601
   timestamps (with explicit TZ or UTC); the bucketing timezone is
   orthogonal to the filter range. Keep them separate.
8. **`--utc` boolean shorthand alongside `--timezone`** — redundant;
   `--timezone UTC` (or omitting `--timezone`) covers it.

## Future questions

1. **`--timezone` affecting `--since`/`--until` interpretation** — if
   an operator passes `--since 2026-05-20` (no TZ) with `--timezone
   America/New_York`, should the since be Eastern midnight? Currently
   `--since` parses as UTC/absolute. Defer — operators can pass explicit
   TZ offsets in `--since`.

2. **Timezone abbreviation support (EST, PST)** — PG accepts some
   abbreviations but they're ambiguous (EST vs Australia/EST). The
   charset regex allows them; PG resolves. Document the ambiguity.
   Defer.

3. **List valid timezones (`--timezone list`)** — a helper to dump
   `pg_timezone_names`. Defer — operators know their TZ; PG errors on
   invalid.

4. **Per-tenant default timezone** — store a tenant's timezone in
   config + default `--timezone` to it. Defer — operator-policy +
   config-layer concern.

5. **Timezone in non-summary surfaces** — history / diff-timeline
   render `occurredAt` in UTC ISO-8601; a `--timezone` display option
   could localize them. Defer — summary bucketing is the primary TZ
   need; raw timestamp display localization is separate.

6. **DST-transition bucket handling** — on spring-forward, a day has 23
   hours; on fall-back, 25. `date_trunc` + `AT TIME ZONE` handles this
   correctly (buckets align to local midnight). Document the behavior.
   Defer — PG handles correctly; just under-documented.

## Consequences

- **Operators get local-time bucketing** — day/hour/week/month
  boundaries in any IANA timezone; business-day reports without UTC-
  offset mental math.
- **Injection-safe** — the timezone is parameterized, not interpolated;
  the SQL-injection surface is eliminated.
- **Backward compatible** — no `--timezone` → literal `'UTC'` SQL
  (identical to before); existing tests + behavior unchanged.
- **Test count: 9,316 → 9,328** (+12 net: 6 adapter timezone tests
  covering parameterization + param ordering + categorical no-op +
  gap-fill + cross-tab; 6 CLI tests covering threading + validation +
  temporal-requirement + explain echo).
- **Single shared timezone param** — one `$N` reference across all
  `date_trunc` expressions (primary + secondary + generate_series).
- **Works across all summary modes** — single-dimension temporal,
  cross-tab (temporal dimension), gap-filling — all honor `--timezone`.
- **2 validations** — charset (friendly) + temporal-requirement; PG
  validates the actual IANA name at runtime.
- **DST handled by PG** — `date_trunc` + `AT TIME ZONE` align buckets to
  local midnight across DST transitions.
- **Closes the temporal-grouping timezone gap** — ADR-0234/0235/0236 all
  referenced this; now resolved across all three.
