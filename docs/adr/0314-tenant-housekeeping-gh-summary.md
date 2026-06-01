# ADR-0314: `tenant housekeeping --format gh-summary` cross-dashboard Markdown (M4.15.aa)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0313 (M4.15.z gateway housekeeping gh-summary + threshold-alert helpers), M4.14.l (tenant housekeeping cross-dashboard baseline) |

## Context

M4.15.z shipped gh-
summary on `gateway
housekeeping`
(single substrate)
along with reusable
threshold-alert
Markdown helpers
(`formatTrippedAlert
GhSummaryRow` +
`formatTrippedAlerts
GhSummaryTable`)
explicitly designed
for reuse by tenant
housekeeping when
its own gh-summary
milestone landed.

`tenant housekeeping`
(M4.14.l) is the
cross-dashboard
combined view that
gathers BOTH gateway
and retention
housekeeping reports
under the same
--tenant filter and
runs threshold
alerts across the
union of all tables.
Before M4.15.aa it
emitted only human +
json.

## Decision

Add `--format gh-
summary` format
branch to the non-
watch tenant
housekeeping emit
path. New exported
helper:
`formatTenant
HousekeepingReport
GhSummary`. Reuses
`formatTrippedAlerts
GhSummaryTable`
from threshold-
alert.ts (one-
import lift).

### Markdown
shape

```
## Tenant housekeeping

**As of:** `<timestamp>`
[**Tenant:** `<uuid>`]
[**Scope:** all tenants]
**Gateway tables:** N | **Retention tables:** M

### Gateway substrate

| Table | Total rows | Oldest | Would prune | Retention |
|-------|-----------:|--------|------------:|-----------|
| ...   | 50,000     | `iso`  | 1,042       | 30d       |
| ...   | 1,200      | —      | 300         | _TTL-managed_ |

### Retention substrate

| Table | Total rows | Oldest | Would prune | Retention | Enabled |
|-------|-----------:|--------|------------:|-----------|---------|
| ...   | 100,000    | `iso`  | 5,000       | 90d       | yes     |
| ...   | 2,000,000  | —      | 0           | —         | —       |

### Threshold alerts (N)  [if tripped > 0]
| Table | Field | Actual | Threshold | Age |
...

[verdict footer]
```

### Column
asymmetry
between
substrates

Gateway substrate
table has **5
columns** (no
Enabled column —
gateway tables
either have a
platform policy
or don't, no per-
table enabled
flag).

Retention
substrate table
has **6
columns** —
adds an
Enabled column
(yes/no/—
based on
`enabled:
boolean |
null` field
on
RetentionHouseKeeping
TableReport).
The null case
(unmanaged
table) shows
as `—` per
existing
convention.

This asymmetry
mirrors the
human-format
renderer's
two-section
layout. The
alternative —
forcing both
substrates
into a
single
unified 6-
col table —
would
require the
gateway side
to always
emit `—` for
Enabled,
adding
noise.

### Verdict
semantic

Identical to
M4.15.z
gateway
housekeeping:

1. **Alerts
   not
   evaluated**
   (`hadAlerts
   === false`):
   no verdict
   line. Cross-
   dashboard
   view
   without
   alerts is
   a query
   surface,
   not a
   gate.
2. **Alerts
   evaluated,
   none
   tripped**:
   `:white_
   check_
   mark:
   **All
   threshold
   alerts
   passed.**`
3. **Alerts
   tripped**:
   `:x: **N
   threshold
   alert(s)
   tripped**
   — exit 3
   (CI gate
   failed).`

### `--watch`
incompatibility

Inherited
from
parseWatchFlags
— under
`--watch`,
only
human|json
formats are
allowed.
gh-summary
under
--watch
exits 2
with the
generic
"requires
--format
human or
json"
message.
The test
accepts
either
that
message or
a gh-
summary-
specific
one.

### Code
reuse

`formatTenant
HousekeepingReport
GhSummary`
calls
`formatTrippedAlerts
GhSummaryTable`
from
threshold-
alert.ts —
the same
helper
gateway-
housekeeping
uses. Both
surfaces
emit
identically-
shaped
alert
tables, so
CI step
summary
parsers (if
any) can
treat the
two
surfaces
uniformly.

## Tests added

12 new
tests
across 2
describe
blocks:

**`runTenant
housekeeping
--format
gh-summary
(M4.15.aa)`**
(5 tests):

1. emits
   ## title +
   As of +
   table-count
   metadata +
   two
   substrate
   sections
2. --all-
   tenants
   emits
   `**Scope:**
   all
   tenants`
   line +
   no
   Tenant:
   line
3. emits
   :white_
   check_
   mark:
   verdict
   when
   alerts
   evaluated
   + none
   tripped
4. emits
   :x:
   verdict +
   tripped-
   alerts
   table
   when
   alerts
   trip
   (exit 3)
5. --watch
   + --format
   gh-summary
   rejected
   via
   parseWatchFlags
   (exit 2)

**`formatTenant
HousekeepingReport
GhSummary
(M4.15.aa)`**
(7 tests):

6. gateway
   substrate
   retention
   column:
   `Nd` for
   retention-
   governed,
   `_TTL-
   managed_`
   for
   expires_at
7. retention
   substrate
   Enabled
   column:
   yes/no/—
   for
   enabled/
   disabled/
   null
