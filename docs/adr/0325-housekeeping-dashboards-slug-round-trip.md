# ADR-0325: Slug round-trip on per-dashboard housekeeping surfaces (M4.15.al)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-06-01 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0322 (M4.15.ai gh-summary slug round-trip), ADR-0323 (M4.15.aj JSON envelope slug round-trip), ADR-0324 (M4.15.ak reverse slug lookup), ADR-0273 (M4.14.o tenant slug resolution), ADR-0269/0270 (M4.14.u/v --tenant on per-dashboard surfaces), ADR-0313 (M4.15.z gateway housekeeping gh-summary) |

## Context

M4.15.ai/aj/ak
shipped the
slug round-
trip story
end-to-end
for TWO
surfaces:

- **tenant
  housekeeping**
  (cross-
  dashboard
  view) —
  gh-summary
  header,
  JSON
  envelope,
  forward
  AND
  reverse
  slug
  lookup.
- **retention
  list-policies**
  — gh-
  summary
  header,
  JSON
  envelope,
  forward
  AND
  reverse
  slug
  lookup.

But the
per-dashboard
surfaces
(gateway
housekeeping
+ retention
housekeeping
separate
dashboards)
still echoed
back ONLY
the resolved
UUID in
their JSON
envelopes,
and gateway
housekeeping's
gh-summary
header
similarly
showed only
the UUID.
ADR-0323
future Q4 +
ADR-0324
future Q3
explicitly
flagged this
gap:

> 4.
>    **Apply
>    pattern
>    to
>    gateway
>    housekeeping
>    +
>    retention
>    housekeeping
>    (separate
>    dashboards)
>    JSON
>    envelopes:**
>    those
>    surfaces
>    already
>    have
>    gh-summary
>    surfaces
>    [for
>    gateway]
>    that
>    could
>    get
>    slug
>    round-
>    trip,
>    and
>    JSON
>    envelopes
>    echoing
>    `tenantId`.

This milestone
closes that
gap on
BOTH
per-dashboard
surfaces in
one focused
milestone,
mirroring
the
M4.15.ai/aj/ak
pattern from
the cross-
dashboard
view down
to the
per-dashboard
views.

### Surface inventory

Surface
shapes
involved:

| Surface | gh-summary? | JSON envelope? | --tenant slug accepted? |
|---|---|---|---|
| gateway housekeeping | YES (M4.15.z) | YES | YES (M4.14.o) |
| retention housekeeping | NO | YES | YES (M4.14.o) |

So
gateway
housekeeping
gets
slug
round-
trip in
BOTH
output
formats;
retention
housekeeping
gets
slug
round-
trip in
the
JSON
envelope
only (no
gh-
summary
surface
exists
yet on
that
dashboard
— adding
one is
out
of
scope
here).

## Decision

Extend the
`HousekeepingReport`
(gateway)
and
`RetentionHousekeepingReport`
(retention)
interface
shapes
with an
optional
`tenantSlug?:
string`
field.
Thread
operator-
typed slug
preservation
+ reverse-
lookup
canonical
slug
through
the
existing
gather-
input
sequence
so the
report
carries
the slug
to all
downstream
sinks
unchanged.

### Type extensions

`HousekeepingReport`
(gateway):

```typescript
export interface HousekeepingReport {
  readonly asOf: string;
  readonly tables: ReadonlyArray<HousekeepingTableReport>;
  readonly tenantId?: string;
  // M4.15.al — operator's slug or reverse-lookup match
  readonly tenantSlug?: string;
  readonly allTenants?: true;
}

export interface GatherHousekeepingInput {
  // ...
  readonly tenantId?: string;
  // M4.15.al — threaded by dispatcher
  readonly tenantSlug?: string;
  readonly allTenants?: true;
}
```

`RetentionHousekeepingReport`:

```typescript
export interface RetentionHousekeepingReport {
  readonly asOf: string;
  readonly tenantId?: string;
  readonly tenantSlug?: string;  // M4.15.al
  readonly allTenants?: true;
  readonly tables: ReadonlyArray<RetentionHousekeepingTableReport>;
}

export interface GatherRetentionHousekeepingInput {
  // ...
  readonly tenantId?: string;
  readonly tenantSlug?: string;  // M4.15.al
  readonly allTenants?: true;
}
```

