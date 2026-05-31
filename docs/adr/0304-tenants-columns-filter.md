# ADR-0304: `tenants list/get --columns col1,col2` CSV column subset filter

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0297 Q2 (closes), ADR-0297 (M4.15.j tenants get csv), ADR-0303 (M4.15.p --no-header) |

## Context

ADR-0297 Q2 deferred
"`--columns
col1,col2` filter
to select a subset
of columns to
emit."

After M4.15.f / .j
shipped 5-col +
11-col CSV/csv-full
output for
`tenants list` and
`tenants get`,
operators wanting
narrow audit
reports (e.g.,
"slug + tier + residency
only across all
tenants") had to:

1. Pipe `--format
   json` through
   jq.
2. Post-process
   CSV via `awk
   -F, '{print
   $2","$5}'` —
   fragile against
   quoted cells
   containing
   embedded commas.

## Decision

Add `--columns
<col1,col2,...>`
flag to `tenants
list` and
`tenants get`.

### Validation

- Empty list
  (`--columns
  ""`) → exit 2
  with "requires
  at least one
  column name".
- Unknown column
  → exit 2 with
  "unknown column
  '<name>' (valid:
  <full list>)".
- Duplicate
  column → exit
  2 with
  "duplicate
  column
  '<name>'".

### Order
preservation

Columns appear
in the
operator-
specified
order, not
the canonical
header order.
`--columns
tier,slug,name`
emits headers
`tier,slug,name`
in that
sequence.

This is the
documented
contract:
operators get
both "subset"
and "reorder"
semantics from
one flag.

### Validation
scope

Valid column
set is the
header set for
the requested
format:

- `--format csv|
  tsv`: 5
  columns (id,
  slug, name,
  status, tier).
- `--format
  csv-full`: 11
  columns (the
  5 above plus
  region,
  schema_name,
  residency,
  search_locale,
  created_at,
  updated_at).
- With
  `--include-
  policy-count`:
  adds
  `policy_count`
  to the valid
  set.

### Composition
with --no-header

```bash
tenants get acme \
  --format csv \
  --columns slug,tier \
  --no-header
# → acme-prod,enterprise
```

Single data
row, no
header — drop-
in for CSV
concat
pipelines.

### Shared
helpers in
format.ts

`parseColumns
Flag(raw)` and
`applyColumns
Filter(headers,
rows, columns)`
are exported
from `format
.ts` so future
surfaces
(retention
diff, policies
diff, etc.)
can reuse the
same validation
+ projection
logic without
duplicating
the column-
order
contract.

## Rejected
alternatives

1. **Allow
   `--columns
   *`
   wildcard
   to mean
   "all
   columns"**
   — same
   as
   omitting
   the
   flag.
   Adds
   surface
   for no
   benefit.

2. **Allow
   `--exclude-
   columns
   col`
   as an
   inverse
   filter**
   — useful
   but
   defer
   until
   demanded.
   `--columns`
   covers
   the
   common
   case.

3. **Use
   `--fields`
   instead
   of
   `--columns`**
   —
   "columns"
   matches
   the
   CSV
   domain
   vocabulary
   that
   appears
   in
   error
   messages
   ("unknown
   column").
   `--fields`
   would be
   ambiguous
   for
   formats
   that
   aren't
   tabular
   (json).

4. **Allow
   duplicates
   (`--columns
   slug,slug,
   tier`)**
   — would
   be useful
   for
   spreadsheets
   that
   need
   the
   same
   column
   twice
   for
   side-by-
   side
   formulas,
   but
   confusing
   in
   most
   cases
   and
   silently
   accepts
   typos.
   Reject
   loudly.

5. **Index-
   based
   selectors
   (`--columns
   1,3,5`)**
   — fragile
   against
   shape
   changes.
   Name-
   based is
   more
   stable.

6. **Validation
   at
   parse
   time vs
   at
   emit
   time**
   — emit-
   time
   gives
   the
   correct
   valid-
   column
   list per
   format
   variant
   (5-col
   vs
   11-col).
   Parse-
   time
   would
   require
   pre-
   computing
   the
   format
   shape.

7. **Glob
   patterns
   (`--columns
   *_at`)**
   — over-
   engineered
   for the
   common
   case.
   Operators
   can list
   the few
   they
   want.

8. **Auto-
   detect
   `--columns`
   from a
   `~/.crossengin/
   tenants-
   profile.
   csv`
   config**
   — adds
   stateful
   behavior
   that
   surprises.
   Explicit
   per-
   invocation
   is
   simpler.

## Drawbacks

- **`--columns`
  affects
  only
  csv/tsv/
  csv-full;
  json/
  human
  silently
  ignore
  it** —
  matches
  the
  `--csv-
  separator`
  /
  `--no-
  header`
  precedent
  but
  worth
  the
  ADR
  callout.

- **Validation
  list
  shown
  on
  error
  depends
  on
  format
  shape**
  (5 cols
  for
  csv,
  11 for
  csv-full).
  An
  operator
  switching
  format
  may see
  different
  "valid"
  lists.

- **No
  short-
  form
  flag
  (`-c`)**
  — `-c`
  conflicts
  with
  potential
  future
  `--columns-
  preset`
  workflows.
  Stay
  long-
  form.

- **Composition
  with
  `--include-
  policy-
  count`
  is
  implicit**
  — the
  `policy_
  count`
  column
  is
  added
  to the
  valid
  set
  only
  when
  the
  flag is
  on.
  Operators
  using
  `--columns
  slug,
  policy_
  count`
  without
  `--include-
  policy-
  count`
  get
  "unknown
  column"
  — that's
  the
  correct
  signal
  but
  could
  surprise.

## Future Qs

1. **`--exclude-
   columns`
   inverse
   filter**.

2. **Same
   `--columns`
   on
   retention
   diff /
   policies
   diff /
   housekeeping
   diff
   surfaces**
   if
   operator
   demand
   emerges.
   The
   shared
   `apply
   Columns
   Filter`
   helper
   makes
   this
   a
   one-
   liner
   per
   surface.

3. **`--columns-
   preset
   <name>`
   for
   commonly-
   used
   subsets
   (e.g.,
   "audit"
   = slug,
   tier,
   status,
   region,
   residency)**.

4. **`--columns
   slug:Tenant
   Slug,
   tier:Tier`
   to
   rename
   headers
   for
   downstream
   consumers**.

5. **Glob /
   regex
   matching**
   (`--columns
   '*_at'`)
   for
   timestamp-
   only
   exports.

6. **Index-
   based
   selectors**
   if
   operators
   want
   them
   later.
