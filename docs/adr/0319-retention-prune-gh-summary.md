# ADR-0319: `retention prune --format gh-summary` (M4.15.af)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0311 (M4.15.x gateway prune-idempotency gh-summary), ADR-0313 (M4.15.z gateway housekeeping gh-summary), ADR-0314 (M4.15.aa tenant housekeeping gh-summary) |

## Context

The M4.15.x series
shipped gh-summary
on multiple gateway/
tenant CI gate
surfaces: workflow
validate (M4.15.v),
apply (M4.15.w),
gateway prune-
idempotency
(M4.15.x), gateway
housekeeping
(M4.15.z), tenant
housekeeping
(M4.15.aa).
`retention prune`
is another
periodic-
maintenance CI
gate that ran
nightly or per-
deploy but
emitted only
json/yaml/human.

Operators
auditing retention
sweeps wanted
Markdown for
$GITHUB_STEP_
SUMMARY
redirection
showing what
got pruned,
what got
skipped (and
why), and a
single verdict
emoji
indicating
whether the
gate passed.

## Decision

Add `--format
gh-summary` to
both code paths
of
`runRetention
Prune` (dry-run
+ actual
prune). Mirrors
the M4.15.x
gateway prune-
idempotency
gh-summary
shape:

### Shared
shape

```
## Retention prune [(dry-run)]

**As of:** `<iso-timestamp>`
**Entries:** N | **[Would prune | Pruned]:** M | **Skipped:** K [(breakdown)] | **Rows [would be] deleted:** X

| Table | Tenant | Status | Retention | [Would delete | Deleted] | Cutoff |
|-------|--------|--------|----------:|------------:|--------|
| ... | ... | ... | ... | ... | ... |

[verdict]
```

### Per-entry
table

Includes
BOTH counted
(pruned/
previewed)
AND skipped
entries. The
skip status
is actionable
audit info:
operators
need to see
which
tenants
opted out,
which
policies are
disabled, or
which tables
reference an
unknown
table name.
Hiding
skipped
entries
would defeat
the
auditing
purpose.

Skipped
rows get a
`_(skipped)_`
italic
suffix in
the Status
cell to
visually
distinguish
from
successful
rows.

### Cells

- **Table**:
  backticked
  identifier.
- **Tenant**:
  backticked
  UUID when
  set,
  `_(platform)_`
  italic
  marker
  when
  undefined
  (per-tenant
  policy
  rows vs
  platform-
  default
  rows).
- **Status**:
  backticked
  status with
  `_(skipped)_`
  suffix for
  non-counted
  rows.
- **Retention**:
  `Nd`
  literal
  (per
  ADR-
  0313/
  0314
  convention).
- **Count**:
  `toLocale
  String("en-
  US")` for
  thousands
  separators
  on counted
  rows, em-
  dash on
  skipped.
- **Cutoff**:
  backticked
  ISO
  timestamp
  when set,
  em-dash
  when
  null.

### Verdict
semantic

Identical to
M4.15.x
gateway
prune-
idempotency:

1. **Empty
   results
   (no
   policies)**:
   `_No
   retention
   policies
   configured
   [(dry-
   run)]._`
   italic
   marker.
   No
   verdict —
   nothing
   to gate.
2. **Dry-
   run with
   results**:
   `_Dry-run:
   no rows
   deleted.
   Re-run
   without
   --dry-
   run to
   prune._`
   informational
   footer.
   No
   verdict
   emoji
   (operator
   hasn't
   decided
   yet).
3. **Actual
   prune
   with all
   skipped
   results**:
   `:white_
   check_
   mark:
   **Nothing
   to prune**
   — all N
   entries
   skipped.`
   (same
   semantic
   as
   gateway
   prune-
   idempotency
   nothing-
   to-prune).
4. **Actual
   prune
   with > 0
   deleted**:
   `:white_
   check_
   mark:
   **Prune
   succeeded**
   — X
   row(s)
   deleted
   across N
   entries.`

### Skip-
status
breakdown

When
skipped > 0,
the summary
line appends
a
parenthetical
breakdown
sorted
alphabetically:

```
**Skipped:** 3 (1 skipped_disabled, 1 skipped_opt_out, 1 skipped_unknown_table)
```

Sort order
is stable
across runs
so CI
output
diffs
cleanly.
Alphabetical
matches the
formatPruneSummary
convention
from the
human
formatter.

### Type-
safe input
discriminated
union

`RetentionPrune
GhSummary
Input` is a
discriminated
union on
`dryRun:
boolean`:

```typescript
| { readonly dryRun: true;  readonly results: ReadonlyArray<RetentionPreviewResult>; readonly asOf: Date }
| { readonly dryRun: false; readonly results: ReadonlyArray<RetentionRunResult>;     readonly asOf: Date }
```

TS narrows
`results`
to the
correct
shape
inside the
renderer.
This is
cleaner
than the
gateway
prune-
idempotency
input shape
which took
a single
`count`
number —
retention
prune has
distinct
preview vs
run result
types that
need
separate
field
access.

## Tests added

8 new tests
across 2
describe
blocks:

**`runRetention
prune --format
gh-summary
(M4.15.af)`**
(4 tests):

1. --dry-run
   + 1 entry:
   verifies
   title
   suffix,
   "Would
   prune"
   labels,
   per-entry
   row, no
   verdict
   emoji,
   informational
   footer.
2. Actual
   prune
   with 2
   pruned
   entries
   (700
   total
   rows):
   verifies
   "Pruned"
   labels +
   total +
   :white_
   check_
   mark:
   verdict.
