# ADR-0310: `apply --format gh-summary` Markdown rendering

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0309 (M4.15.v workflow validate gh-summary), ADR-0307 (M4.15.t sessions list pivot), kernel-pg ApplyReport shape |

## Context

The M4.15.v
extension brought
gh-summary to
`workflow validate`
— a CI gate
that benefits
from at-a-glance
verdict emoji in
GitHub Actions
step summary UI.

`apply` is the
foundational
schema-migration
command: applies
the kernel meta-
schema (~50
statements) plus
optional vertical
pack DDL (e.g.,
`operate-erp/
core`,
`operate-erp/
healthcare`,
`operate-erp/
payments`). It
runs in CI on
every infra
change. Before
M4.15.w it
emitted only
json + human.

CI operators
running
`crossengin
apply --confirm`
got either:
- A JSON blob
  (parseable but
  unreadable in
  Actions UI).
- A stream of
  applied/skipped/
  failed counts
  via
  `formatApplyReport`
  (readable but
  no visual
  distinction
  from log
  output).

When apply
fails — most
commonly on
preconditions
(missing
`pg_uuidv7`,
too-old PG)
or schema-
collision
errors — the
failure mode
deserves an
emoji-prefixed
verdict line
and a tabular
breakdown of
the specific
failed
statements.

## Decision

Add `--format
gh-summary`
to `apply`,
covering both
the live and
dry-run code
paths.

### Live
apply path

`formatApply
ReportGhSummary`
renders an
ApplyReport
as Markdown.
Three branches
matching the
exit-code
semantic:

1. **Precondition
   failure**
   (preconditions.
   ok === false):
   render
   `### Precondition
   problems (N)`
   table (Code |
   Message | Remedy)
   + verdict
   `:x: **Apply
   blocked** —
   preconditions
   failed; no
   statements
   executed.`
   The
   per-statement
   table doesn't
   appear since
   nothing ran.

2. **Failed
   statements**
   (failed > 0):
   render
   `### Failed
   statements
   (N)` table
   (Hash |
   Excerpt |
   Error) +
   verdict
   `:x: **Apply
   halted at
   statement
   X/N**` (if
   haltedAt set)
   or `:x:
   **Apply
   completed
   with errors**`
   (no halt).
   Successful
   statements
   omitted —
   would be
   50+ rows of
   noise.

3. **Clean
   apply**:
   verdict
   `:white_
   check_mark:
   **Apply
   succeeded** —
   N executed,
   M skipped.`

### Dry-run
path

`formatApply
DryRunGhSummary`
renders an
informational
summary
(no verdict,
since dry-run
is not a
gate):

```
## Apply (dry-run): meta schema [+ pack `slug`]

**Schema:** `meta`
[**Pack:** `slug` (schema `public`)]
**Statements planned:** N (M meta + P pack) | **Meta tables:** T

_Dry-run: no statements executed. Re-run without `--dry-run`
and with `--confirm` to apply._
```

The italic note
nudges operators
toward the
correct
follow-up
command.

### Header
shape

Title reflects
the pack mode:
- No pack:
  `## Apply: meta schema`
- With pack:
  `## Apply:
  meta schema +
  pack `<slug>``

Pack line
emitted only
when set.
This keeps
the header
self-
documenting
without
forcing
empty
fields.

### Failed-
statement
table
columns

`Hash | Excerpt
| Error`:
- **Hash**:
  truncated
  to 8 chars
  for table
  compactness
  (full hash
  available
  in
  --format
  json).
  Operators
  needing
  the full
  hash for
  audit
  query
  pivot via
  the JSON
  output.
- **Excerpt**:
  raw SQL
  excerpt
  from
  ApplyReport.
  Pipe-
  escaped.
- **Error**:
  errorMessage
  with null
  fallback to
  `(no error
  message)`.

### Precondition-
problems
table
columns

`Code | Message
| Remedy`:
remedy cell
empty when
remedy is
null (matches
the
`PreconditionProblem`
shape).

### `haltedAt`
verdict text

When the
applier halts
on error, the
verdict
displays the
1-indexed
position
relative to
totalStatements.
This matches
how operators
think about
"the apply
got to
statement X
of N before
failing" —
a 0-indexed
position
would
mismatch the
"how many
applied" mental
model.

## Rejected
alternatives

