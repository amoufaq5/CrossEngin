# ADR-0302: `retention diff --add-tenant/--add-table --format csv|tsv` wide-format N-way export

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0296 future Q (closes), ADR-0292 (M4.15.f tenants list csv-full precedent), ADR-0292 (M4.15.i N-way gh-summary) |

## Context

ADR-0296's future-Q list
flagged: "CSV/TSV for
retention N-way — the
distinct-values
grouping would benefit
from a column-per-
tenant shape."

The 3 retention pair
diff surfaces have
shipped CSV/TSV
(field, value_a,
value_b — pair-wise
long-ish format).
The N-way variants
(per-tenant N=3+,
per-table cross-table
N=3+) only emitted
human + json/yaml +
gh-summary — no
CSV/TSV.

Operators wanting
spreadsheet-ready
cohort comparison
("show me retention
DaysSettings for
these 5 tenants
side-by-side") had
to:
1. Pipe `--format
   json` through
   jq.
2. Hand-write a
   pivot.
3. Lose CSV
   pipeline
   compatibility.

## Decision

Add `--format
csv|tsv` to both
N-way retention
diff surfaces:

- `retention diff
  <a> <b> <table>
  --add-tenant
  <c> ...`
- `retention diff
  <t> <ta> <tb>
  --cross-table
  --add-table
  <tc> ...`

### Wide-format
shape

One row per field,
one column per
tenant (or per
table for cross-
table). Column
headers use the
full tenant UUID
(or table name)
prefixed with
`value_`:

```
field,value_<uuid-a>,value_<uuid-b>,value_<uuid-c>
retentionDays,30,90,90
enabled,true,true,true
```

Tenants matching
the same value
get the same
cell value
(distinct-value
group lookup).
Header order
matches the
`tenantIds[]`
input order
(anchor, RHS,
--add-tenant
chain).

### Cell
serialization

`buildNwayCsvRows`
+ `serializeNway
CellValue`:
- `null` /
  `undefined` →
  null (empty
  cell per
  printCsv
  contract).
- string /
  number /
  boolean →
  pass-through.
- object /
  array → compact
  `JSON.stringify`
  (same
  convention as
  tenants list
  csv-full
  residency).

If a label is
absent from
ALL distinct-
value groups
(degenerate
input;
shouldn't
happen via
computeField
Variations
but guarded
defensively),
the cell is
null.

### --csv-
separator

Honored.
Validated via
`validateNway
CsvSeparator`
(rejects `"`
+ newline,
same as
existing
retention
csv paths).

## Rejected
alternatives

1. **Long
   format
   (`tenant_id,
   field,
   value`)
   ** — more
   pandas-
   idiomatic
   but
   spreadsheet
   workflows
   prefer wide
   for at-a-
   glance
   comparison.
   Operators
   wanting
   long can
   `melt()`
   in pandas.

2. **Column
   headers
   use
   labels
   (`value_
   A`,
   `value_
   B`) +
   emit a
   separate
   legend
   via
   stderr**
   — out-of-
   band
   knowledge
   to map
   labels
   back. UUIDs
   in
   headers
   are
   verbose
   but
   self-
   documenting.

3. **Include
   the label
   (A/B/C)
   as a
   second
   header
   row** —
   CSV
   conventions
   don't
   support
   multi-row
   headers
   cleanly.
   pandas
   `read_
   csv
   (skiprows
   =1)`
   loses
   the
   info.

4. **Add
   `--format
   csv-long`
   variant
   for the
   pandas
   case**
   — adds
   surface
   to
   maintain.
   Defer
   until
   asked.

5. **Strip
   `value_`
   prefix
   from
   column
   headers**
   — would
   conflict
   with
   the
   `field`
   column
   if
   someone
   passed a
   tenant
   slug
   matching
   `field`.
   The
   prefix
   prevents
   collisions.

6. **Emit
   a CSV
   preamble
   comment
   line
   `#
   tenants:
   uuid-a,
   uuid-b
   ...`** —
   not a
   real
   CSV
   convention;
   most
   parsers
   would
   error
   on it.

7. **Include
   the
   resolution
   source
   (tenant/
   platform/
   tier)
   as a
   suffix
   in
   each
   cell** —
   the
   `source`
   field is
   one of
   the
   fieldVariations
   itself
   (one row
   per
   field
   including
   `source`)
   — so
   it's
   already
   in the
   output
   if it
   varies.

## Drawbacks

- **Header
  width
  scales
  with
  N** —
  10 tenant
  UUIDs
  =
  ~400+
  char
  header
  line.
  Acceptable
  for
  spreadsheet
  + pandas;
  CSV
  parsers
  handle
  long
  headers.

- **`value_`
  prefix
  is
  noisy**
  on
  every
  column.
  Workaround
  is to
  strip
  in
  pandas
  via
  `df
  .columns
  .str
  .replace
  ('value_',
  '')`.

- **Cell
  values
  with
  embedded
  separators**
  get
  quoted
  by
  printCsv
  (correct
  per
  RFC-
  4180)
  —
  but
  the
  quoting
  is
  invisible
  on
  the
  output
  line
  unless
  the
  cell
  value
  contains
  the
  separator,
  so
  most
  rows
  look
  clean.

- **No
  long-
  format
  variant**
  for
  pandas-
  native
  pivot
  workflows.
  Defer.

- **`null`
  cells
  vs
  empty
  strings**
  —
  pandas
  `read_csv`
  treats
  both
  as
  NaN
  by
  default.
  Fine.

## Future Qs

1. **`--format
   csv-long`
   for
   pandas-
   native
   pivot
   workflows**
   if
   operator
   demand
   emerges.

2. **`--column-
   labels
   slug`
   to use
   tenant
   slugs
   instead
   of UUIDs**
   in
   column
   headers
   (would
   require
   a slug
   resolver
   step).

3. **`--no-
   field-
   prefix`
   to
   strip
   `value_`**.

4. **Same
   wide-
   format
   for
   tenant
   policies
   N-way
   diff
   (3-
   axis
   PolicyField
   Diff)**
   —
   not
   shipped
   yet
   either,
   different
   shape
   (axis-
   grouped).

5. **Per-
   column
   resolution-
   source
   (tenant/
   platform/
   tier)
   suffix**
   if
   operators
   want
   it
   beyond
   the
   `source`
   field
   row.

6. **Inline
   diff
   markers
   in
   cells
   (e.g.,
   `90*`
   for the
   value
   that
   differs
   from
   the
   anchor)**
   —
   non-
   standard
   CSV;
   defer.
