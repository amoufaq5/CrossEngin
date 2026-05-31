# ADR-0303: `tenants list/get --no-header` CSV header suppression

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0297 Q1 (closes), ADR-0297 (M4.15.j tenants get csv), ADR-0292 (M4.15.f tenants list csv-full) |

## Context

ADR-0297 Q1 deferred
"`--no-header` flag —
for per-tenant fetches
that will be concat'd
onto list output,
the header is
redundant."

The M4.15.j shipped
`tenants get --format
csv/csv-full` matching
`tenants list` column
order exactly so per-
tenant fetches could
be concat'd onto bulk-
list output. But the
documented workflow
required manual
`tail -1` to strip
the header line:

```bash
crossengin tenants list \
  --format csv-full > all.csv
crossengin tenants get acme-prod \
  --format csv-full | tail -1 \
  >> all.csv
```

The `tail -1` step
is fragile (loses
data when the
output happens to
be empty) and adds
shell-ceremony that
should belong to the
CLI.

## Decision

Add `--no-header`
boolean flag to
`tenants get` and
`tenants list`.
When set:

- CSV/TSV/CSV-full
  output skips the
  leading header
  row.
- Empty result
  set produces
  empty output
  (no blank
  header line),
  so shell `>>
  all.csv`
  redirection
  is a true
  no-op on
  empty.
- Json/human
  formats
  silently
  ignore the
  flag
  (matching
  --csv-
  separator
  precedent).

### Shared
plumbing in
`format.ts`

`formatCsv`,
`printCsv`,
`formatTsv`,
`printTsv` all
gain a 5th /
4th optional
`opts: {
noHeader?:
boolean }`
parameter.
Backward-
compatible:
existing
callers pass
no opts and
get the
default
header-
included
behavior.

When
`noHeader:
true` and
rows is
empty, the
output is
the empty
string
(rather than
a single
trailing
newline). This
ensures the
`tenants list
--no-header`
on an empty
result set
doesn't add
a blank line
to a `>>
all.csv`
target.

### Workflow
simplification

```bash
crossengin tenants list \
  --format csv-full > all.csv
crossengin tenants get acme-prod \
  --format csv-full --no-header \
  >> all.csv
```

No `tail -1`,
no empty-line
edge case.

## Rejected
alternatives

1. **Default
   `--no-
   header`
   on `tenants
   get`** —
   would
   break
   standalone
   usage
   (`tenants
   get
   <slug>
   --format
   csv`
   without
   redirect
   loses
   header
   context).
   Opt-in
   preserves
   both
   workflows.

2. **Use
   `--bare`
   or
   `--data-
   only`
   as the
   flag
   name**
   —
   `--no-
   header`
   matches
   established
   conventions
   in
   `xsv`,
   `mlr`,
   `csvtool`,
   and
   pandas
   `read_csv
   (header=
   None)`.

3. **Use
   `--header
   ={true,
   false}`
   for
   future
   expansion
   (e.g.,
   `--header
   =short`)
   ** —
   boolean
   flag
   is
   simpler
   for
   the
   90%
   case.
   Future
   variations
   could
   be
   additional
   flags.

4. **Add
   a
   `--csv-
   envelope`
   instead
   (emit
   action
   /
   metadata
   as
   a
   header-
   row
   prefix)
   ** —
   different
   feature
   entirely;
   not a
   substitute.

5. **Apply
   only to
   `tenants
   get`
   (skip
   list)
   ** —
   list-
   bulk
   concat
   ("bulk-
   fetch
   2 sets
   into
   one
   file")
   is a
   real
   workflow
   too;
   exposing
   the
   flag
   on
   both
   is
   consistent.

6. **Apply
   universally
   to every
   CSV emit
   site in
   the CLI
   (housekeeping
   diff,
   policies
   diff,
   retention
   *)** —
   the
   primary
   use
   case
   is
   list/
   get
   concat;
   broader
   surfaces
   are
   already
   per-
   command
   data
   shapes
   so
   header
   suppression
   isn't
   as
   meaningful.
   Future
   Q if
   demand
   emerges.

7. **Wire
   the
   flag
   into
   the
   global
   format
   layer
   (auto-
   honored
   by
   every
   printCsv
   /
   printTsv
   call
   without
   per-
   site
   plumbing)
   ** —
   tempting,
   but
   `printCsv`
   doesn't
   have
   access
   to
   `command`.
   The
   per-
   site
   plumbing
   is
   the
   correct
   abstraction
   level.

## Drawbacks

- **Concat
  workflow
  still
  requires
  operator
  discipline**
  (run
  `list`
  without
  `--no-
  header`,
  then
  every
  `get`
  with
  `--no-
  header`).
  No way
  to
  auto-
  detect.

- **`--no-
  header`
  + empty
  rows =
  empty
  output**
  may
  surprise
  someone
  who
  expected
  a
  newline-
  only
  "empty
  file"
  result.
  Matches
  shell
  pipeline
  conventions
  (empty
  is
  empty)
  but
  worth
  the
  ADR
  callout.

- **Other
  CSV
  surfaces**
  (retention
  diff,
  policies
  diff,
  housekeeping
  diff)
  still
  emit
  headers
  unconditionally.
  Future
  Q.

## Future Qs

1. **`--no-
   header`
   on
   retention
   diff
   /
   policies
   diff /
   housekeeping
   diff /
   retention
   history
   /
   timeline
   surfaces**
   if
   operator
   demand
   emerges.
   Same
   shared
   `noHeader`
   opt
   would
   apply.

2. **`--csv-
   envelope`
   to emit
   action +
   filter
   context
   as
   leading
   comment
   line**
   (mentioned
   in
   ADR-
   0297
   future
   Q;
   different
   feature).

3. **`--columns
   col1,col2`
   subset
   filter**
   (ADR-
   0297
   Q2;
   composes
   with
   `--no-
   header`
   for
   custom-
   shape
   concat
   workflows).

4. **Auto-
   detect
   header
   on
   subsequent
   appends**
   via a
   sentinel
   line —
   too
   magic;
   keep
   explicit.

5. **`tenants
   resolve
   --no-
   header`
   parity**
   — `tenants
   resolve`
   doesn't
   emit
   CSV
   currently;
   if
   that
   surface
   gains
   CSV
   in a
   future
   ADR,
   `--no-
   header`
   would
   apply
   uniformly.
