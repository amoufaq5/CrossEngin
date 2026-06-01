# ADR-0306: `tenant policies --diff --axis --format gh-summary` axis-aware headers

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0299 Q4 (closes), ADR-0299 (M4.15.l --axis filter), ADR-0292 (M4.15.e policies gh-summary baseline) |

## Context

ADR-0299 Q4 deferred
"gh-summary table
header reflects
filter ('Retention
field changes (N)'
when --axis
retention) for
clearer CI step
summary output".

After M4.15.l shipped
`--axis` filtering on
`tenant policies
--diff` (narrows
fieldDiffs to one of
retention /
costCeiling / tier),
the gh-summary
renderer continued
to emit the generic
"## Diff: tenant
policies" title and
"### Field changes
(N)" section header
regardless of the
axis scope. CI step
summary readers
couldn't tell at a
glance whether the
emitted diff
represented all
axes or just a
narrowed slice.

The Axis column in
the table also
became redundant
under filtering —
every row repeats
the same axis value
50+ times.

## Decision

When `axisFilter` is
non-null in the
gh-summary renderers
(both pair-wise and
N-way), customize
4 surfaces:

1. **Title**: append
   axis scope in
   parens — "##
   Diff: tenant
   policies
   (retention
   axis)".
2. **Section
   header**: scope
   the field-
   changes label —
   "### Retention
   field changes
   (N)".
3. **Table
   shape**: drop
   the Axis column
   (saves
   horizontal
   space for value
   columns that can
   be wide). New
   header: `| Field
   | Left | Right
   |`.
4. **Verdict
   text**: scope
   the divergence
   message —
   ":warning:
   **Retention
   divergence
   detected**" or
   ":white_check_
   mark: **No
   retention
   differences** —
   both tenants
   match on this
   axis".

### Axis labels

Sentence-case for
mid-line use:

```typescript
const POLICIES_AXIS_LABELS = {
  retention: "Retention",
  costCeiling: "Cost ceiling",
  tier: "Tier",
};
```

`"Cost ceiling"`
(two words) reads
better in a
summary line than
the camelCase
`costCeiling`. The
title suffix
preserves the
camelCase form
since it's
matching the
flag-value
parens convention.

### N-way
parity

`renderPolicies
MultiDiffGhSummary`
gets the same
treatment: title
suffix, per-
comparison tables
drop the Axis
column, verdict
references the
axis ("All
comparisons match
on the tier
axis." /
":warning:
**Tier
divergence
detected** in at
least one
comparison").

### Backward
compatibility

Without `--axis`
(axisFilter ===
null), the output
shape is
identical to
M4.15.e: generic
title, "Field
changes (N)"
header, Axis
column present,
"Divergence
detected" verdict.
No existing
parsers / log
matchers break.

## Rejected
alternatives

1. **Keep
   the Axis
   column
   even
   under
   filter
   for
   shape
   consistency**
   — every
   row
   shows
   the
   same
   value;
   pure
   noise.
   Operators
   prefer
   wider
   value
   columns.

2. **Use
   axis
   name
   verbatim
   in the
   verdict
   ("Cost
   Ceiling
   divergence")**
   —
   "Cost
   ceiling"
   sentence-
   case
   reads
   better.
   Style
   consistency
   matters
   when the
   text is
   rendered
   mid-
   paragraph.

3. **Emit
   a
   separate
   `### Axis
   scope:
   retention`
   subheader
   instead
   of
   inlining**
   — adds
   a noisy
   line.
   Inlining
   in
   title +
   section
   header is
   compact.

4. **Use
   axis
   emoji
   ("⚖️
   Tier
   divergence
   detected")**
   — cute
   but
   non-
   accessible.
   Consistent
   with the
   broader
   ADR-0292
   rejection
   of decorative
   emoji in
   gh-summary.

5. **Show
   axis
   scope
   only
   in the
   verdict,
   not in
   the
   title**
   — title
   scope
   is the
   most
   important
   tell:
   operators
   scanning
   a CI
   step
   summary
   read
   titles
   first.

6. **Drop
   the
   "(retention
   axis)"
   from
   the
   title
   when
   only
   one
   axis
   exists**
   — every
   --axis-
   filtered
   run has
   exactly
   one
   axis;
   the
   suffix
   is
   always
   meaningful.
   Don't
   special-
   case.

7. **Move
   axis
   metadata
   to a
   `<details>`
   block**
   — hidden
   metadata
   defeats
   the
   purpose
   of the
   summary
   format.

8. **Drop
   the
   filter
   compose
   with
   --axis
   when
   --include-
   policy-
   count
   is
   on
   (treat
   axis as
   pre-
   compute)**
   — out
   of
   scope;
   M4.15.s
   is
   strictly
   a
   rendering
   change.

## Drawbacks

- **Two
  rendering
  shapes
  per
  surface**
  (pair
  vs.
  N-way)
  × two
  modes
  (filtered
  vs.
  not)
  =
  4
  effective
  shapes.
  Test
  matrix
  expands.

- **Operators
  scripting
  `grep
  '## Diff:
  tenant
  policies$'`
  in
  multi-
  step
  CI
  pipelines
  may
  miss
  filtered
  runs**
  — the
  title
  suffix
  breaks
  literal-
  match.
  Workaround:
  use
  `grep
  '^## Diff:
  tenant
  policies'`
  (prefix
  match).

- **Axis
  label
  vocabulary
  must
  stay
  in
  sync**
  with
  the
  flag
  values
  +
  schema
  axis
  names.
  Currently
  3
  entries
  in
  `POLICIES_
  AXIS_
  LABELS`;
  if a
  4th
  axis is
  added,
  forgetting
  to
  extend
  the
  record
  triggers
  TS
  error
  via
  the
  `Record<
  PoliciesDiff
  AxisValue,
  string>`
  exhaustiveness
  check
  —
  which is
  the
  whole
  point.

- **Housekeeping
  diff
  gh-
  summary
  doesn't
  get
  the
  same
  treatment**
  (yet) —
  it has
  its own
  --axis
  from
  M4.15.h
  (2
  axes:
  gateway/
  retention).
  Same
  pattern
  could
  apply;
  defer.

## Future Qs

1. **Same
   axis-
   aware
   treatment
   for
   housekeeping
   diff
   gh-
   summary**
   when
   `--axis
   gateway|
   retention`
   is set.
   Same
   shape
   conventions
   apply
   (2-axis
   instead
   of
   3-axis).

2. **Axis-
   aware
   gh-
   summary
   for
   retention
   diff
   family**
   if M4.15.l-
   style
   `--axis`
   filter
   extends
   to
   retention
   (currently
   M4.15.l
   is
   policies-
   only).

3. **Per-
   axis
   verdict
   emoji
   variants**
   ("🔁
   Tier
   change",
   "💰
   Cost
   ceiling
   change")
   if
   operators
   want
   visual
   axis
   distinction.

4. **Axis-
   aware
   CSV
   header
   too**
   — e.g.,
   `tenant_a_
   retention_
   value`
   instead
   of
   `tenant_
   a_value`
   when
   `--axis
   retention`.
   Adds
   complexity;
   defer
   until
   asked.

5. **`--axis-
   in-
   title-
   only`
   /
   `--axis-
   no-
   title`**
   for
   operators
   wanting
   the
   M4.15.e
   shape
   but
   the
   axis-
   filtered
   data.
   Over-
   engineered
   for
   the
   common
   case.

6. **Custom
   axis-
   label
   overrides
   via
   config
   file**
   for
   operators
   wanting
   non-
   English
   labels.
   Defer.
