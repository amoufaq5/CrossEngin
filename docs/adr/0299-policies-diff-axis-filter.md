# ADR-0299: `tenant policies --diff --axis` 3-axis substrate filter

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0295 Q1 (closes), ADR-0291 (M4.15.h housekeeping --axis 2-axis precedent) |

## Context

ADR-0295 Q1 deferred
"`--axis` filter on
`tenant policies --diff`
(3-axis: retention|
costCeiling|tier),
mirroring the M4.15.h
housekeeping --axis 2-
axis pattern."

`tenant policies` is the
broadest diff surface in
the CLI: it aggregates
retention overrides
(per-table), cost-ceiling
override (per-tenant
singleton), and tier
membership (per-tenant
singleton) into one
report and emits
fieldDiffs grouped by
`axis: "retention" |
"costCeiling" | "tier"`.

Operators wanting
substrate-scoped CI gates
("only trip exit 3 when
retention diverges, not
cost-ceiling") had to
post-process JSON via jq
client-side.

## Decision

Add `--axis
retention|costCeiling|
tier` to `tenant
policies --diff`.

### Validation

`--axis` value must be
one of the three valid
axes. Invalid value
exits 2 with `invalid
--axis '<value>'
(expected one of:
retention,
costCeiling, tier)`.

Validation fires
up-front in
`runTenantPoliciesDiff`
before any PG round-
trip — early-exit on
typo'd axis values.

### Filter
application

Post-compute filter
on `fieldDiffs.filter
((d) => d.axis ===
axis)`. The filter
narrows the result
set; the underlying
`computePolicyField
Diffs` is unchanged
(no extra PG cost,
no axis-specific
gather).

Applied in both
emit paths:
- `emitDiffOutput`
  (pair-wise diff)
- `emitMultiDiffOut
  put` (N-way via
  --add-tenant or
  repeated --vs-
  tier)

Each comparison in
the N-way path
gets its
fieldDiffs
narrowed
independently.

### Composition

- `--exit-on-
  divergence
  --threshold N`
  gates on
  FILTERED count.
  `--axis
  retention
  --exit-on-
  divergence`
  only trips exit
  3 when
  retention-axis
  fields diverge.
- `--add-tenant`
  (N-way):
  per-comparison
  filter.
- `--vs-tier`
  (synthetic-
  RHS): same
  filter applies.
- All output
  formats (json,
  csv, tsv,
  human, gh-
  summary) emit
  the filtered
  set.

## Rejected
alternatives

1. **Allow
   multiple
   `--axis`
   values (`
   --axis
   retention
   --axis
   costCeiling
   `)** —
   doable but
   adds
   complexity
   and the
   negative-
   filter case
   isn't
   addressed.
   With only 3
   axes,
   needing 2 of
   them is rare;
   2 separate
   runs are
   cheap.

2. **Use
   `--exclude-
   axis
   tier`
   instead** —
   "show me only
   X" is more
   common in
   audit
   workflows
   than "show
   me
   everything
   except X".
   Inverted
   phrasing
   surprises.

3. **Filter at
   compute layer
   inside
   `computePolicy
   FieldDiffs`** —
   would thread
   the filter
   into a pure
   helper. Post-
   filtering keeps
   the helper
   axis-agnostic +
   testable in
   isolation.

4. **Treat
   `--axis
   bogus` as
   "no filter"
   (silent)** —
   silent typos
   surprise. Loud
   error
   ("invalid
   --axis
   'bogus'") is
   the
   established
   pattern from
   ADR-0291.

5. **Server-side
   axis-specific
   gather (skip
   the costCeiling
   query when
   `--axis
   retention`)** —
   would
   complicate
   orchestration
   for marginal
   benefit (the
   3 axis
   queries are
   already in
   parallel via
   Promise.all
   and each is
   sub-50ms).
   The post-
   filter is
   fine.

6. **Pre-set
   `--axis
   retention`
   as default
   to match the
   most common
   case** —
   surprising
   default that
   hides
   cost-ceiling
   + tier
   divergence
   in CI gates.

7. **Use
   `--substrate`
   instead of
   `--axis`** —
   housekeeping
   --axis from
   M4.15.h
   already
   established
   the term;
   consistency
   matters more
   than the
   slight
   imprecision
   ("axis" as
   field-diff
   grouping vs.
   "substrate"
   as
   compute-
   layer
   boundary).

## Drawbacks

- **3-axis
  ergonomics**:
  housekeeping
  had 2 axes
  (gateway/
  retention);
  policies has
  3 (retention/
  costCeiling/
  tier). The
  costCeiling
  axis is a
  singleton
  (one row per
  tenant or
  null) so its
  fieldDiffs
  are sparser
  than
  retention's
  (per-table)
  — operators
  filtering by
  costCeiling
  often see 0
  or 1
  results,
  which can
  look like
  the filter
  is broken.

- **No
  `--axis
  field`-level
  filter** —
  operators
  wanting just
  "tier.tierId"
  vs the full
  tier axis
  would use jq
  client-side.

- **Two-axis
  parity issue**
  with M4.15.h:
  housekeeping
  uses
  `retention|
  gateway` while
  policies uses
  `retention|
  costCeiling|
  tier`. They
  share the
  "retention"
  literal but
  not the
  others — a
  CI workflow
  scripting
  both can't
  use a single
  variable for
  the axis.

## Future Qs

1. **`--axis
   field=<name>`
   for sub-axis
   field filter
   ("--axis
   retention.
   retentionDays
   only")**.

2. **`--axis
   first,second`
   for OR-of-
   axes (2 of
   3)** if
   operator
   demand
   emerges.

3. **`--axis-
   exclude`
   counterpart**
   for negative
   filter
   workflows.

4. **gh-
   summary
   table header
   reflects
   filter
   ("Retention
   field
   changes (N)"
   when --axis
   retention)
   ** for clearer
   CI step
   summary
   output.

5. **Same
   `--axis`
   filter
   pattern on
   retention's
   N-way
   `field
   Variations`
   shape** for
   the
   subset of
   retention
   axes:
   per-table
   fields
   (retentionDays,
   enabled,
   optOut...).

6. **Cohort
   audit: count
   tenants
   diverging
   per axis
   from the
   tier baseline
   ("how many
   tenants
   have
   non-default
   tier
   retention?
   ")** —
   requires a
   bulk gather,
   not the
   per-tenant
   diff
   surface.