3. Empty
   results
   (no
   policies):
   `_No
   retention
   policies
   configured._`
   marker
   without
   per-
   entry
   table.
4. All-
   skipped
   results
   (1
   disabled
   + 1
   opt-out):
   verifies
   Skipped:
   2
   breakdown
   +
   :white_
   check_
   mark:
   Nothing-
   to-prune
   verdict.

**`formatRetention
PruneGhSummary
(M4.15.af)`**
(4 direct
unit
tests):

5. Dry-run
   with
   tenant-
   id +
   cutoff
   renders
   full
   shape.
6. Mixed
   pruned +
   skipped
   renders
   both
   rows +
   skipped
   marker +
   em-dash
   for
   count +
   cutoff
   on
   skipped.
7. Cutoff
   ISO
   timestamp
   when
   set,
   em-dash
   when
   null.
8. Skip-
   status
   breakdown
   sorted
   alphabetically
   across
   3
   distinct
   skip
   reasons.

## Rejected
alternatives

1. **Hide
   skipped
   entries
   from
   the
   per-
   entry
   table**
   — defeats
   the
   auditing
   purpose
   (which
   tenants
   opted
   out is
   actionable
   info).

2. **Use
   `:warning:`
   for
   skipped-
   only
   prune
   case
   instead
   of
   `:white_
   check_
   mark:`**
   — all-
   skipped
   is a
   successful
   gate
   outcome
   (nothing
   matched
   the
   pruning
   criteria),
   not a
   warning.
   Matches
   the
   M4.15.x
   gateway
   prune-
   idempotency
   Nothing-
   to-prune
   pattern.

3. **Add a
   per-
   tenant
   group-
   by
   summary
   row** ("3
   tenants
   opted
   out, 5
   tables
   pruned")
   — useful
   but
   defer
   to
   future
   Q.
   Current
   per-
   entry
   table
   surfaces
   the
   same
   info.

4. **Use
   collapsible
   `<details>`
   for
   skipped-
   only
   per-
   entry
   table**
   — adds
   complexity
   for
   audit
   workflows
   where
   the
   skipped
   detail
   IS the
   point.

5. **Match
   the
   human-
   format
   message
   exactly
   ("retention
   prune
   results
   (N
   entries):")
   ** — too
   wordy
   for
   gh-
   summary
   section
   header.
   Distilled
   to
   summary
   line +
   per-
   entry
   table.

6. **Skip
   the
   summary
   line on
   empty
   results**
   — the
   "_No
   retention
   policies
   configured._"
   message
   IS the
   summary;
   no
   further
   detail
   needed.

7. **Combine
   pruned
   +
   skipped
   counts
   into a
   single
   "Total"
   field**
   — operators
   need to
   distinguish
   them
   for
   gate
   decision-
   making
   (zero
   pruned
   from
   all-
   skipped
   is a
   different
   signal
   from
   zero
   pruned
   due to
   error).

## Drawbacks

- **Per-
  entry
  table
  can be
  wide**
  when
  many
  tenants
  have
  per-
  tenant
  retention
  policies
  (10+
  rows
  with
  full
  UUIDs).
  CI
  step
  summary
  scroll
  is
  generous
  enough
  to
  handle
  it.

- **Cutoff
  timestamp
  in the
  cell
  takes
  ~25
  chars**
  — wide
  but
  necessary
  for
  audit
  reproducibility.
  Operators
  wanting
  a
  narrower
  view
  use
  --format
  json
  +
  custom
  rendering.

- **Em-
  dash
  for
  null /
  skipped
  cells
  is
  Unicode**
  — most
  Markdown
  parsers
  handle
  it
  fine;
  a
  fallback
  ASCII
  dash
  could
  be
  considered
  but
  Unicode
  is the
  established
  convention
  across
  M4.15
  gh-
  summary
  renderers.

- **Discriminated-
  union
  input
  type
  requires
  callers
  to
  pass
  the
  correctly-
  typed
  results**
  — TS
  enforces
  this
  at
  compile
  time
  but
  the
  union
  shape
  adds
  small
  cognitive
  overhead
  for
  fixture
  authors.

- **No
  --tenant
  filter
  echo
  in the
  header**
  if
  retention
  prune
  gains
  a
  --tenant
  flag
  in the
  future
  (it
  doesn't
  currently).

## Future Qs

1. **Per-
   tenant
   group-
   by
   summary
   row** —
   "3
   tenants
   opted
   out, 5
   tables
   pruned"
   for
   aggregate
   visibility.

2. **`retention
   list-
   policies
   --format
   gh-
   summary`**
   for the
   policy-
   inventory
   surface
   (similar
   shape:
   per-
   policy
   table +
   counts).

3. **Per-
   tenant
   detail
   in the
   tenant
   cell**
   when
   --tenant
   slug
   resolution
   is
   available
   (currently
   the
   raw
   UUID
   appears;
   slug
   resolution
   would
   add a
   `(slug)`
   suffix).

4. **Add
   sortable
   per-
   column
   ordering**
   for the
   table —
   currently
   appears
   in
   gather
   order;
   if
   operators
   want
   "biggest
   prune
   first"
   they
   pipe
   through
   their
   own
   sorter.

5. **Mirror
   to
   `retention
   diff` /
   `retention
   diff-
   history`
   /
   `retention
   diff-
   timeline`
   gh-
   summary
   if they
   don't
   have
   it
   already**
   (they
   do —
   M4.15.i/.
   m/.n).
