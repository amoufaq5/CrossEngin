# ADR-0321: `tenant housekeeping --diff --axis --format gh-summary` axis-aware (M4.15.ah)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0306 (M4.15.s policies gh-summary axis-aware), ADR-0299 future Q1 (housekeeping gh-summary axis-awareness deferred), ADR-0314 (M4.15.aa tenant housekeeping gh-summary baseline) |

## Context

M4.15.s (ADR-
0306) made
`tenant policies
--diff --format
gh-summary` axis-
aware on the 3-
axis policies
fieldDiff shape
(retention/
costCeiling/
tier). The 2-
axis housekeeping
diff (gateway/
retention) was
flagged as
deferred in
ADR-0306
drawbacks +
ADR-0299 future
Q1:

> housekeeping
> diff gh-summary
> doesn't get same
> treatment yet —
> own --axis from
> M4.15.h 2-axis
> gateway/
> retention;
> defer

The pair-wise
`renderHousekeeping
DiffGhSummary`
and N-way
`renderHousekeeping
MultiDiffGhSummary`
helpers existed
(shipped M4.15.e)
but always
rendered the
generic "##
Diff: tenant
housekeeping"
title + Axis
column regardless
of whether
`--axis
gateway|retention`
was set.

CI step
summary
readers
running an
axis-scoped
gate
couldn't
tell at a
glance
which axis
the diff
represented.

## Decision

Apply the
M4.15.s axis-
aware pattern
to both
housekeeping
diff
renderers
(pair +
N-way),
mirroring
the policies
treatment
exactly with
the only
difference
being the
axis label
set (2-axis
vs 3-axis).

### Axis
labels

```typescript
const HOUSEKEEPING_AXIS_LABELS: Record<"gateway" | "retention", string> = {
  gateway: "Gateway",
  retention: "Retention",
};
```

Sentence-
case
labels
for
mid-line
use
matching
the
M4.15.s
POLICIES_AXIS_LABELS
convention.

### 4
surface
customizations
when
`axisFilter`
is non-null

Same as
M4.15.s
(ADR-
0306):

1. **Title**:
   `## Diff:
   tenant
   housekeeping
   (gateway
   axis)` or
   `(retention
   axis)`.
2. **Section
   header**:
   `### Gateway
   field
   changes
   (N)` or
   `###
   Retention
   field
   changes
   (N)`.
3. **Table**:
   Axis
   column
   dropped
   (saves
   horizontal
   space).
   New 4-
   col
   shape:
   `| Table |
   Field |
   Left |
   Right |`.
4. **Verdict**:
   `:warning:
   **Gateway
   divergence
   detected**`
   /
   `:white_
   check_
   mark:
   **No
   gateway
   differences**
   — both
   tenants
   match on
   this
   axis.`

### Backward
compatibility

When
`axisFilter
=== null`
(no
`--axis`
flag), the
M4.15.e
generic
shape is
preserved
exactly:
generic
title,
"Field
changes
(N)"
header,
5-col Axis
column
present,
"Divergence
detected"
verdict.
No
existing
parsers
break.

### N-way
parity

`renderHousekeeping
MultiDiffGhSummary`
gets the
same
treatment:

- Title:
  `##
  Multi-
  comparison
  diff:
  tenant
  housekeeping
  (gateway
  axis)`.
- Per-
  comparison
  tables
  drop
  the
  Axis
  column.
- Match
  verdict:
  `:white_
  check_
  mark:
  **All
  comparisons
  match on
  the
  gateway
  axis.**`
- Divergence
  verdict:
  `:warning:
  **Gateway
  divergence
  detected**
  in at
  least
  one
  comparison.`

### Type-
narrow axis
parameter

Function
signature
uses
`axisFilter:
"gateway" |
"retention"
| null =
null` —
matches
the runtime
axis values
that are
already
type-
narrowed
through
runTenantHousekeepingDiff's
`axisFlag`
validation
at lines
193-200.

## Tests added

4 new tests
across the
new
"tenant
housekeeping
--diff
--axis
<axis>
--format
gh-summary
(M4.15.ah)"
describe
block + 1
existing
M4.15.h
test
updated:

1. **--axis
   retention
   scopes
   all 4
   surfaces**:
   verifies
   title
   suffix +
   section
   header
   match +
   4-col
   table +
   no
   5-col
   Axis
   column.
2. **Without
   --axis
   preserves
   M4.15.e
   generic
   shape**:
   verifies
   no axis
   suffix
   on
   title +
   generic
   section
   header.
