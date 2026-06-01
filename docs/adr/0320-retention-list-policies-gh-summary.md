# ADR-0320: `retention list-policies --format gh-summary` (M4.15.ag)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0319 (M4.15.af retention prune gh-summary), ADR-0311 (M4.15.x gateway prune-idempotency gh-summary), ADR-0313 (M4.15.z gateway housekeeping gh-summary) |

## Context

ADR-0319's future
Q2 flagged
`retention list-
policies --format
gh-summary` as a
natural follow-up
to the retention-
prune gh-summary
work. The list-
policies surface
provides a policy-
inventory snapshot
(platform defaults
+ per-tenant
overrides) that
operators auditing
retention
configuration in
CI want as a
Markdown report.

Before M4.15.ag,
`retention list-
policies` emitted
only json/yaml/
human. CI step
summary
redirection
required jq +
custom Markdown
synthesis.

## Decision

Add `--format
gh-summary` to
`runRetention
ListPolicies`.
New exported
helper
`formatPolicies
ListGhSummary`
renders a two-
section
Markdown
report:

```
## Retention policies

[**Filtered:** tenant=`<uuid>` | table=`<name>`]
**Platform defaults:** N | **Per-tenant overrides:** M

### Platform defaults
| Table | Retention | Enabled | Last pruned |
|-------|----------:|---------|-------------|
| `workflow_traces` | 90d | yes | `2026-05-20T00:00:00.000Z` |

### Per-tenant overrides
| Tenant | Table | Retention | Enabled | Opt-out |
|--------|-------|----------:|---------|---------|
| `<uuid>` | `workflow_traces` | 365d | yes | yes _(until 2026-12-31T23:59:59.000Z; reason: compliance-hold)_ |
```

### Empty-state
markers

Each section
gets its own
italic empty-
state marker
when no rows
present:

- Platform:
  `_No
  platform
  defaults
  configured._`
- Per-tenant:
  `_No per-
  tenant
  overrides
  configured._`

When both
empty (no
policies
anywhere)
both markers
appear. No
verdict —
list-policies
is a query
surface not
a gate
(matches
ADR-0308
gateway
routes
list +
ADR-0319
prune
"no
policies"
empty
state).

### Filter
echo

When
`--tenant`
and/or
`--table`
are set,
emit a
`**Filtered:**`
metadata
line with
the
filter
values
backticked
for audit
reproducibility.
Sections
shown
below
display
the
FILTERED
counts +
rows.

Filter
parts
joined
with
` | `
(matches
sessions
list cost-
summary +
gateway
housekeeping
metadata
separator
convention).

Conditional
rendering:

- Neither
  filter
  set:
  metadata
  line
  omitted
  entirely
  (keeps
  the
  header
  tight
  for the
  common
  unfiltered
  case).
- Only
  one
  filter:
  only
  that
  part
  shows
  (`tenant=
  <uuid>`
  or
  `table=
  <name>`).

### Per-tenant
opt-out
cell

The
TenantRetention
PolicyRow's
`optOut`
boolean +
`optOutReason`
/
`optOutUntil`
nullable
fields
collapse
into a
single
Opt-out
column:

- `optOut
  ===
  false`:
  cell
  shows
  `no`.
- `optOut
  ===
  true`:
  cell
  shows
  `yes
  _(until
  <iso-or-
  "indefinite">;
  reason:
  <text-
  or-
  "<no
  reason>">)_`
  with
  italic
  detail.

Null
optOutUntil
falls
back to
"indefinite"
literal;
null
optOutReason
to
"<no
reason>"
literal —
matches
the
human-
format
formatTenantOptOutSummary
helper
(consistency
across
format
branches).

### Last-
pruned
cell

Platform
defaults
last-
pruned
column
uses
backticked
ISO
timestamp
when set,
`_never_`
italic
marker
when
null
(distinguishes
"never
pruned"
from "no
data"
visually).

### No
verdict

Identical
semantic
to
gateway
routes
list
(ADR-
0308)
and
retention
prune's
empty-
results
case
(ADR-
0319):
list-
policies
is a
query
surface
not a
gate.
Operators
wanting
to gate
on
policy
existence
should
pipe
json +
exit-on-
count
themselves.

## Tests added

9 new
tests
across 2
describe
blocks:

**`runRetention
list-policies
--format
gh-summary
(M4.15.ag)`**
(3
tests):

1. Empty
   policies
   (both
   sections)
   emits
   counts +
   empty-
   state
   markers
   without
   filter
   echo
   line.
2. Both
   sections
   populated
   emits
   per-row
   platform
   + per-
   tenant
   tables.
3. --tenant
   +
   --table
   filters
   echoed
   in
   metadata
   line.

**`formatPolicies
ListGhSummary
(M4.15.ag)`**
(6
direct
unit
tests):