8. null
   oldestAt
   rendered
   as `—` in
   both
   substrates
9. no
   verdict
   line
   when
   hadAlerts
   === false
10. emits
    :white_
    check_
    mark:
    when
    hadAlerts
    + no
    tripped
11. emits
    :x: +
    tripped-
    alerts
    table
    when
    tripped
    > 0
12. omits
    Tenant +
    Scope
    lines
    when
    cross-
    tenant
    default

## Rejected
alternatives

1. **Force
   both
   substrates
   into a
   single 6-
   col
   unified
   table**
   — would
   require
   gateway
   side to
   always
   emit
   `—` for
   Enabled,
   adding
   noise.
   Two-
   section
   layout
   mirrors
   the
   human-
   format
   structure.

2. **Add
   a third
   `### Cross-
   substrate
   summary`
   section
   with row
   counts
   summed
   across
   both
   substrates**
   — over-
   engineered;
   operators
   wanting
   totals
   can sum
   the
   tables
   themselves.

3. **Render
   tenant
   metadata
   in a
   collapsible
   `<details>`
   block
   when
   `--all-
   tenants`
   set**
   — only
   3 +
   N
   tables
   under
   all-
   tenants;
   `<details>`
   adds
   complexity.

4. **Add
   per-
   tenant-
   override
   sub-
   table
   under
   each
   retention
   substrate
   row
   when
   `--all-
   tenants`
   set** —
   useful
   but
   significantly
   complicates
   the
   shape.
   Defer
   to
   future
   ADR if
   demand
   emerges.

5. **Inline
   `formatTenant
   Housekeeping
   ReportGh
   Summary`
   inside
   `runTenant
   Housekeeping`
   instead
   of
   exporting**
   — exporting
   enables
   direct
   unit
   tests
   (matches
   the
   M4.15.z
   pattern).

6. **Use
   the
   gateway-
   side
   `formatHouse
   keepingReport
   GhSummary`
   helper
   for
   the
   gateway
   substrate
   section** —
   that
   helper
   emits
   a `##
   Gateway
   housekeeping`
   wrapper
   header,
   not
   compatible
   with
   the
   tenant
   cross-
   dashboard
   nesting.
   Inlining
   the
   per-
   table
   grid
   logic
   is
   simpler
   than
   refactoring
   the
   gateway
   helper
   to
   accept
   an
   "embedded
   mode"
   flag.

7. **Defer
   the
   `--watch`
   compatibility
   work
   to a
   future
   ADR**
   — the
   parseWatchFlags
   pre-
   existing
   check
   already
   handles
   it
   (any
   format
   other
   than
   human/
   json is
   rejected
   under
   --watch).
   No
   extra
   work
   needed.

## Drawbacks

- **Column
  asymmetry
  between
  substrates**
  (5 vs 6
  cols)
  may
  surprise
  operators
  expecting
  uniform
  table
  shapes
  per
  section.
  Acceptable
  given
  the
  substrate
  data
  shapes
  genuinely
  differ
  (gateway
  has no
  per-
  table
  enabled
  flag).

- **Cross-
  dashboard
  Markdown
  is wide**
  (two
  6-col
  tables
  +
  metadata
  + alerts
  section)
  — wraps
  on
  narrow
  CI step
  summary
  displays.

- **No
  --tenant-
  slug
  resolution
  in
  header**
  (the
  resolved
  UUID
  appears
  even
  when
  operator
  used
  --tenant
  acme-
  prod) —
  matches
  the
  json
  envelope
  behavior
  but
  loses
  the
  human-
  readable
  slug.
  Acceptable
  for
  audit
  reproducibility.

- **Test
  fixtures
  duplicate
  HousekeepingReport
  +
  RetentionHousekeeping
  Report
  shape
  inline**
  for the
  direct
  formatTenant
  Housekeeping
  ReportGh
  Summary
  tests
  rather
  than
  reusing
  the
  fakeConn
  /
  fakeRetention
  /
  fakeIdempotency
  flow —
  done
  this
  way to
  test
  the
  renderer
  in
  isolation,
  not
  the
  full
  gather
  chain.

## Future Qs

1. **Per-
   tenant-
   override
   sub-table
   under
   each
   retention
   substrate
   row when
   --all-
   tenants
   set** —
   useful
   for
   matrix
   audits.

2. **Inline
   diff
   indicator
   when
   tenant-
   override
   differs
   from
   platform
   default**
   ("**
   :warning:
   override**")
   in the
   Retention
   column
   under
   --tenant.

3. **CSV
   output
   for
   tenant
   housekeeping**
   — cross-
   dashboard
   shape is
   non-
   trivial
   for
   CSV
   (two
   sections);
   would
   need
   a
   long-
   format
   schema.

4. **Tenant-
   slug
   round-
   trip
   in the
   header**
   (echo
   the
   raw
   slug
   when
   operator
   used
   `--tenant
   <slug>`
   alongside
   the
   resolved
   UUID).

5. **Drill-
   down
   to
   GitHub
   workflow
   command
   annotations**
   (`::error
   ::title
   ...`)
   for
   inline
   PR
   markers
   when
   alerts
   trip.

6. **`tenant
   housekeeping
   --diff
   --format
   gh-
   summary`**
   for
   pair-
   wise
   cross-
   dashboard
   diff (a
   substantial
   adjacent
   surface).
