# ADR-0323: Per-tenant slug round-trip in JSON envelopes (M4.15.aj)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-06-01 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0322 (M4.15.ai slug round-trip in gh-summary headers), ADR-0273 (M4.14.o tenant slug resolution via meta.tenants), ADR-0314 (M4.15.aa tenant housekeeping gh-summary baseline), ADR-0320 (M4.15.ag retention list-policies gh-summary baseline) |

## Context

ADR-0322
(M4.15.ai) shipped
slug round-trip
in gh-summary
Markdown headers
for two surfaces
— tenant
housekeeping +
retention list-
policies.
Operators typing
`--tenant acme-
prod` saw
`acme-prod`
echoed back in
their CI step
summaries
alongside the
resolved UUID.

But the
corresponding
JSON envelopes
still echoed
back ONLY the
resolved UUID:

```json
{
  "action": "tenant.housekeeping",
  "tenantId": "00000000-0000-4000-8000-...",
  ...
}
```

Programmatic
consumers
parsing JSON
for audit-trail
purposes — CI
analytics
dashboards,
compliance
reporting,
incident-
response
playback —
had no
record of
which slug
the operator
typed.
Re-resolving
slugs against
`meta.tenants`
at the
consumer
layer
duplicated
work the
substrate
already
did, and
broke down
when the
operator's
slug
mapping
had since
changed
(tenant
renamed,
acquired,
etc.).

ADR-0322
future Q3
explicitly
deferred
"surface
slug in
JSON
envelope":

> 3. **Surface
>    slug in
>    JSON
>    envelope:**
>    add
>    `tenantSlug?:
>    string`
>    field to
>    the gh-
>    summary-
>    adjacent
>    JSON
>    envelope
>    shape so
>    programmatic
>    consumers
>    parsing
>    JSON for
>    audit-
>    trail
>    purposes
>    don't
>    need to
>    re-resolve
>    slugs.

This
milestone
closes Q3
for the
two
surfaces
that
already
got
gh-summary
slug
round-trip
in M4.15.ai.

## Decision

Surface the
operator's
original
`--tenant`
input as
`tenantSlug`
in JSON
envelopes
when it
differs
from the
resolved
UUID
(i.e.,
input was
a slug).
UUID
input
omits
the field
entirely
(backward-
compatible
with
pre-M4.15.aj
envelope
shape).

### tenant housekeeping JSON envelope

`runTenantHousekeeping`
in `tenant.ts`
emits the
`tenant.housekeeping`
envelope from
TWO sites
(watch tick
NDJSON line +
single tick
printJson). Both
gain
`...(tenantSlug
!== undefined ?
{ tenantSlug }
: {})` spread
positioned
right after
the existing
`...(tenantId
!== undefined
? { tenantId }
: {})`
spread.

Pattern: when
tenantSlug is
undefined
(UUID input
OR no
--tenant
flag), the
spread emits
nothing and
the field
is absent
from the
envelope.
When
defined
(slug
input), the
field is
present
with the
operator's
raw input.

The shared
`tenantSlug`
variable is
computed
once at
the
dispatcher
level
right
after the
slug
resolution
step:

```typescript
const tenantSlug =
  tenantFlag !== null && tenantFlag !== tenantId
    ? tenantFlag
    : undefined;
```

This same
variable
is also
passed
into the
gh-summary
renderer
(replacing
the
M4.15.ai
inline
ternary
for
consistency).

### retention list-policies JSON+YAML envelope

`runRetentionListPolicies`
in `retention.ts`
emits the
list-policies
envelope via
`printStructured`
(handles json +
yaml). The
existing
shape:

```typescript
printStructured(ctx.io, command.format, {
  tenantFilter: tenantFilter ?? null,
  tableFilter: tableFilter ?? null,
  platform: filteredPlatform,
  tenantPolicies: filteredTenant,
});
```

Gains
`...(tenantSlug
!== undefined ?
{ tenantSlug }
: {})` spread
between
`tenantFilter`
and
`tableFilter`
— positioned
adjacent to
`tenantFilter`
since they're
the matched
pair (resolved
UUID + raw
slug).

The shared
`tenantSlug`
variable is
computed once
near the
resolver
output:

```typescript
const tenantSlug =
  tenantRaw !== null && tenantRaw !== tenantFilter
    ? tenantRaw
    : undefined;
```

This same
variable is
also passed
into the gh-
summary
renderer
(replacing
the M4.15.ai
inline
ternary for
consistency).

### Why conditional-emit not always-null

Two patterns
exist in the
codebase for
optional
envelope
fields:

1. **Conditional
   spread**
   (e.g.,
   `tenantId`
   in tenant
   housekeeping):
   `...(value
   !== undefined
   ? { field }
   : {})` —
   field absent
   when not
   applicable.

