# ADR-0295: `tenant housekeeping --diff --axis` substrate filter

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0291 Q2 (closes), ADR-0291 (housekeeping diff CSV), ADR-0290 (housekeeping N-way), ADR-0288 (housekeeping diff) |

## Context

ADR-0291 Q2 deferred "`--axis
gateway|retention` filter for
single-axis CSV export." After
M4.15.a/c/d shipped the
housekeeping diff with full
JSON/CSV/Markdown coverage,
operators auditing only one
substrate surface (e.g., "did
retention overrides drift?")
still saw gateway-axis fieldDiffs
mixed in.

Real workflows:

1. **Substrate-scoped audit**
   — GRC auditor reviews
   retention overrides only;
   gateway diffs are out of
   scope.
2. **Substrate-scoped CI gate**
   — pipeline gates on
   retention-only changes
   (cost-tier changes are
   gated elsewhere).
3. **Triage scoping** —
   incident response narrows
   to the affected substrate.

## Decision

Add `--axis gateway|retention`
flag to `tenant housekeeping
--diff`. The filter is a
post-processing step on the
computed fieldDiffs array —
no extra PG cost.

### Implementation

- Parse `--axis` in
  `runTenantHousekeeping`
  before dispatch to
  `runTenantHousekeepingDiff`.
- Reject invalid values with
  exit 2 + message
  "invalid --axis 'X'
  (expected 'gateway' or
  'retention')".
- Thread the filter through
  `runTenantHousekeepingDiff`
  as an optional parameter.
- Both single (`n === 1`)
  and N-way (`n > 1`) paths
  apply the filter via
  `rawFieldDiffs.filter((d) => d.axis === axisFilter)`
  before emission.
- Exit code reflects the
  FILTERED count, so
  `--exit-on-divergence
  --axis retention` only
  trips on retention-axis
  divergences.

### Composition

- All output formats
  (json, csv, tsv, human,
  gh-summary) — filter
  applies identically.
- N-way (`--add-tenant`)
  — filter applies
  per-pair.
- `--exit-on-divergence`
  + `--threshold N` —
  the max-divergence
  count is filtered.

### Why post-process,
not server-side filter?

The gather queries
retrieve BOTH axes
unconditionally (single
gather call per
substrate). Filtering at
the SQL level would
require conditional
gather skip, which
complicates the call
graph (and saves
minimal cost since the
gather is already
parallelized). The
post-process filter is
trivially simple +
keeps the gather code
unchanged.

### --axis value
discriminator

Two values
("gateway",
"retention") match the
existing
HousekeepingFieldDiff
`axis` field discriminator
exactly. The CLI
boundary maps directly
to the filter
predicate.

## Rejected alternatives

1. **Server-side filter
   that skips the
   non-matching gather**
   — saves minor PG
   cost but complicates
   gather orchestration
   for marginal
   benefit.

2. **Allow multiple
   --axis flags** —
   meaningless with 2
   axes (omitting the
   flag already gets
   both). If a 3rd
   axis ships, revisit.

3. **`--include-axis
   gateway,retention`
   comma-separated** —
   over-engineered for
   2 options.

4. **`--exclude-axis
   gateway`** — same
   functionality but
   inverted phrasing.
   Positive form
   ("show me only X")
   is more common in
   audit workflows.

5. **Filter at the
   compute layer
   inside
   computeHousekeeping
   FieldDiffs** —
   would require
   threading the
   filter to the
   helper. Filtering
   the output is
   simpler and the
   helper stays a
   pure (axis-
   agnostic)
   computation.

6. **Default to
   "all" if unset
   value isn't
   "gateway" or
   "retention"** —
   silently ignoring
   typos would surprise.
   Strict validation
   exits 2 with clear
   error.

7. **Axis-prefixed
   CSV columns
   (gateway_field,
   retention_field)
   instead of axis
   column** — would
   require wider CSV
   schema; axis-as-
   column is already
   the established
   pattern from
   M4.15.d.

## Drawbacks

- **Empty fieldDiffs
  under filter is
  ambiguous** —
  operator can't tell
  from output alone
  whether "no
  divergences on this
  axis" vs "this axis
  had no overrides to
  compare". The
  JSON envelope's
  left/right reports
  still surface the
  raw data so jq
  pipelines can
  inspect. Acceptable
  trade-off.

- **Doesn't reduce PG
  cost** — gather
  fetches both axes
  regardless. For
  operators paying
  attention to gather
  cost in large
  deployments, the
  filter is a no-op
  on that dimension.

- **`--axis` doesn't
  generalize to other
  diff surfaces (yet)**
  — policies --diff has
  3 axes (retention,
  costCeiling, tier).
  A future M4.16.x
  could extend the
  pattern to policies
  --diff but with
  different axis
  values.

- **Operators might
  expect to pass
  --axis without --diff
  (e.g., on the regular
  housekeeping dashboard)**
  — currently the flag
  only applies in --diff
  mode. Document in CLI
  help.

## Future Qs

1. **Apply --axis to
   policies --diff**
   (would accept
   retention|costCeiling|
   tier).

2. **Allow combined
   --axis 'gateway,
   retention'** —
   pointless with 2
   options but
   future-proofs for
   N axes.

3. **`--include-
   global-stats`
   complement** —
   when set,
   reintroduces the
   global per-table
   diffs that
   M4.15.a/c
   excluded. Pairs
   with --axis as a
   "give me
   everything in
   this axis"
   override.

4. **`--axis-summary`**
   — emit a
   per-axis
   divergence count
   summary line.

5. **`--axis` for
   retention diff
   family** — once
   --gh-summary
   reaches retention.

6. **Apply
   automatically
   based on what's
   in scope of a
   referenced
   ticket** — too
   magical;
   operators specify
   explicitly.
