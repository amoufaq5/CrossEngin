# ADR-0298: `tenants list --min-policy-count N` cohort filter

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0294 Q4 (closes), ADR-0287 (M4.15.g --include-policy-count) |

## Context

ADR-0294 Q4 deferred "server-
side `--min-policy-count`
filter for cohort queries."
After M4.15.g landed --
include-policy-count
(adding the JOIN +
COALESCE expression), the
infrastructure was in
place to add a WHERE
filter on that
expression, but the user-
facing flag wasn't.

Operators wanting
"tenants with >10 policy
customizations" workflows
had to:

```bash
crossengin tenants list \
  --include-policy-count \
  --format json | \
jq '[.tenants[] | select(
  .policy_count > 10)]'
```

— a client-side filter
that fetched all rows
then dropped most.

## Decision

Add `--min-policy-count
<N>` flag to `tenants
list`. Server-side WHERE
filter on `COALESCE(pc.
policy_count, 0) >= $N`.

### N validation

- N must be a positive
  integer (>= 1).
- Reject `0` (no-op:
  every tenant has >= 0
  policies; setting
  N=0 silently widens
  the result set and
  is almost certainly
  a typo).
- Reject negative.
- Reject non-numeric
  (Number.isFinite
  guard).
- Reject floats (round-
  trip `String(parsed)
  !== input.trim()`
  check rejects `5.5`
  with explicit
  "integer-only" signal
  rather than
  parseInt's silent
  truncation).

### JOIN forcing

When `--min-policy-
count` is set, the JOIN
is forced on even if
`--include-policy-
count` isn't (the
WHERE filter
references the JOIN
expression).

When both flags are
set, only ONE JOIN
exists in the SQL —
the JOIN is shared
between the SELECT
column and the WHERE
clause.

### Composition

- `--status` (AND'd:
  filtered status +
  min policy count).
- `--table-filter`
  (AND'd: tenants
  with overrides on
  that table AND
  >= N total
  overrides).
- `--has-overrides`
  (AND'd; redundant
  when N >= 1 but
  not in error).
- `--format` (json,
  csv, csv-full,
  human — all
  receive the
  filtered row set).
- `--include-
  policy-count`
  (composes:
  filtered AND
  the column
  exposed).

### SELECT
exposure

The outer SELECT
does NOT add the
`COALESCE(...)::int
AS policy_count`
column unless
`--include-policy-
count` is set. The
inner JOIN
subquery has
`COUNT(*)::int AS
policy_count`
unavoidably (it
names its column
for the outer
COALESCE
reference), but
that's an
implementation
detail invisible
to callers.

## Rejected
alternatives

1. **Use HAVING
   instead of
   WHERE** —
   HAVING is for
   aggregates over
   GROUP BY. The
   JOIN subquery
   pre-aggregates,
   exposing
   policy_count as
   a regular
   column, so
   WHERE is the
   semantically
   correct
   filter.

2. **Add a
   `--max-policy-
   count N`
   counterpart**
   — useful for
   inverse
   cohort queries
   ("under-
   policied
   tenants") but
   defer until
   asked. The
   common
   operational
   need is the
   over-policied
   case.

3. **Allow
   `--min-
   policy-count
   0` as a
   no-op** —
   silently
   accepting it
   means typos
   widen results.
   Reject with
   "expected a
   positive
   integer >= 1"
   so the
   operator
   notices.

4. **Use a
   single `--
   policy-count
   <range>` flag
   accepting
   `>=5`, `>10`,
   `=0` syntax**
   — operator-
   parseable
   ranges are
   over-engineered.
   Two flags
   (min/max) are
   simpler and
   compose
   naturally.

5. **Mutual-
   exclude with
   `--has-
   overrides`**
   — they
   overlap on
   N=1 but
   compose
   cleanly via
   AND.
   Requiring
   exclusion
   would break
   ergonomic
   scripts that
   set both.

6. **Round-
   robin
   parseInt
   floats
   silently
   (`5.5` →
   5)** —
   parseInt's
   silent
   truncation
   hides typos
   like `5.5
   policies` (the
   operator
   typo'd a
   space and
   meant `5`,
   but also
   maybe meant
   `50`). The
   round-trip
   check
   `String(5)
   !== '5.5'`
   surfaces
   this loudly.

7. **Accept
   `--min-
   policy-count`
   without a
   value as
   shorthand
   for N=1** —
   conflates
   with `--has-
   overrides`
   and breaks
   the
   "flag-with-
   value"
   parsing
   convention.

## Drawbacks

- **N=0
  rejection
  surprises
  scripts**
  that
  conditionally
  set the flag
  (`if [ "$N"
  -gt 0 ];
  then ...
  --min-policy-
  count "$N";
  fi`).
  Workaround
  is to gate
  the flag in
  shell.

- **No min-
  by-table**
  — operators
  wanting
  "tenants
  with >= 3
  policies on
  workflow_
  traces" need
  the JOIN +
  WHERE to
  count only
  matching
  rows. Defer.

- **Filter
  applies to
  total
  override
  count, not
  unique
  (table,
  axis)
  count** —
  same row can
  have
  retention +
  costCeiling
  axis tweaks
  on the same
  table; that
  shows up as
  multiple
  rows in
  meta.tenant_
  retention_
  policies +
  inflates
  count. The
  M4.15.g
  precedent
  treats them
  as separate
  policies, so
  M4.15.k
  inherits the
  same
  semantics
  (consistent
  but possibly
  surprising
  if a tenant
  has many
  axis tweaks
  on few
  tables).

## Future Qs

1. **`--max-
   policy-count
   N`** for
   inverse
   cohort
   queries.

2. **`--min-
   policy-count-
   on-table
   <table>=<N>
   `** for
   per-table
   cohort
   filters
   (operators
   may want
   "tenants
   with >= 3
   policies on
   workflow_
   traces"
   specifically).

3. **Same flag
   on `tenants
   get`?** —
   doesn't
   make sense
   (get is
   single-
   tenant);
   only list
   needs
   cohort
   filters.

4. **Range
   filter
   `--policy-
   count-
   range
   <min>-
   <max>`** —
   over-
   engineered
   until
   asked.

5. **Filter on
   UNIQUE
   (table,
   axis)
   count** —
   currently
   counts raw
   rows. A
   `--min-
   unique-
   table-
   count`
   variant
   could
   address
   the
   inflated-
   count
   drawback.

6. **Server-
   side
   ordering by
   policy_
   count
   (`--order-
   by
   policy-
   count-
   desc`)**
   — for
   cohort
   ranking.
   Currently
   ordered by
   slug.