2. **Always-
   present null**
   (e.g.,
   `tenantFilter`
   in retention
   list-policies):
   `field: value
   ?? null` —
   field always
   present, null
   when not
   applicable.

For
backward
compatibility,
adding a
NEW field
should
preserve
the
existing
shape
exactly
for
callers
who don't
trigger
the new
code
path
(operators
passing
UUIDs).
Conditional-
emit
achieves
this:
UUID-input
callers
see the
EXACT
SAME
envelope
shape as
before
M4.15.aj.

Always-
null
would
add a
new
always-
present
field
which
some
strict-
shape
consumers
(operators
using
TypeScript
generated
clients
with
strict
JSON
parsing)
might
reject.

Conditional-
emit is
chosen
for both
surfaces
regardless
of their
pre-
existing
field
convention
(tenant
housekeeping
uses
conditional
spread
for
`tenantId`,
retention
list-
policies
uses
always-
null
for
`tenantFilter`)
— the
new
`tenantSlug`
field
uses
conditional
spread
in
BOTH.
This
trades
intra-
surface
consistency
for
cross-
surface
consistency
on the
slug-
round-
trip
behavior.

### Scope: only the 2 surfaces that got gh-summary slug round-trip

This milestone
mirrors M4.15.ai's
scope exactly:
the two surfaces
that already
have gh-summary
slug round-trip
(tenant
housekeeping +
retention
list-policies).
Other
`--tenant`-
accepting
surfaces
(retention
history,
retention
summary,
gateway
housekeeping,
retention
housekeeping)
have JSON
envelopes
echoing
`tenantFilter` /
`tenantId` but
don't have
gh-summary
slug round-
trip yet — they
should get
BOTH treatments
together in a
future
milestone, not
JSON-only.

## Tests added

5 new tests in
the new
"tenant
housekeeping
JSON envelope
slug round-
trip (M4.15.aj)"
describe block
in
`tenant.test.ts`:

1. **--tenant
   <slug>
   --format
   json emits
   tenantSlug
   field
   alongside
   tenantId:**
   verifies
   both
   `env.tenantId`
   = resolved
   UUID +
   `env.tenantSlug`
   = "acme-prod".

2. **--tenant
   <uuid>
   --format
   json omits
   tenantSlug
   (backward
   compat with
   M4.15.aa):**
   verifies
   `env.tenantId`
   present +
   `"tenantSlug"
   in env` ===
   false.

3. **--all-
   tenants
   --format
   json omits
   tenantSlug:**
   no slug
   resolution
   happened,
   `tenantId`
   absent
   too.

4. **No
   --tenant
   flag
   --format
   json
   omits
   both
   tenantId
   AND
   tenantSlug:**
   default
   no-filter
   path
   preserved.

5. **--watch
   + --tenant
   <slug>
   --format
   json
   streams
   NDJSON
   with
   tenantSlug
   per tick:**
   verifies
   each line
   in the
   NDJSON
   output
   carries
   tenantSlug
   = "acme-
   prod"
   across all
   ticks (the
   watch path
   has its
   own JSON
   emit site
   distinct
   from
   single-
   tick).

5 new tests in
the new
"retention
list-policies
JSON envelope
slug round-
trip (M4.15.aj)"
describe block
in
`retention.test.ts`:

1. **--tenant
   <slug>
   --format
   json emits
   tenantSlug
   alongside
   tenantFilter:**
   verifies
   `env.tenantFilter`
   = resolved
   UUID +
   `env.tenantSlug`
   = "acme-prod".

2. **--tenant
   <uuid>
   --format
   json omits
   tenantSlug
   (backward
   compat with
   M4.15.ag):**
   verifies
   `env.tenantFilter`
   present +
   `"tenantSlug"
   in env` ===
   false.

3. **No
   --tenant
   flag
   --format
   json
   omits
   tenantSlug:**
   `tenantFilter:
   null`
   preserved
   from
   M4.15.ag
   shape.

4. **--tenant
   <slug>
   --format
   yaml emits
   tenantSlug
   in YAML
   envelope:**
   verifies
   the field
   surfaces
   through
   printStructured's
   YAML emit
   path (not
   just JSON).

5. **--tenant
   <slug>
   composes
   with
   --table
   filter —
   both
   surface
   correctly
   in JSON:**
   verifies
   tenantFilter
   +
   tenantSlug
   +
   tableFilter
   all
   present
   together.

## Coverage impact

tenant.ts +
retention.ts
stay above
80%
statements
threshold;
new
conditional-
spread
branches in
both JSON
envelope
sites are
exercised by
the
integration
tests.

## Rejected alternatives