3. **--axis
   gateway
   identical-
   tenants
   emits
   axis-
   scoped
   success
   verdict**:
   "No
   gateway
   differences
   — both
   tenants
   match on
   this
   axis."
4. **--axis
   retention
   N-way
   --add-
   tenant**:
   verifies
   multi-
   comparison
   title
   has
   "(retention
   axis)"
   suffix +
   Axis
   column
   dropped +
   axis-
   scoped
   verdict
   text.

The
existing
M4.15.h
test
("--axis
gh-summary
integration:
Markdown
table
contains
only
filtered
axis") was
updated to
assert
the new
M4.15.ah
shape
(title
suffix +
4-col
table)
since
the prior
expectation
of
"`|
gateway
|`" in
the Axis
column
became
invalid
when the
column
dropped.

## Coverage
impact

tenant.ts
stays at
91.48%
statements
(M4.15.ae
baseline) —
the new
M4.15.ah
code lives
inside
already-
exercised
gh-summary
render
paths.
Branch
coverage
ticks up
marginally
due to
the new
axisFilter
ternary
branches.

## Rejected
alternatives

1. **Inline
   gh-
   summary
   axis
   logic
   inside
   the
   call
   sites**
   instead
   of
   passing
   axisFilter
   into the
   renderer
   — the
   renderer
   is the
   right
   abstraction
   layer
   (matches
   M4.15.s
   precedent).

2. **Re-
   use a
   shared
   `renderDiff
   GhSummaryAxis
   Aware`
   helper
   between
   policies +
   housekeeping**
   — the
   data
   shapes
   differ
   (housekeeping
   has Table
   column;
   policies
   doesn't).
   Code
   duplication
   minimal;
   helper
   factoring
   not
   worth
   the
   indirection.

3. **Use
   `--substrate`
   instead
   of
   `--axis`
   in
   labels**
   — stuck
   with
   "axis"
   terminology
   from
   M4.15.h
   /
   M4.15.s
   for
   consistency
   across
   the
   diff
   family.

4. **Drop
   the
   Axis
   column
   for
   ALL
   gh-
   summary
   output
   (axis-
   filtered
   or
   not)**
   — would
   break
   the
   M4.15.e
   shape
   that
   was
   shipped.
   Backward-
   compat
   preserved.

5. **Use
   gateway/
   retention
   emoji**
   (`:gear:` /
   `:floppy_
   disk:`)
   in the
   verdict —
   non-
   accessible;
   consistent
   with
   ADR-
   0306
   rejection.

6. **Add
   `--axis
   field=
   <name>`
   sub-axis
   filter**
   for
   "show
   only
   retentionDays
   field" —
   future
   Q.

## Drawbacks

- **Two
  rendering
  shapes
  per
  surface**
  (pair
  vs
  N-way)
  × two
  modes
  (filtered
  vs
  not)
  = 4
  effective
  shapes.
  Same
  as
  policies
  side
  (ADR-
  0306).

- **Operators
  grepping
  `'## Diff:
  tenant
  housekeeping$'`
  literal-
  match in
  CI
  pipelines
  may miss
  filtered
  runs** —
  workaround:
  prefix-
  match
  `'^##
  Diff:
  tenant
  housekeeping'`.

- **Axis
  label
  vocabulary
  must
  stay
  in
  sync**
  with
  flag
  values
  + schema
  axis
  names.
  Currently
  2
  entries
  in the
  Record
  type;
  TS
  exhaustiveness
  check
  catches
  drift.

- **Code
  duplication
  with
  policies
  side**
  — both
  files
  define
  similar
  axis-
  aware
  rendering
  patterns.
  Acceptable
  given
  the
  data-
  shape
  differences
  (housekeeping
  fieldDiff
  has
  Table
  column;
  policy
  doesn't).

## Future Qs

1. **`--axis
   field=
   <name>`**
   sub-axis
   filter
   for
   targeting
   one
   field
   within
   an
   axis
   ("only
   retentionDays
   field
   on the
   retention
   axis").

2. **Cross-
   surface
   axis-
   aware
   verdict
   in
   `tenant
   housekeeping`
   non-
   diff
   path**
   when
   `--axis`
   is set
   on the
   non-
   diff
   flow.

3. **Per-
   axis
   color
   tinting**
   in the
   gh-
   summary
   verdict
   ("⚠️
   Gateway
   divergence"
   vs
   "⚠️
   Retention
   divergence")
   for
   visual
   distinction.

4. **Factor
   shared
   diff-
   axis
   helpers**
   between
   policies +
   housekeeping
   if more
   axis-
   aware
   render
   targets
   land.