1. **Show
   all
   statements
   (including
   succeeded
   ones)** —
   50+ rows
   of
   "succeeded:
   yes" is
   pure
   noise.
   The
   failure
   triage
   workflow
   only
   cares
   about
   what
   broke.

2. **Show
   hash
   full
   length
   (16 hex
   chars)** —
   too wide
   for the
   Hash
   column.
   8 chars
   is the
   git-
   convention
   short-
   hash.

3. **Include
   per-
   statement
   duration**
   — useful
   for perf
   triage
   but adds
   another
   column.
   Full
   duration
   available
   in JSON.

4. **Emit
   precondition
   verdict
   even on
   success
   ("All
   N
   preconditions
   pass")
   ** —
   noisy
   for the
   common
   case;
   absence
   of
   problems
   is the
   signal.

5. **Use
   `:fire:`
   for
   halted-
   at
   verdict
   instead
   of
   `:x:`** —
   stuck
   with the
   M4.15.e
   convention.

6. **Make
   the
   precondition
   table
   collapse
   into
   `<details>`
   when
   problems
   > 5** —
   precondition
   problems
   are
   rare
   (typically
   1-2); 5+
   rows
   wouldn't
   benefit
   from
   collapse.

7. **Emit
   verdict
   for
   dry-run
   ("plan
   looks
   clean")**
   — dry-
   run can't
   verify
   preconditions
   (no PG
   connection)
   or
   detect
   collisions,
   so any
   verdict
   would
   be a
   lie.
   Informational
   text is
   correct.

8. **Use
   `:white_
   check_
   mark:` for
   dry-run
   to
   signal
   "plan
   parsed
   successfully"**
   — operators
   would
   read it
   as
   "apply
   succeeded".
   Reserved
   the
   success
   verdict
   for
   actual
   apply.

## Drawbacks

- **Successful
  statement
  detail is
  lost in
  gh-summary
  mode** —
  operators
  needing
  the full
  applied
  list use
  `--format
  json`.

- **Hash
  truncation
  to 8
  chars
  has a
  collision
  risk**
  (~2^32
  values).
  Acceptable
  for
  triage
  scoping
  — operators
  pivoting
  to full
  query use
  JSON.

- **Dry-
  run no
  verdict
  surprises
  CI
  pipelines
  expecting
  a
  pass/fail
  signal**
  — they
  should
  use
  `--format
  json` for
  programmatic
  consumption.

- **PreconditionProblem
  remedy
  cell
  empty
  when
  null
  looks
  visually
  identical
  to "no
  remedy
  available"**
  — pipe-
  escape
  the
  intentional-
  null
  case
  would
  add a
  literal
  cell
  marker
  but at
  the
  cost of
  treating
  null +
  empty-
  string
  the
  same.
  Acceptable
  consistency.

- **2 new
  exported
  helpers
  (formatApply
  ReportGhSummary,
  formatApply
  DryRunGhSummary)
  ** — both
  needed
  for
  independent
  unit
  testing
  + reuse
  by
  potential
  future
  surfaces
  (e.g.,
  `apply
  --report
  <run-id>
  --format
  gh-
  summary`
  if
  history
  ever
  becomes
  a thing).

## Future Qs

1. **`apply
   --report
   <run-id>
   --format
   gh-
   summary`**
   if apply
   ever
   persists
   reports
   to a
   PG
   table
   (operators
   could
   re-fetch
   past
   apply
   results).

2. **GitHub
   workflow
   command
   annotations**
   for
   inline
   markers
   on the
   migration
   file
   (the
   same
   future Q
   as
   M4.15.v).

3. **Per-
   pack
   verdict
   when
   apply
   is
   batched
   across
   multiple
   packs**
   — current
   shape is
   1 pack
   at a
   time.

4. **CSV
   output
   for
   failed
   statements**
   (hash,
   excerpt,
   error)
   for
   pipelines
   archiving
   apply
   failures.

5. **`--quiet`
   gh-
   summary
   variant**
   that
   skips
   the
   table
   and
   emits
   only
   the
   verdict
   line.

6. **Include
   pack
   description
   in the
   header**
   (`## Apply:
   meta
   schema +
   pack
   `retail-
   fnb`
   (Retail
   F&B)`)
   for
   self-
   documenting
   summaries.
