# ADR-0308: `gateway routes list --format csv|tsv|csv-full|gh-summary`

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0307 (M4.15.t sessions list pivot), ADR-0303 (M4.15.p --no-header), ADR-0304 (M4.15.q --columns) |

## Context

The M4.15.t pivot
extended the
output-format
polish (csv +
csv-full +
gh-summary +
--no-header +
--columns +
--csv-separator)
from the tenants/
policies/retention
diff family to
`sessions list`.

`gateway routes
list` was the next
obvious gap: a
list-style surface
backed by Postgres
RouteRegistry that
emitted only json
+ human. Operators
auditing the API
surface ("which
routes are
deprecated /
under sunset /
came from which
pack?") had to
pipe json through
jq.

## Decision

Add 4 new output
formats to
`gateway routes
list`:

1. **csv / tsv**
   (7 cols):
   route_id,
   method, path,
   version,
   operation,
   scopes,
   deprecated.
   Matches
   formatRoutesTable
   columns. Path
   rendered via
   formatPath
   (e.g.,
   `/v1/tenants/
   :tenant_id`).
2. **csv-full**
   (15 cols):
   all
   RouteDefinition
   fields
   including
   operation_id,
   deprecated_
   since,
   sunset_at,
   successor_
   operation_id,
   required_scopes,
   rate_limit_
   policy_id,
   idempotency_
   required,
   request +
   response
   SHA-256s,
   source_pack.
3. **gh-summary**:
   `## Gateway
   routes` header
   + 4-metric
   summary line
   (Routes /
   Deprecated /
   Sunset
   scheduled /
   From packs) +
   per-route
   Markdown
   table. Sunset-
   scheduled
   routes get a
   `:warning:
   sunset
   <timestamp>`
   marker in
   the
   Deprecated
   column for
   at-a-glance
   visibility.

### Scopes
joining

`required_scopes`
is joined with
`;` (semicolon),
not `,`. This
keeps the cell
parseable in
pandas under the
default comma
separator
without
RFC-4180 quote-
escape overhead.
The tenants list
csv-full
residency
column uses
JSON.stringify
which RFC-4180-
escapes; scopes
are simpler
because they're
already
identifiers
(no embedded
commas in
practice).

### gh-summary
intentionally
non-gating

The gh-summary
verdict slot is
empty — no
`:white_check_
mark:` /
`:warning:`
based on
deprecated /
sunset counts.
Routes list is
a query
surface, not a
gate. Operators
wanting a gate
("fail CI if
deprecated >
N") should
filter the
output and
exit-on-count
separately.

The per-route
sunset emoji
(`:warning:
sunset
<timestamp>`)
is informational
visibility, not
a gate verdict.

### Composition

Same as M4.15.t
sessions list:

- `--no-header`
  (M4.15.p) →
  skip header
  row
- `--columns
  col1,col2,...`
  (M4.15.q) →
  subset +
  reorder (with
  unknown-
  column
  validation
  showing the
  full
  format-
  specific
  column list)
- `--csv-
  separator <c>`
  → reject `"`
  + newlines

### Empty-state

- csv/tsv/csv-
  full: header-
  only output
  (no human
  "no routes
  registered"
  message;
  matches the
  M4.15.t
  convention).
- gh-summary:
  `## Gateway
  routes` +
  `_No routes
  registered._`
  italic
  marker.
- human:
  preserves
  existing
  "no routes
  registered."
  message.

## Rejected
alternatives

1. **Add
   csv/gh-
   summary to
   `gateway
   routes
   register` +
   `gateway
   routes
   unregister`**
   — these
   are
   single-
   action
   commands;
   no
   tabular
   shape.
   They
   already
   emit
   json or
   human
   success
   messages.
   Out of
   scope.

2. **Include
   path_
   segments
   as a
   JSON
   column
   in csv-
   full
   instead
   of the
   rendered
   path
   string**
   — the
   rendered
   `formatPath
   (r)`
   form is
   what
   operators
   actually
   want
   for
   audit
   exports.
   Raw
   segments
   are
   already
   in
   --format
   json.

3. **Join
   scopes
   with
   pipe (`|`)
   instead
   of
   semicolon**
   — pipe
   is a
   common
   custom
   separator
   choice
   for
   `--csv-
   separator
   |`.
   Semicolons
   keep
   the
   nested-
   delimiter
   convention
   universal.

4. **Add
   per-method
   summary
   to gh-
   summary
   ("GET:
   5, POST:
   3, PUT:
   2")** —
   useful but
   defer.
   The 4-
   metric
   summary
   already
   covers
   the
   common
   audit
   needs.

5. **Surface
   sunset
   urgency
   as
   "sunset
   in N days"
   relative
   time** —
   requires
   knowing
   "today"
   from
   context;
   timestamps
   are
   absolute +
   easier to
   audit. Defer.

6. **Group
   gh-
   summary
   routes
   by
   sourcePack
   as
   `<details>`
   blocks**
   — useful
   for big
   route
   tables
   but
   adds
   complexity.
   Defer.

7. **Add
   verdict
   emoji
   to
   gh-
   summary
   ("⚠️
   N
   deprecated
   routes
   detected")
   ** —
   converts
   query
   surface
   into
   pseudo-
   gate.
   Operators
   wanting
   a gate
   should
   pipe
   filtered
   output
   to
   their
   own
   exit-
   on-
   count
   logic.

## Drawbacks

- **Empty-
  state
  behavior
  inconsistent
  with
  human
  "no
  routes
  registered."
  text vs
  csv
  header-
  only** —
  matches
  M4.15.t
  precedent.

- **gh-
  summary
  Deprecated
  column
  has 3
  states
  (no /
  :warning:
  yes /
  :warning:
  sunset
  <ts>)**
  rather
  than 2.
  Pure
  yes/no
  would be
  shorter
  but
  hides
  the
  sunset
  timestamp
  (which
  is the
  actionable
  detail
  for
  operators
  triaging
  pre-
  sunset
  routes).

- **csv-full
  has 15
  cols**
  — widest
  CSV in
  the CLI.
  Acceptable
  for
  spreadsheet
  + pandas;
  CSV
  parsers
  handle it.

- **No
  per-pack
  filter
  flag**
  — operators
  wanting
  "routes
  from
  retail-
  fnb"
  pipe
  `--format
  csv |
  grep
  ',retail-
  fnb$'`.
  A
  `--from-
  pack
  <slug>`
  could
  come
  later.

## Future Qs

1. **`--from-
   pack
   <slug>`
   filter**
   for
   per-
   pack
   audits.

2. **`--include-
   pack-
   stats`
   subhead
   in
   gh-
   summary**
   showing
   "From
   pack
   retail-
   fnb: 5
   routes
   (2
   deprecated)".

3. **`--sort
   path |
   method
   |
   version`**
   for
   custom
   ordering
   (currently
   registry
   order).

4. **`--depcrecated-
   only`**
   filter
   for
   deprecation-
   audit
   workflows.

5. **`gateway
   routes
   show
   <rt_id>
   --format
   csv-
   full`**
   single-
   row
   variant
   matching
   M4.15.j
   precedent.

6. **Output
   pack-
   registry
   sync
   diff
   as
   gh-
   summary**
   when
   `gateway
   routes
   register-
   pack`
   ships
   a
   diff.
