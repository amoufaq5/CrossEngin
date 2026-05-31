# ADR-0301: `retention diff-timeline --format gh-summary` for cross-table + N-way variants

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0300 Q1 (closes), ADR-0300 (M4.15.m pair-wise timeline gh-summary), ADR-0292 (M4.15.e gh-summary pattern) |

## Context

ADR-0300 Q1 deferred
"same gh-summary
pattern for cross-
table + N-way
diff-timeline (3
more surfaces; same
shape applies with
label tweaks; defer
to future M unless
demand emerges)."

After M4.15.m closed
the common case (pair-
wise timeline +
diff-history), the
remaining gh-summary
gaps in the retention
family were:

- `retention diff-
  timeline --cross-
  table` (one
  tenant, N tables)
- `retention diff-
  timeline --add-
  tenant` (N
  tenants, one
  table)

Operators using these
surfaces in CI gates
still fell back to
human format under
`--format gh-summary`.

## Decision

Add `--format
gh-summary` branches
to both timeline
variants:

1. `runRetention
   DiffTimeline`
   cross-table emit
   path →
   `formatTimeline
   CrossTableDiff
   GhSummary`
2. `runRetention
   DiffTimeline`
   N-way emit
   path →
   `formatTimeline
   NwayDiffGh
   Summary`

### Same shape
as M4.15.m

Event-per-row
Markdown table.
Header lists each
table / tenant
the timeline
covers as a
bulleted label
legend so
operators can
map the per-row
labels (`A` /
`B` / `C`/...)
back to actual
table names /
tenant IDs.

### Column
labels

- **Cross-
  table**:
  `| Time |
  Table |
  Kind |
  Tenant [|
  Actor] |`
  — the `Table`
  column shows
  the per-event
  tableLabel
  (A/B/C/...
  resolved via
  the bulleted
  legend).
- **N-way**:
  `| Time |
  Tenant |
  Kind [|
  Actor] |`
  — the
  `Tenant`
  column shows
  the per-event
  tenantLabel
  (A/B/C/...
  resolved
  via the
  legend).

### Empty
states

- Cross-table
  empty
  entries →
  `:white_
  check_
  mark: **No
  events in
  window**
  — no
  history
  events
  for this
  tenant on
  any of
  these
  tables.`
- N-way
  empty
  entries →
  `:white_
  check_
  mark: **No
  events in
  window**
  — no
  history
  events
  for any
  of these
  tenants
  on this
  table.`

The
bulleted
legend is
still
emitted
on empty
so
operators
see what
was
queried.

### Pagination

Same
blockquote
cursor
footers as
M4.15.m
when
`nextAfterId`
/
`nextBeforeId`
are set.

## Rejected
alternatives

1. **Combine
   cross-table
   + N-way
   into a
   single
   renderer
   parameterized
   by a
   "label
   kind"** —
   the
   header
   wording
   differs
   (`Multi-
   tenant`
   vs.
   `Cross-
   table`)
   and the
   column
   label
   differs
   (`Tenant`
   vs.
   `Table`).
   Inlining
   both
   renderers
   is
   simpler
   than
   threading
   a
   `kind`
   parameter
   through.

2. **Omit
   the
   bulleted
   label
   legend
   to save
   space**
   — the
   per-row
   labels
   (A/B/C/
   ...) are
   meaningless
   without
   the
   legend.
   Two
   renders
   without
   the
   legend
   would
   be hard
   to
   distinguish.

3. **Use
   a 2-
   column
   per-event
   row
   adding
   the full
   table/
   tenant
   name
   instead
   of the
   label**
   — would
   widen
   each
   row
   significantly
   (UUIDs
   are 36
   chars).
   Label +
   legend
   is
   compact.

4. **Add
   the
   `Tenant`
   column
   to the
   cross-
   table
   render
   too** —
   redundant
   (every
   row has
   the
   same
   tenant
   in the
   cross-
   table
   case).
   The
   header
   already
   states
   it.

5. **Add
   `prev/
   next
   state`
   inline
   diff
   column**
   — same
   forensics
   concern
   as
   M4.15.m;
   defer.

6. **Use
   labels
   like
   `T1/T2/
   T3`
   instead
   of
   `A/B/
   C`** —
   matches
   the
   human
   render
   convention
   (`label
   ForIndex`
   produces
   A/B/C).
   Consistency
   wins.

## Drawbacks

- **Bulleted
  legend
  duplicates
  the table/
  tenant
  list
  from the
  human
  render's
  preamble
  ("Table A:
  ...")** —
  Markdown
  is the
  point;
  the
  legend
  is
  meant
  to be
  read.

- **Wide
  legends
  for
  many
  tables/
  tenants
  (e.g.,
  N=10
  legend
  + 50
  event
  rows
  ≈ ~60
  lines
  of
  step
  summary)
  ** —
  acceptable;
  CI step
  summaries
  scroll.

- **Same
  cross-
  table
  edge
  cases
  as
  M4.15.m
  pair**
  (no
  prev/
  next
  inline,
  no
  per-
  kind
  rendering)
  inherited
  here.

## Future Qs

1. **Cross-
   table
   N-way
   timeline**
   — does
   that
   even
   exist?
   (Tenant
   + N
   tables
   +
   another
   tenant
   ...
   could
   be a
   future
   surface
   if
   operators
   want
   it).

2. **`event_
   summary`
   column
   ("set
   retention
   to 90d")
   ** —
   same
   future
   Q as
   M4.15.m;
   applies
   to all
   timeline
   variants
   uniformly.

3. **Per-
   row
   diff
   inline
   ("30
   →
   90
   days")**
   —
   same
   future
   Q
   as
   M4.15.m.

4. **Verdict
   line
   (audit-
   gate
   summary
   ("N
   modifications
   in last
   24h
   across
   M
   tables"))
   ** —
   useful
   for
   cohort
   gates.
   Future
   M.

5. **CSV
   for
   cross-
   table
   +
   N-way
   timeline
   gh-
   summary
   parity**
   — CSV
   already
   ships;
   no
   action.
