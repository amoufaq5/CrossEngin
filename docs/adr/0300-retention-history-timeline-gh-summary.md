# ADR-0300: `retention diff-history` + `diff-timeline --format gh-summary`

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0296 Q1 (closes), ADR-0292 (M4.15.i retention pair-diff gh-summary), ADR-0292 (M4.15.e gh-summary pattern) |

## Context

ADR-0296 Q1 deferred
"same Markdown
gh-summary pattern for
retention `diff-history`
+ `diff-timeline` —
these are different
shapes (history entries
/ timeline events) so
each needs its own
Markdown renderer."

After M4.15.i closed
gh-summary for the
5 retention diff
surfaces (pair, vs-
platform, cross-table,
N-way, cross-table
N-way), `retention
diff-history` and
`retention diff-
timeline` still fell
back to human format
under `--format
gh-summary`.

CI workflows running
audit gates on
history events
(e.g., "alert if a
non-system actor
modified retention
in the last 24h")
couldn't emit a
Markdown summary
suitable for
$GITHUB_STEP_SUMMARY
redirection.

## Decision

Add `--format
gh-summary` to two
retention surfaces:

1. **diff-history**
   (pair-wise event
   comparison) —
   single emit
   branch in
   `runRetention
   DiffHistory`.
2. **diff-timeline
   pair** (single-
   tenant timeline)
   — single emit
   branch in
   the timeline
   pair path.

Cross-table +
N-way timeline
variants
deferred (3
more surfaces;
ship the
common case
first, see
demand for
the rarer
ones).

### diff-history
shape

Markdown shape
mirrors M4.15.i
pair-diff
exactly since
the
HistoryEntry
FieldDiff
type is the
same shape
as
HistoryEntry
FieldDiff
used by
DiffTenant
PoliciesResult:

```
## Diff: retention history events

**Tenant:** `<uuid>`
**Table:** `<name>`

**Event A:** `<id>`
@ `<timestamp>`
(`<event_kind>`)
[by <actor>]
**Event B:** ...

### Field changes (N)
| Field | A | B |
|...|

✅ / ⚠️
```

Reuses
`formatMdRetention
Value` from
M4.15.i for
backtick-wrap
+ escaping +
null/absent
distinction.
`with
ActorNames`
opt adds
"by <name>"
suffix to
event lines.

### diff-
timeline
shape

Markdown
shape is an
event-per-
row table
since
timeline
entries
are a log,
not a
pair-wise
diff:

```
## Timeline: retention history events

**Table:** `<name>`
**Entries:** N

### Events (N)
| Time | Side | Kind | Tenant [| Actor] |
|...|

> Next page: `--after-id <id>`
> Previous page: `--before-id <id>`
```

The
`with
Actor
Names`
opt
adds an
Actor
column.
Pagination
cursors
surfaced
as
blockquote
footers
so
operators
chaining
pages
from
CI step
output
can copy
the
`--after-
id` /
`--before-
id`
flags.

### Empty
states

- diff-
  history
  empty
  fieldDiffs
  →
  `:white_
  check_
  mark:
  **No
  differences**
  — both
  events
  captured
  the same
  policy
  state.`
- diff-
  timeline
  empty
  entries
  →
  `:white_
  check_
  mark:
  **No
  events
  in
  window**
  —
  timeline
  is empty.`

## Rejected
alternatives

1. **Render
   timeline
   as a
   pair-of-
   diffs
   (one
   per
   entry)
   ** —
   would
   duplicate
   prev_
   state
   /
   next_
   state
   data
   per
   row;
   the
   log-
   shape
   `kind`
   column
   is
   more
   readable.

2. **Add
   `<details>`
   block
   per
   timeline
   entry
   with
   full
   prev/
   next
   state**
   —
   useful
   for
   deep
   forensics
   but
   gh-
   summary
   is
   meant
   to
   be
   scannable
   at a
   glance.

3. **Use
   the
   same
   compact
   Markdown
   shape
   for
   cross-
   table +
   N-way
   timeline**
   —
   defer
   until
   demand
   emerges
   (the
   pair
   timeline
   is the
   common
   case).

4. **Add
   a
   `prev/
   next
   change`
   column
   to
   the
   timeline
   table**
   —
   would
   require
   diffing
   prev
   vs
   next
   per
   row.
   Operators
   wanting
   the
   per-
   event
   diff
   use
   `diff-
   history`
   on
   that
   pair.

5. **Use
   `event_
   kind`
   emoji
   (`✏️`
   for
   retention_
   set,
   `🚫`
   for
   opt_
   out_
   set)**
   —
   cute
   but
   non-
   accessible
   in
   text
   readers;
   kind
   text
   stays
   in
   backticks.

6. **Inline
   pagination
   cursors
   as
   `<a>`
   anchor
   links
   to
   the
   next
   CI
   step**
   —
   CI
   step
   URLs
   aren't
   known
   at
   render
   time;
   the
   `--
   after-
   id`
   shell
   command
   is
   the
   correct
   abstraction.

## Drawbacks

- **Timeline
  rows
  can be
  many**
  (limit
  default
  is 50
  per
  page).
  Markdown
  tables
  with
  50
  rows
  render
  OK
  but
  push
  the
  step
  summary
  long.

- **No
  `prev/
  next`
  state
  column**
  in
  timeline
  gh-
  summary
  —
  operators
  wanting
  state
  changes
  per
  event
  need
  to
  drill
  in
  via
  `diff-
  history`.
  Acceptable
  for
  audit-
  log
  consumers.

- **`tenant
  Side`
  column
  is
  `A`/`B`**
  only —
  the
  cross-
  table
  case
  hasn't
  shipped
  (table-
  side
  labels
  would
  be
  more
  meaningful
  there).
  Defer.

- **Cross-
  table +
  N-way
  timeline
  not
  yet
  covered**
  — 3
  more
  surfaces.
  Same
  shape
  applies
  with
  label
  tweaks;
  defer
  to
  future
  M
  unless
  demand
  emerges.

## Future Qs

1. **Cross-
   table +
   N-way
   timeline
   gh-
   summary**
   — same
   event-
   per-row
   shape
   with
   table-
   name
   labels
   (cross-
   table)
   or
   per-
   group
   labels
   (N-
   way).

2. **`event_
   summary`
   column
   ("set
   retention
   to 90d")
   ** —
   would
   require
   a
   per-
   kind
   renderer.
   Deferred.

3. **Inline
   diff
   per
   row
   ("30
   →
   90
   days")**
   —
   forensics-
   grade
   but
   wide
   tables
   on
   many
   axes.
   Defer.

4. **Filter
   verdict
   line
   ("N
   policy
   modifications
   in
   last
   24h
   by
   non-
   system
   actors")
   ** —
   useful
   for
   audit
   gates.
   Future
   M
   could
   add
   verdict
   computation.

5. **`with
   Inline
   State`
   opt** —
   render
   prev/
   next
   state
   in a
   collapsible
   `<details>`
   block.
