# ADR-0313: `gateway housekeeping --format gh-summary` + threshold-alert Markdown helpers (M4.15.z)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0311 (M4.15.x gateway prune-idempotency gh-summary), ADR-0263 (housekeeping dashboard baseline), ADR-0264 (threshold-alert spec) |

## Context

The original M4.15.z
pick was "threshold-
alert.ts survey +
format coverage" —
on inspection
threshold-alert.ts
isn't a CLI surface,
it's a library used
by gateway-
housekeeping and
tenant-housekeeping
for parsing +
evaluating
`--threshold-alert
<clause>` flags.
Tripped alerts get
rendered by
`renderTrippedAlert
(alert)` into
human-readable
text (`  ! table
field=value trips
threshold "spec"`).

After M4.15.v/w/x
shipped gh-summary
on 3 CI gate
surfaces (workflow
validate, apply,
gateway prune-
idempotency), the
gateway
housekeeping
dashboard — which
has a CI gate
semantic via
`--threshold-alert`
flags — still
emitted only
human + json.
Operators running
housekeeping as a
periodic CI check
got the trip
alert text inline
with the human
dashboard, with
no Markdown
structure suitable
for $GITHUB_STEP_
SUMMARY redirection.

## Decision

Pivot the M4.15.z
scope to:

1. Add `gh-summary`
   format branch to
   `gateway
   housekeeping`
   (non-watch
   mode).
2. Add reusable
   Markdown helpers
   to threshold-
   alert.ts for
   tripped-alert
   rendering, so
   tenant-
   housekeeping +
   future surfaces
   can reuse the
   same shape.

### `formatTrippedAlertGhSummaryRow`

Single tripped
alert → one
Markdown table
row with 5
columns: Table |
Field | Actual |
Threshold | Age.

Compound alerts
(AND/OR with > 1
tripped clause)
render each
clause's field +
actual joined by
`<br>` inside the
cell — keeps the
table shape (5
cols) consistent
without forcing
the renderer to
handle row-
spanning Markdown
(GitHub Markdown
tables don't
support rowspan).
Spec cell
suffixed with
`_(compound)_`
italic marker so
operators see at
a glance which
rows came from
compound
expressions.

Single-clause
alerts render
field as a single
backticked
identifier;
compound alerts
render the field
list. Age column
shows `formatDuration
Ms(ageMs)` for
timestamp-based
alerts; `—` for
non-age alerts.

### `formatTrippedAlertsGhSummaryTable`

Multi-alert table:
header + N rows.
Returns empty
string on empty
input (caller
suppresses the
section). Used by
gateway-
housekeeping
under the
`### Threshold
alerts (N)`
section.

### `formatHousekeepingReportGhSummary`

Full gateway
housekeeping
dashboard as
Markdown:

```
## Gateway housekeeping

**As of:** `<timestamp>`
[**Tenant:** `<uuid>`]
[**Scope:** all tenants]
**Tables:** N

| Table | Total rows | Oldest | Would prune | Retention |
|-------|-----------:|--------|------------:|-----------|
| `gateway_pipeline_executions` | 50,000 | `2026-04-01T...` | 1,042 | 30d |
| `gateway_idempotency_records` | 1,200  | `2026-05-25T...` | 300   | _TTL-managed_ |
| `rate_limit_decisions`        | 987,654 | `2026-03-15T...` | 9,876 | 7d |

### Threshold alerts (N)
[per-alert table]

[verdict footer]
```

### Verdict
semantic

Three cases:

1. **Alerts not
   evaluated** (no
   `--threshold-
   alert` flag):
   no verdict
   line. The
   housekeeping
   surface
   without
   alerts is a
   query surface,
   not a gate.
   Matches the
   ADR-0308
   gateway routes
   list precedent
   ("query surface
   ≠ gate").
2. **Alerts
   evaluated, none
   tripped**:
   `:white_check_
   mark: **All
   threshold
   alerts
   passed.**`
3. **Alerts
   tripped**:
   `:x: **N
   threshold
   alert(s)
   tripped** —
   exit 3 (CI
   gate failed).`

### `--watch`
incompatibility

`--watch` is
rejected with
`--format gh-
summary` via the
existing
`parseWatchFlags`
format-
validation —
parseWatchFlags
allows only
human|json under
--watch and
emits a clear
error otherwise.
A defensive M4.15.z
check inside
`runGateway
Housekeeping`
was removed
during the
patch because
parseWatchFlags
runs first and
catches the
case with a
broader
message. The
test allows
either error
phrasing for
robustness.

### Per-table
grid columns

| Column | Source | Format |
|---|---|---|
| Table | tableName | backticked identifier |
| Total rows | totalRowCount | `toLocaleString` (`50,000`) |
| Oldest | oldestAt | backticked ISO or `—` |
| Would prune | wouldPruneCount | `toLocaleString` |
| Retention | retentionDays / pruneSemantic | `Nd` for retention-governed, `_TTL-managed_` for idempotency, `—` for unconfigured |

Right-aligned
numeric columns
(Total rows +
Would prune)
via GitHub
Markdown
`|-------:|`
alignment
syntax.

## Rejected
alternatives

1. **Add gh-
   summary under
   --watch mode**
   (per-tick
   streaming
   Markdown) —
   streaming
   per-tick
   Markdown to
   $GITHUB_STEP_
   SUMMARY
   produces
   duplicate
   headers + the
   resulting
   file is
   concat-broken
   (multiple ##
   Gateway
   housekeeping
   sections).
   The CI step
   summary
   contract is
   one-shot.

2. **Emit
   verdict line
   even when
   alerts not
   evaluated**
   ("Run
   `--threshold-
   alert` flags
   to gate this
   surface") —
   would
   confuse
   operators
   running
   housekeeping
   for ad-hoc
   inspection
   (not CI).
   The
   gateway-
   routes-
   list ADR-
   0308 set
   the
   precedent
   for query-
   surface-vs-
   gate
   distinction.

3. **Combine
   the tripped-
   alert
   information
   into the
   per-table
   grid** (e.g.,
   add a "Alert"
   column
   showing
   `:warning:
   tripped`) —
   table gets
   wide; alert
   detail
   (which
   clause +
   actual
   value) is
   the
   actionable
   information,
   not
   "tripped/
   not-
   tripped".
   Separate
   section is
   cleaner.

4. **Use `<details>`
   collapse for
   the per-
   table grid
   when tables
   > 3** —
   only 3
   housekeeping
   tables
   exist;
   future
   surfaces
   with more
   tables
   might
   benefit
   but defer.

5. **Render
   compound
   alerts as
   multiple
   rows in
   the alert
   table
   (one row
   per
   tripped
   clause)
   ** —
   would
   inflate
   the row
   count
   and lose
   the
   alert →
   spec
   mapping.
   `<br>`-
   joined
   cells
   preserve
   1 row
   per
   alert
   while
   showing
   clause
   detail.

6. **Mirror
   the spec
   cell to
   "yes" /
   "no" instead
   of the
   raw
   threshold
   expression**
   — operators
   triaging
   need the
   threshold
   to know
   what
   gated
   the
   trip.
   Spec
   cell
   stays
   raw.

7. **Match
   the
   human-
   format
   alert
   message
   exactly
   ("trips
   threshold
   '<spec>'")**
   — too
   wordy
   for a
   table
   cell.
   Spec
   cell
   shows
   just
   the
   raw
   expression;
   the
   "trips"
   relationship
   is
   implicit
   from
   appearing
   in the
   Threshold
   alerts
   section.

8. **Defer
   the
   threshold-
   alert
   Markdown
   helpers to
   the tenant-
   housekeeping
   gh-summary
   milestone**
   — the
   helpers
   are
   surface-
   agnostic;
   exporting
   them now
   from
   threshold-
   alert.ts
   means the
   tenant
   surface
   can reuse
   them with
   one import
   line when
   it ships.

## Tests added

10 new tests
across 2
describe
blocks:

**`runGateway
housekeeping
--format gh-
summary
(M4.15.z)`** (4
tests):

1. emits
   Markdown with
   ## header +
   As of +
   Tables count
   + per-table
   grid
2. emits
   :white_check_
   mark: verdict
   when alerts
   evaluated +
   none tripped
3. emits :x:
   verdict +
   tripped-
   alerts table
   when alerts
   trip (exit 3)
4. --watch +
   --format gh-
   summary
   rejected
   with
   explanatory
   error (exit
   2)

**`threshold-
alert gh-
summary
helpers
(M4.15.z)`** (6
tests):

5. formatTrippedAlert
   GhSummaryRow
   renders
   single-clause
   alert
   (numeric
   actual +
   no age)
6. formatTrippedAlert
   GhSummaryRow
   renders
   single-clause
   alert with
   ageMs
   (timestamp
   staleness)
7. formatTrippedAlert
   GhSummaryRow
   renders null
   actual as
   `null` _(never
   set)_
8. formatTrippedAlert
   GhSummaryRow
   renders
   compound
   (AND/OR)
   with `<br>`-
   joined cells
9. formatTrippedAlerts
   GhSummaryTable
   returns
   empty string
   on empty
   input
10. formatTripped
    AlertsGhSummary
    Table renders
    header + per-
    alert rows

## Drawbacks

- **`<br>`-
  joined
  compound
  cells render
  inconsistently
  across
  Markdown
  parsers**
  (GitHub
  supports
  it; some
  CLI
  Markdown
  renderers
  strip the
  tag).
  Acceptable
  since
  gh-summary
  targets
  GitHub
  specifically.

- **Right-
  aligned
  numeric
  columns
  require
  GitHub-
  flavored
  Markdown
  alignment
  syntax**
  that
  doesn't
  parse in
  CommonMark.
  Same
  constraint.

- **No
  test for
  --tenant
  filter +
  gh-summary
  composition**
  — covered
  implicitly
  by the
  per-tenant
  drill-
  down
  emitting
  `**Tenant:**`
  in the
  header
  but not
  explicitly
  exercised
  in a
  test.
  Acceptable
  for now.

- **The
  `--watch`
  incompatibility
  error
  comes
  from
  parseWatchFlags'
  generic
  "human|
  json
  only"
  message,
  not a
  gh-
  summary-
  specific
  one** —
  the test
  accepts
  either
  phrasing.
  Future
  cleanup
  could
  add a
  gh-
  summary-
  specific
  preflight
  check.

- **Empty
  alerts-
  evaluated +
  zero-trip
  case
  shows
  bare
  `:white_
  check_
  mark:`
  with
  no
  table** —
  intentional
  (no
  alerts
  tripped
  =
  no
  alerts
  to
  render),
  but
  operators
  expecting
  some
  table
  might
  be
  surprised.

## Future Qs

1. **Tenant
   housekeeping
   --format
   gh-summary**
   — reuses
   the same
   formatTrippedAlertsGh
   SummaryTable
   helper;
   the
   per-tenant
   surface
   has a
   richer
   shape
   (tenant
   metadata
   + per-
   table
   + per-
   tenant
   policy)
   so the
   report
   renderer
   differs.

2. **Add
   `<details>`
   collapse
   for big
   per-table
   grids**
   when
   table
   count
   grows
   beyond
   ~5
   (currently
   3).

3. **Mirror
   the
   per-table
   grid
   columns
   to CSV
   output**
   (housekeeping
   --format
   csv doesn't
   exist yet
   — a
   future
   adjacent
   ADR).

4. **Threshold-
   alert
   summary
   line in
   the
   header**
   ("**Alerts
   evaluated:**
   3 |
   **Tripped:**
   1") for
   at-a-glance
   verdict
   visibility
   before
   scrolling
   to the
   table.

5. **Drill-
   down
   link to
   the
   tripped-
   alert
   GitHub
   workflow
   command**
   (`::error
   ::title
   ...`)
   for
   inline
   PR
   markers.