1. **Always-
   present
   `tenantSlug:
   tenantSlug
   ?? null`
   field:**
   would
   change
   envelope
   shape for
   UUID-input
   callers
   (new
   always-
   present
   field
   where
   there was
   none).
   Conditional
   spread
   preserves
   the pre-
   M4.15.aj
   envelope
   shape
   exactly
   for UUID
   callers,
   which is
   the
   backward-
   compat
   priority.

2. **Match
   retention
   list-
   policies'
   "always-
   null"
   convention
   for
   tenantSlug
   too:**
   would
   match the
   surface's
   existing
   `tenantFilter:
   tenantFilter
   ?? null`
   pattern,
   but at
   the cost
   of
   surfacing
   a new
   always-
   present
   field in
   the
   envelope.
   Conditional
   spread
   is cross-
   surface
   consistent
   on the
   slug-
   round-
   trip
   behavior
   (both
   surfaces
   use it),
   trading
   intra-
   surface
   convention
   for
   cross-
   surface
   consistency
   on the
   new
   field.

3. **Apply
   pattern
   to
   retention
   history /
   summary /
   housekeeping
   surfaces
   in this
   milestone:**
   those
   surfaces
   accept
   `--tenant`
   and emit
   `tenantFilter`
   / `tenantId`
   in JSON
   too, but
   they
   don't
   have
   gh-summary
   slug
   round-
   trip yet
   (no
   gh-summary
   surface
   on
   retention
   history /
   summary;
   gateway
   /
   retention
   housekeeping
   gh-summary
   from
   M4.15.z/
   M4.15.aa
   didn't
   get
   slug
   round-
   trip in
   M4.15.ai).
   Adding
   JSON
   slug
   round-
   trip
   without
   matching
   gh-summary
   slug
   round-
   trip
   would
   create
   asymmetry
   in the
   audit-
   trail
   story
   (operators
   would
   wonder
   "why
   JSON
   only?").
   Deferred
   to a
   future
   milestone
   covering
   both
   gh-summary
   AND JSON
   together.

4. **Use a
   nested
   shape
   like
   `tenantInput:
   { id:
   <uuid>,
   slug:
   <slug> }`:**
   would
   group
   the two
   values
   semantically
   but
   break
   backward
   compat
   with
   existing
   `tenantId`
   /
   `tenantFilter`
   field
   names.
   Adding
   `tenantSlug`
   alongside
   the
   existing
   field
   is
   non-
   breaking.

5. **Surface
   slug as
   a
   metadata
   sub-
   object
   like
   `{ filter:
   { tenantId,
   tenantSlug
   } }`:**
   would
   require
   restructuring
   the
   envelope
   shape
   for both
   surfaces.
   The flat
   field is
   simpler
   and
   preserves
   existing
   shape.

6. **Don't
   share
   the
   `tenantSlug`
   variable
   between
   JSON
   envelope
   +
   gh-summary
   call
   site
   (M4.15.ai
   used
   inline
   ternary
   at the
   gh-summary
   call):**
   would
   duplicate
   the
   condition
   in two
   places.
   Computing
   once at
   the
   dispatcher
   level
   and
   reusing
   in
   both
   JSON
   emit
   sites
   +
   gh-summary
   renderer
   is
   cleaner
   and
   harder
   to
   drift.

7. **Always
   emit
   slug
   even
   for
   UUID
   input
   if
   `meta.tenants`
   has a
   matching
   slug
   (reverse
   resolution):**
   would
   require
   an
   extra
   query
   per
   call —
   deferred
   to
   future
   Q
   (closes
   ADR-
   0322
   Q2 in
   the
   same
   future
   milestone).

## Drawbacks

- **Conditional
  spread
  cross-
  surface
  but
  diverges
  from
  retention
  list-
  policies'
  intra-
  surface
  convention:**
  retention
  list-
  policies
  uses
  `tenantFilter:
  tenantFilter
  ?? null`
  but
  `tenantSlug`
  uses
  conditional
  spread.
  Operators
  reading
  both
  fields
  in JSON
  might
  wonder
  why
  the
  patterns
  differ.
  Mitigated
  by
  documentation
  (this
  ADR
  +
  ADR-0322)
  and
  the
  fact
  that
  cross-
  surface
  consistency
  on
  the
  new
  field
  is
  more
  valuable
  than
  intra-
  surface
  convention
  for
  audit-
  trail
  workflows
  that
  span
  both
  surfaces.

- **No
  envelope-
  shape
  versioning:**
  consumers
  using
  strict
  JSON
  schema
  validation
  (e.g.,
  generated
  TypeScript
  clients
  with
  exact-
  shape
  matching)
  may
  fail
  on
  the
  new
  field
  appearing
  in
  slug-
  input
  paths.
  Adding
  an
  envelope
  shape
  version
  field
  is
  overkill
  for
  a
  single
  field
  addition;
  operators
  using
  strict
  validators
  should
  regenerate
  their
  client
  code
  from
  updated
  schemas.

- **No
  YAML-
  specific
  test
  beyond
  the
  one
  retention
  list-
  policies
  YAML
  test:**
  the
  same
  printStructured
  helper
  serves
  both
  json
  +
  yaml,
  so
  the
  json
  test
  covers
  the
  envelope
  shape
  and
  the
  yaml
  test
  verifies
  the
  field
  surfaces
  through
  the
  YAML
  emit
  path.
  No
  separate
  YAML
  test
  for
  tenant
  housekeeping
  since
  the
  envelope
  shape
  is
  identical
  between
  json
  +
  yaml
  emits.

- **Other
  --tenant-
  accepting
  surfaces
  inconsistent
  with
  this
  milestone's
  pattern:**
  retention
  history,
  retention
  summary,
  gateway
  housekeeping,
  retention
  housekeeping
  still
  echo
  back
  ONLY
  the
  resolved
  UUID
  in
  their
  JSON
  envelopes.
  Operators
  using
  those
  surfaces
  for
  audit
  trails
  still
  need
  to
  re-resolve
  slugs.
  Documented
  as
  future
  Q4 +
  Q5 +
  Q6.

- **No
  reverse
  resolution
  for
  UUID
  input:**
  operators
  passing
  `--tenant
  <uuid>`
  still
  see
  no
  slug
  in
  JSON
  even
  if
  `meta.tenants`
  has
  one
  for
  that
  UUID.
  The
  round-
  trip
  is
  one-
  way
  (slug-
  input
  preserved)
  not
  bidirectional.
  Documented
  as
  future
  Q1
  (mirrors
  ADR-
  0322
  future
  Q2).

## Future Qs

1. **Reverse
   slug
   resolution
   for
   UUID
   input:**
   operators
   passing
   `--tenant
   <uuid>`
   see no
   slug
   in
   either
   gh-
   summary
   OR
   JSON
   even
   if
   `meta.tenants`
   has
   one
   for
   that
   UUID.
   Adding
   reverse
   resolution
   would
   require
   one
   extra
   SELECT
   query
   per
   call —
   pairs
   with
   ADR-
   0322
   future
   Q2
   for
   bidirectional
   slug
   round-
   trip
   across
   both
   gh-
   summary
   AND
   JSON
   in
   one
   milestone.

2. **Apply
   pattern
   to
   diff/
   diff-
   history/
   diff-
   timeline
   gh-
   summary
   +
   JSON
   envelopes:**
   pairs
   with
   ADR-
   0322
   future
   Q1
   for
   per-
   side
   slug
   threading
   across
   `anchorSide`
   +
   `rhsSides`
   shapes.
   Both
   gh-
   summary
   AND
   JSON
   should
   ship
   together
   for
   audit-
   trail
   consistency.

3. **Apply
   pattern
   to
   retention
   history /
   summary
   gh-
   summary
   (when
   those
   surfaces
   ship)
   +
   JSON
   envelopes:**
   currently
   retention
   history +
   summary
   accept
   `--tenant`
   but
   don't
   have
   gh-summary
   surfaces.
   When
   they
   do, the
   slug
   round-
   trip
   pattern
   should
   apply
   to
   both
   gh-
   summary
   AND
   JSON
   in
   one
   milestone.

4. **Apply
   pattern
   to
   gateway
   housekeeping
   +
   retention
   housekeeping
   (separate
   dashboards)
   JSON
   envelopes:**
   those
   surfaces
   already
   have
   gh-summary
   surfaces
   (M4.15.z,
   M4.15.aa)
   that
   could
   get
   slug
   round-
   trip,
   and
   JSON
   envelopes
   echoing
   `tenantId`.
   Mirrors
   the
   cross-
   dashboard
   pattern
   from
   M4.15.ai
   /
   M4.15.aj.

5. **Apply
   pattern
   to
   tenants
   list +
   tenants
   get +
   tenants
   resolve
   JSON
   envelopes:**
   the
   `tenants`
   subcommand
   (ADR-
   0277)
   doesn't
   currently
   have
   `--tenant
   <slug>`
   semantics
   (it
   IS the
   slug
   listing
   surface),
   but
   if
   `tenants
   get
   <slug>`
   gained
   tenantId
   echo,
   it
   would
   benefit
   from
   the
   same
   pattern.

6. **Envelope
   shape
   versioning:**
   add
   `envelopeVersion:
   1` to
   all
   JSON
   envelopes
   to
   allow
   future
   schema
   migrations
   to
   bump
   the
   version.
   Defer
   until
   demand
   emerges.