The gather
functions
pass
`tenantSlug`
through to
the report
via the
same
conditional-
spread
pattern
as the
existing
`tenantId`:

```typescript
return {
  asOf: input.now.toISOString(),
  tables,
  ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
  ...(input.tenantSlug !== undefined ? { tenantSlug: input.tenantSlug } : {}),
  ...(input.allTenants === true ? { allTenants: true as const } : {}),
};
```

### Dispatcher computation

Both
dispatchers
(`runGateway
Housekeeping`
+ `runRetention
Housekeeping`)
gain the
same
`tenantSlug`
computation
right after
the existing
slug
resolution:

```typescript
let tenantSlug: string | undefined;
if (tenantFlag !== null && tenantId !== undefined) {
  if (tenantFlag !== tenantId) {
    // Slug input — preserve operator-typed value.
    tenantSlug = tenantFlag;
  } else {
    // UUID input — reverse-lookup canonical slug from meta.tenants.
    tenantSlug = await reverseTenantSlug(conn, tenantId);
  }
}
```

Mirrors
M4.15.ak
exactly.
Threaded
into the
shared
`gather`
closure
so both
single-
tick
AND
watch
paths
benefit.

### Gateway gh-summary header

`formatHouseke
epingReportGh
Summary`
already
reads
`report.tenantId`
when
present.
The header
line gains
the same
conditional-
slug
treatment
as
M4.15.ai/ak:

```typescript
if (report.tenantId !== undefined) {
  if (report.tenantSlug !== undefined && report.tenantSlug !== report.tenantId) {
    lines.push(`**Tenant:** \`${report.tenantId}\` (slug: \`${report.tenantSlug}\`)  `);
  } else {
    lines.push(`**Tenant:** \`${report.tenantId}\`  `);
  }
}
```

### JSON envelope sites

Both
dashboards
emit
JSON via
`...report`
spread.
Because
`tenantSlug`
is now a
field on
the
report,
the
spread
picks it
up
automatically
— no
per-sink
change
needed
at the
JSON
emit
sites
(watch
tick
NDJSON,
single-
tick
printJson,
single-
tick
JSON.stringify
in
retention
housekeeping
all
get
it
for
free).

### Why no gh-summary on retention housekeeping

Retention
housekeeping
currently
emits
only
json
+
human.
Adding
a
gh-summary
surface
to
that
dashboard
is a
separate
milestone
(distinct
shape
than
gateway
housekeeping's
gh-summary
since
retention
housekeeping
has
different
fields:
enabled,
perTenantPolicyCount
etc.).
Deferred
to
future
Q.

### Scope summary

Two
surfaces
× three
behaviors
(forward
slug,
reverse
slug,
both
output
formats
where
applicable):

| Surface | gh-summary | JSON | Tests added |
|---|---|---|---|
| gateway housekeeping | forward + reverse | forward + reverse | 5 |
| retention housekeeping | (no surface) | forward + reverse | 4 |

## Tests added

5 new
tests in
the new
"slug
round-
trip
(M4.15.al)"
describe
block
inside
the
existing
M4.14.o
gateway
housekeeping
describe
in
`gateway.test.ts`:

1. `--tenant
   <slug>`
   +
   `--format
   json`
   emits
   tenantSlug
   alongside
   tenantId.
2. `--tenant
   <slug>`
   +
   `--format
   gh-summary`
   surfaces
   slug
   in
   `**Tenant:**`
   header.
3. `--tenant
   <uuid>`
   +
   reverse-
   lookup
   hit
   surfaces
   slug
   round-
   trip
   in
   both
   formats.
4. `--tenant
   <uuid>`
   +
   reverse-
   lookup
   miss
   preserves
   bare-
   UUID
   shape
   (backward
   compat).
5. `--all-
   tenants`
   omits
   tenantSlug —
   no
   slug
   resolution
   happens
   in
   matrix
   mode.

4 new
tests in
the new
"slug
round-
trip
(M4.15.al)"
describe
block
inside
the
existing
M4.14.o
retention
housekeeping
describe
in
`retention-
housekeeping.test.ts`:

1. `--tenant
   <slug>`
   +
   `--format
   json`
   emits
   tenantSlug
   alongside
   tenantId.
2. `--tenant
   <uuid>`
   +
   reverse-
   lookup
   hit
   surfaces
   tenantSlug
   from
   meta.tenants.
3. `--tenant
   <uuid>`
   +
   reverse-
   lookup
   miss
   preserves
   bare-
   UUID
   shape.
4. `--all-
   tenants`
   omits
   tenantSlug.

Plus 2
existing
M4.14.o
"UUID-
shaped
--tenant
bypasses
slug
lookup"
invariant
tests
(one
per
dashboard)
updated
to
assert
the
new
M4.15.al
semantic:
forward
slug→UUID
lookup
still
bypassed,
reverse
UUID→slug
lookup
is the
new
opt-in
audit-
trail
query.

Both
`fakeConnWithSlug`
helpers
(one
per
dashboard
test
file)
extended
to
handle
the
reverse
query
by
inverting
slugMap
(slug→uuid
→
uuid→slug).
Tests
with
empty
slugMap
get no
slug
back
(preserves
M4.15.aj
backward-
compat
behavior).

## Coverage impact

`gateway-housekeeping.ts`
+
`retention-housekeeping.ts`
gain
conditional-
branch
coverage
on
the
UUID-
input
reverse
lookup
path
exercised
by
the
integration
tests.
Both
stay
above
80%
statements
threshold.

`tenant-resolver.ts`
unchanged
(reuses
existing
`reverseTenantSlug`
helper
from
M4.15.ak).

## Rejected alternatives

1. **Pass
   tenantSlug
   as a
   separate
   field
   in the
   JSON
   envelope
   spread
   instead
   of
   threading
   through
   the
   report:**
   would
   require
   updating
   N
   JSON
   emit
   sites
   per
   surface
   (single-
   tick
   printJson
   + watch
   tick
   NDJSON
   +
   gh-summary
   call).
   Threading
   through
   the
   report
   shape
   means
   one
   update
   point
   (the
   gather
   return)
   and
   all
   downstream
   sinks
   pick
   it
   up
   automatically
   via
   `...report`
   spread.

2. **Compute
   tenantSlug
   inside
   gatherHouseke
   epingReport
   /
   gatherRetention
   HousekeepingReport
   itself
   (instead
   of
   at
   the
   dispatcher
   level):**
   would
   move
   PG
   round-
   trip
   concerns
   into
   the
   gather
   function
   that
   currently
   doesn't
   need
   to
   know
   about
   slug
   resolution.
   The
   dispatcher
   already
   owns
   slug
   resolution
   (via
   `resolveTenantIdentifier`);
   adding
   reverse
   lookup
   in
   the
   same
   place
   is
   consistent.

3. **Add
   gh-summary
   to
   retention
   housekeeping
   in
   this
   milestone:**
   retention
   housekeeping
   has
   different
   per-
   table
   shape
   than
   gateway
   housekeeping
   (different
   field
   set
   like
   enabled,
   perTenantPolicyCount).
   Adding
   gh-summary
   would
   double
   the
   milestone
   scope
   and
   diverge
   from
   the
   "extend
   existing
   surfaces"
   pattern
   of
   M4.15.ai/aj/ak.
   Defer
   to
   a
   future
   "retention
   housekeeping
   gh-summary"
   milestone
   that
   would
   automatically
   inherit
   the
   slug
   round-
   trip
   from
   the
   report
   field.

4. **Skip
   the
   reverse
   lookup
   on
   per-
   dashboard
   surfaces
   (gh-summary
   header
   only,
   forward
   only):**
   would
   leave
   UUID-
   input
   operators
   with
   no
   slug
   in
   either
   format.
   The
   reverse
   lookup
   is
   the
   ADR-
   0324
   contribution;
   skipping
   it
   would
   make
   per-
   dashboard
   surfaces
   inconsistent
   with
   the
   cross-
   dashboard
   view.

5. **Skip
   gateway
   housekeeping
   gh-summary
   slug
   round-
   trip,
   do
   only
   JSON
   envelopes
   on
   both
   surfaces:**
   gateway
   housekeeping
   already
   has
   gh-summary
   (M4.15.z);
   skipping
   slug
   round-
   trip
   there
   would
   leave
   inconsistency
   with
   tenant
   housekeeping
   gh-summary
   (M4.15.ai).
   Symmetric
   coverage
   matters.

6. **Apply
   pattern
   to
   `--watch`
   tick
   error
   envelopes:**
   when
   `gather()`
   throws
   under
   `--watch-
   keep-
   going`,
   the
   renderError
   path
   emits
   a
   minimal
   error
   envelope
   that
   doesn't
   include
   `tenantId`.
   Could
   include
   `tenantSlug`
   too
   for
   audit-
   trail
   correlation
   on
   errors.
   Defer
   to
   ADR-
   0324
   future
   Q7
   ("reverse
   lookup
   in
   error-
   path
   gh-summary").

7. **Cache
   reverse
   lookup
   across
   --watch
   ticks:**
   pairs
   with
   ADR-
   0324
   future
   Q4
   (cache
   in
   --watch
   loops).
   Resolution
   stable
   for
   watch
   session
   duration;
   could
   memoize
   to
   skip
   repeated
   queries
   per
   tick.
   Defer
   until
   measured
   slow.

8. **Surface
   tenantSlug
   in
   `**Scope:**`
   line
   under
   `--all-
   tenants`:**
   pairs
   with
   ADR-
   0324
   future
   Q5
   (batched
   reverse
   lookup
   for
   matrix
   mode).
   Defer
   until
   matrix-
   mode
   slug
   surfacing
   requested.

## Drawbacks

- **Asymmetric
  scope
  between
  surfaces:**
  gateway
  housekeeping
  gets
  slug
  round-
  trip
  in
  BOTH
  formats;
  retention
  housekeeping
  gets
  it
  only
  in
  JSON
  because
  no
  gh-summary
  surface
  exists
  there
  yet.
  Operators
  reading
  both
  dashboards
  may
  notice
  inconsistency.
  Mitigated
  by
  documentation
  +
  deferred
  Q
  for
  retention
  housekeeping
  gh-summary
  shipment.

- **Report
  shape
  expansion:**
  both
  `HousekeepingReport`
  +
  `RetentionHousekeepingReport`
  now
  have
  N+1
  conditional
  fields.
  Consumers
  using
  strict
  JSON
  schema
  validation
  (generated
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
  field.
  Operators
  should
  regenerate
  client
  code
  from
  updated
  schemas.

- **No
  envelope
  shape
  versioning:**
  same
  concern
  as
  ADR-
  0323
  +
  ADR-
  0324.
  Defer
  until
  demand
  emerges.

- **Reverse
  lookup
  best-
  effort
  may
  surprise:**
  operators
  passing
  UUIDs
  not
  in
  `meta.tenants`
  see
  no
  slug
  output.
  Documented
  in
  ADR-
  0324
  +
  source
  comments.

## Future Qs

1. **Add
   gh-summary
   surface
   to
   retention
   housekeeping:**
   would
   inherit
   slug
   round-
   trip
   from
   the
   report
   field
   automatically.
   Pairs
   with
   broader
   gh-summary
   coverage
   for
   substrate-
   centric
   dashboards.

2. **Apply
   slug
   round-
   trip
   to
   `--watch`
   error
   envelopes:**
   pairs
   with
   ADR-
   0324
   future
   Q7;
   when
   `gather()`
   throws,
   include
   tenantSlug
   in
   the
   error
   envelope
   for
   audit-
   trail
   correlation.

3. **Cache
   reverse
   lookup
   across
   --watch
   ticks:**
   pairs
   with
   ADR-
   0324
   future
   Q4.

4. **Reverse
   lookup
   batching
   for
   matrix
   mode:**
   pairs
   with
   ADR-
   0324
   future
   Q5;
   surface
   slug
   for
   every
   tenant
   in
   `--all-
   tenants`
   matrix
   output.

5. **Apply
   pattern
   to
   retention
   diff
   family:**
   pairs
   with
   ADR-
   0322
   Q1 +
   ADR-
   0323
   Q2 +
   ADR-
   0324
   Q1
   for
   per-
   side
   slug
   threading.

6. **Apply
   pattern
   to
   retention
   history
   /
   summary
   surfaces:**
   pairs
   with
   ADR-
   0323
   Q3 +
   ADR-
   0324
   Q2.
   Those
   surfaces
   accept
   `--tenant`
   and
   emit
   `tenantFilter`
   in
   JSON
   but
   don't
   have
   gh-summary
   surfaces
   yet.