4. Opt-
   out
   cell
   shows
   `yes`
   with
   until +
   reason
   when
   set.
5. Opt-
   out
   cell
   shows
   "indefinite"
   + "<no
   reason>"
   fallbacks
   when
   nulls.
6. Opt-
   out
   cell
   shows
   `no`
   when
   optOut=
   false.
7. Filter
   echo
   shows
   only
   tenant
   when
   only
   --tenant
   set.
8. Filter
   echo
   shows
   only
   table
   when
   only
   --table
   set.
9. Both
   sections
   empty:
   markers
   appear,
   no
   verdict
   emoji.

## Rejected
alternatives

1. **Combine
   both
   sections
   into a
   single
   unified
   table
   with a
   "Source"
   column
   (platform
   vs
   tenant-
   override)**
   — would
   duplicate
   the
   Last-
   pruned /
   Opt-out
   asymmetry
   (platform
   has Last
   pruned;
   tenant
   has
   Opt-out)
   into
   one
   wide
   table.
   Two-
   section
   layout
   matches
   the
   human-
   format
   structure +
   keeps
   each
   column
   set
   tight.

2. **Add a
   verdict
   when
   per-
   tenant
   overrides
   ==
   0** (
   "no
   tenant
   has
   customized
   retention")
   — confuses
   query-
   surface
   semantics
   with
   gate
   semantics.
   Operators
   wanting
   to gate
   should
   filter
   the
   JSON.

3. **Use
   `:warning:`
   for
   disabled
   platform
   defaults**
   — disabled
   isn't a
   problem,
   it's a
   configuration
   choice
   (operators
   may
   intentionally
   disable
   pruning
   for
   compliance
   holds).

4. **Render
   the
   last-
   pruned
   cell
   as
   "5
   days
   ago"
   relative
   time** —
   requires
   knowing
   "now"
   from
   context;
   ISO
   timestamp
   is
   absolute +
   audit-
   friendly.

5. **Add
   a
   per-
   tenant
   group-
   by
   summary
   row**
   ("3
   tenants
   with
   overrides
   on 5
   tables")
   — defer
   to
   future
   Q
   (same
   pattern
   as
   ADR-
   0319
   future
   Q1).

6. **Match
   human-
   format
   message
   exactly
   ("Platform
   defaults
   (N
   total):")**
   — too
   wordy
   for
   gh-
   summary
   section
   header.
   Distilled
   to
   `###
   Platform
   defaults`
   +
   metadata
   line.

7. **Skip
   the
   `**Filtered:**`
   line
   when
   no
   filter
   set** —
   actually
   we DO
   skip
   it
   (conditional
   rendering)
   for
   the
   common
   unfiltered
   case;
   this
   describes
   the
   accepted
   design.

## Drawbacks

- **Per-
  tenant
  table
  width**
  scales
  with
  tenant
  count
  +
  opt-out
  detail
  length
  (an
  opt-out
  with
  long
  reason
  text
  fills
  the
  cell).
  Acceptable
  for
  CI step
  summary.

- **Tenant
  UUIDs
  are
  36
  chars**
  per
  row;
  no
  slug
  resolution
  yet
  (deferred
  to
  ADR-
  0320
  future
  Q3).

- **Opt-
  out
  cell
  combines
  3
  fields**
  into
  one;
  operators
  filtering
  by
  reason
  via
  grep
  need
  the
  italic
  detail
  intact.

- **No
  group-
  by
  summary**
  for
  "N
  tenants
  with
  overrides"
  — defer.

## Future Qs

1. **Per-
   tenant
   group-
   by
   summary
   row**
   ("3
   tenants
   with
   overrides
   spanning
   5
   tables")
   for
   aggregate
   visibility.

2. **Sort
   options**
   for
   per-
   tenant
   table
   (currently
   gather
   order;
   operators
   wanting
   sorted-
   by-
   tenantId
   or
   sorted-
   by-
   tableName
   pipe
   through
   their
   own
   sorter).

3. **--tenant-
   slug
   resolution
   in
   per-
   tenant
   table**
   echoing
   `<uuid>
   (slug)`
   when
   the
   slug
   resolution
   is
   available
   (mirrors
   ADR-
   0314
   future
   Q4
   for
   tenant
   housekeeping).

4. **Add
   `retention
   summary
   --format
   gh-
   summary`**
   for the
   aggregate-
   over-
   time
   summary
   surface
   (the
   per-
   tick
   /
   per-
   day
   pattern).

5. **Per-
   tenant
   policy-
   diff
   inline**
   highlighting
   how a
   tenant's
   override
   differs
   from
   the
   platform
   default
   (would
   require
   a join
   query
   that
   list-
   policies
   doesn't
   currently
   issue).
