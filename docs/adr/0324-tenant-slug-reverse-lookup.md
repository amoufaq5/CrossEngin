# ADR-0324: Reverse slug lookup for UUID-input callers (M4.15.ak)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-06-01 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0322 (M4.15.ai slug round-trip in gh-summary headers), ADR-0323 (M4.15.aj slug round-trip in JSON envelopes), ADR-0273 (M4.14.o tenant slug resolution via meta.tenants) |

## Context

ADR-0322
(M4.15.ai)
+ ADR-0323
(M4.15.aj)
shipped the
**forward**
half of the
slug round-
trip story:
when operators
type `--tenant
<slug>`, the
slug is
preserved in
gh-summary
headers + JSON
envelopes
alongside the
resolved UUID.

But the
**reverse**
direction was
deliberately
deferred —
operators
passing
`--tenant <uuid>`
(e.g.,
scripting
against
stored UUIDs
in a CI
config, or
copy-pasting
from a
previous
audit log)
got no slug
in either
output:

```json
{
  "tenantId": "00000000-0000-4000-8000-...",
  // no tenantSlug
}
```

The round-
trip was
**one-way**:
slug input
→ slug
preserved;
UUID input
→ slug
absent.

ADR-0322
future Q2 +
ADR-0323
future Q1
explicitly
called out
this gap:

> **Reverse
>  slug
>  resolution
>  for UUID
>  input:**
>  operators
>  passing
>  `--tenant
>  <uuid>`
>  currently
>  see only
>  the UUID;
>  could
>  look up
>  the slug
>  against
>  `meta.tenants`
>  and render
>  both. One
>  extra query
>  per gh-
>  summary
>  call —
>  defer
>  unless
>  operator
>  demand
>  emerges.

This milestone
closes both
Qs together
so the round-
trip is
**bidirectional**:
UUID input
also gets
the slug
surfaced in
both
gh-summary
AND JSON
envelopes.

## Decision

Add a shared
`reverseTenantSlug
(conn,
tenantId)`
helper that
queries
`meta.tenants`
for the
canonical
slug
matching a
given UUID,
returning
the slug
or
`undefined`
if not
found.

Best-effort
semantic:
PG transient
errors,
missing
rows, and
empty-string
slug fields
all degrade
silently to
`undefined`
so audit-
trail
visibility
doesn't
block the
main
workflow.

### Helper signature

```typescript
export async function reverseTenantSlug(
  conn: PgConnection,
  tenantId: string,
): Promise<string | undefined> {
  try {
    const result = await conn.query<{ slug: string }>(
      `SELECT slug FROM meta.tenants WHERE id = $1`,
      [tenantId],
    );
    const row = result.rows[0];
    if (row !== undefined && typeof row.slug === "string" && row.slug.length > 0) {
      return row.slug;
    }
  } catch {
    // Best-effort: degrade silently rather than blocking the surface.
  }
  return undefined;
}
```

Located in
`tenant-resolver.ts`
alongside the
forward
`resolveTenantIdentifier`
helper so both
directions live
side-by-side
and share the
same test
fixtures.

### Call-site threading

Both surfaces
that got slug
round-trip in
M4.15.ai/aj
gain the
reverse-lookup
branch:

**tenant.ts**
(`runTenantHousekeeping`):

```typescript
let tenantSlug: string | undefined;
if (tenantFlag !== null && tenantId !== undefined) {
  if (tenantFlag !== tenantId) {
    // Slug input — preserve operator-typed value (M4.15.aj behavior).
    tenantSlug = tenantFlag;
  } else {
    // UUID input — reverse-lookup canonical slug from meta.tenants.
    tenantSlug = await reverseTenantSlug(conn, tenantId);
  }
}
```

**retention.ts**
(`runRetentionListPolicies`):

```typescript
let tenantSlug: string | undefined;
if (tenantRaw !== null && tenantFilter !== null) {
  if (tenantRaw !== tenantFilter) {
    tenantSlug = tenantRaw;
  } else if (conn !== undefined) {
    // Test paths without pgConnectionOverride skip the reverse lookup —
    // same gap as the forward resolver path.
    tenantSlug = await reverseTenantSlug(conn, tenantFilter);
  }
}
```

The same
`tenantSlug`
variable
threads
through ALL
existing
sinks
(gh-summary
header, JSON
envelope,
NDJSON
watch tick)
unchanged
from
M4.15.aj.

### Why best-effort not strict

Failure
modes
considered:

1. **PG
   transient
   error**
   (network
   blip,
   connection
   timeout
   during
   the
   extra
   query):
   silently
   degrade
   to no
   slug.
   Better
   than
   blocking
   the
   housekeeping
   output
   when the
   main
   gather()
   succeeded.

2. **Missing
   row**
   (UUID
   doesn't
   exist in
   `meta.tenants`
   —
   operator
   typed a
   garbage
   UUID,
   or
   tenant
   was
   deleted
   between
   resolution
   and
   reverse
   lookup):
   no row
   →
   undefined
   →
   tenantSlug
   omitted.
   Matches
   M4.15.aj
   "no
   slug
   available"
   semantic.

3. **Slug
   field
   is
   empty
   string**
   (unusual
   but
   possible
   if
   schema
   validation
   slipped):
   `typeof
   slug ===
   "string"
   && slug.length
   > 0`
   defensive
   check
   →
   undefined.

In all
three
cases the
main
workflow
proceeds
with bare
UUID
output —
audit-
trail
correlation
is "best-
effort
nice-to-
have",
not a
hard
gate.

### Why not opt-in via flag

One extra
PG query
per
call —
indexed
PK
lookup
on
`meta.tenants(id)`
—
negligible
at
typical
scales
(<1ms
overhead
even at
10K
tenants).

Operators
running
millions
of
housekeeping
calls per
day
might
push
back,
but:

- Slug-
  input
  workflows
  already
  pay
  the
  forward-
  resolver
  query
  (1
  extra
  query
  per
  call).
- UUID-
  input
  workflows
  pay
  the
  same
  reverse-
  resolver
  query
  for
  symmetry.
- Both
  shapes
  thus
  cost
  exactly
  one
  meta.tenants
  query
  per
  call —
  fair
  trade.

A
hypothetical
opt-out
flag
(`--no-
slug-
lookup`)
adds API
surface
for a
microsecond-
scale
optimization
that
hasn't
been
measured
to matter.
Defer
until
operator
demand
emerges.

### Scope: same two surfaces

Mirrors
M4.15.ai
+ M4.15.aj
scope
exactly:
tenant
housekeeping
+
retention
list-
policies.
The
reverse
lookup
applies
wherever
the
forward
M4.15.aj
slug
round-
trip
applies.

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
still
echo
only
the
resolved
UUID
(no
gh-summary
slug
round-
trip
yet,
no
JSON
slug
round-
trip
yet).
They
should
get
both
forward
AND
reverse
slug
round-
trip
together
in a
future
milestone.

## Tests added

6 new tests
in the new
"reverseTenantSlug
(M4.15.ak)"
describe
block in
`tenant-resolver.test.ts`
covering
the helper
in
isolation:

1. Returns
   the
   matched
   slug
   when
   meta.tenants
   has a
   row.
2. Returns
   undefined
   when no
   row
   matches.
3. Returns
   undefined
   when
   row
   has
   missing
   slug
   field
   (defensive
   against
   degraded
   DB
   states).
4. Returns
   undefined
   when
   slug
   field
   is
   empty
   string.
5. Returns
   undefined
   when
   query
   throws
   (best-
   effort
   degradation).
6. Uses
   parameterized
   query
   (UUID
   passed
   as
   $1
   not
   interpolated;
   defense-
   in-
   depth
   against
   injection).

5 new tests
in the new
"tenant
housekeeping
reverse
slug round-
trip
(M4.15.ak)"
describe
block in
`tenant.test.ts`:

1. `--tenant
   <uuid>`
   +
   `--format
   json`
   emits
   tenantSlug
   from
   reverse
   lookup
   when
   meta.tenants
   has the
   row.
2. `--tenant
   <uuid>`
   +
   `--format
   gh-summary`
   emits
   slug
   round-
   trip
   header
   from
   reverse
   lookup.
3. `--tenant
   <uuid>`
   +
   `--format
   json`
   omits
   tenantSlug
   when no
   slug
   exists
   for
   that
   UUID
   (M4.15.aj
   backward
   compat).
4. `--tenant
   <slug>`
   path
   still
   preserves
   operator
   input
   over
   reverse-
   lookup
   result
   (M4.15.aj
   behavior).
5. `--all-
   tenants`
   omits
   tenantSlug
   — no
   slug
   resolution
   in
   matrix
   mode.

5 new tests
in the new
"retention
list-
policies
reverse
slug round-
trip
(M4.15.ak)"
describe
block in
`retention.test.ts`:

1. `--tenant
   <uuid>`
   +
   `--format
   json`
   emits
   tenantSlug
   from
   reverse
   lookup
   when
   meta.tenants
   has
   the
   row.
2. `--tenant
   <uuid>`
   +
   `--format
   gh-summary`
   emits
   slug
   round-
   trip
   in
   `**Filtered:**`
   line.
3. `--tenant
   <uuid>`
   +
   `--format
   json`
   omits
   tenantSlug
   when
   no
   slug
   exists
   (M4.15.aj
   backward
   compat).
4. `--tenant
   <slug>`
   path
   still
   preserves
   operator
   input
   over
   reverse-
   lookup
   result.
5. No
   `--tenant`
   flag —
   no
   reverse
   lookup
   attempted,
   tenantSlug
   omitted.

Plus one
existing
M4.14.m
test updated:
"UUID-shaped
--tenant
bypasses
slug
lookup on
all three
surfaces"
— previously
asserted
"NO
meta.tenants
SELECT
issued";
now
asserts
"NO
forward
slug→UUID
lookup
issued"
since
M4.15.ak
adds an
opt-in
reverse
UUID→slug
lookup
for
list-
policies.

## Coverage impact

tenant-resolver.ts
gains the
new
`reverseTenantSlug`
function
exercised
by 6 unit
tests
across
happy
path + 5
degradation
paths.

tenant.ts +
retention.ts
gain
conditional-
branch
coverage
on the
UUID-input
reverse
lookup
path
exercised
by both
gh-summary
and JSON
integration
tests.

## Rejected alternatives

1. **Cache
   reverse
   lookups
   across
   calls:**
   operators
   running
   --watch
   loops or
   batch
   scripts
   might
   want
   slug
   memoization
   to skip
   repeated
   queries
   for the
   same
   UUID.
   But the
   cache
   invalidation
   problem
   (slug
   rename
   mid-
   session)
   adds
   complexity
   for
   sub-
   millisecond
   savings.
   Defer
   until
   measured
   slow at
   million-
   call/
   day
   scale.

2. **Make
   reverse
   lookup
   opt-in
   via
   `--include-
   slug`
   flag:**
   adds
   API
   surface
   for a
   feature
   most
   operators
   want
   by
   default.
   Symmetric
   cost
   with
   forward
   slug
   resolution
   (both
   are 1
   query
   per
   call)
   means
   no
   reason
   to
   special-
   case UUID
   input.

3. **Make
   reverse
   lookup
   opt-out
   via
   `--no-
   slug-
   lookup`
   flag:**
   defensive
   surface
   expansion
   for a
   microsecond-
   scale
   optimization
   that
   hasn't
   been
   measured.
   Defer
   until
   operator
   demand
   emerges.

4. **Throw
   on
   reverse-
   lookup
   failure
   instead
   of
   degrade
   silently:**
   would
   block
   the
   main
   workflow
   when
   the
   main
   gather()
   succeeded.
   Audit-
   trail
   visibility
   is
   "best-
   effort
   nice-
   to-
   have",
   not
   a
   hard
   gate;
   degrading
   silently
   matches
   the
   audit-
   trail-
   not-
   workflow-
   blocker
   principle.

5. **Surface
   "slug
   lookup
   failed"
   as a
   separate
   field
   in the
   envelope:**
   would
   add
   `slugLookupError:
   "<message>"`
   on
   failure.
   But
   operators
   don't
   need
   visibility
   into
   this
   failure
   mode —
   the
   bare
   UUID
   output
   is
   their
   signal
   that
   no
   slug
   was
   available.

6. **Reverse-
   lookup
   per-
   tenant
   in
   matrix
   mode
   (`--all-
   tenants`):**
   would
   query
   for
   slugs
   for
   EVERY
   tenant
   in the
   matrix
   —
   potentially
   thousands
   of
   queries.
   Defer
   for
   scaling
   reasons;
   matrix
   mode
   operators
   wanting
   slugs
   should
   pre-
   resolve
   client-
   side.

7. **Cache
   the
   reverse
   lookup
   in the
   tenant-
   resolver
   helper
   itself:**
   resolver
   currently
   has no
   state
   between
   calls.
   Adding
   memoization
   couples
   helper
   to a
   request-
   scoped
   cache
   that
   would
   live
   in the
   dispatcher
   level.
   Defer.

8. **Skip
   reverse
   lookup
   when
   --format
   is
   human
   (no
   slug
   surfaced
   in
   human
   output):**
   adds
   format-
   sensitive
   branching
   for a
   sub-
   millisecond
   optimization.
   Uniform
   behavior
   across
   formats
   is
   simpler.

## Drawbacks

- **One
  extra
  PG
  query
  per
  call
  for
  UUID
  input:**
  symmetric
  with
  the
  forward-
  resolver
  cost
  for
  slug
  input;
  operators
  paying
  for
  housekeeping
  output
  pay
  the
  same
  meta.tenants
  query
  cost
  regardless
  of
  input
  shape.

- **Best-
  effort
  degradation
  may
  surprise:**
  operators
  expecting
  the
  reverse
  lookup
  to
  always
  return
  a
  slug
  may
  not
  realize
  empty
  output
  means
  "no
  slug
  exists
  for
  this
  UUID
  in
  meta.tenants".
  Documented
  in
  the
  ADR +
  source
  comments.

- **No
  visibility
  into
  reverse-
  lookup
  failures:**
  operators
  debugging
  "why
  no
  slug
  in
  audit
  log?"
  see
  only
  the
  bare-
  UUID
  output;
  no
  trace
  of the
  failed
  query
  or
  empty
  row.
  Acceptable
  for
  best-
  effort
  audit-
  trail
  visibility;
  operators
  can
  re-
  query
  `meta.tenants`
  manually.

- **Test
  path
  without
  `pgConnectionOverride`
  in
  retention
  list-
  policies
  skips
  reverse
  lookup:**
  same
  gap
  as
  the
  forward
  `resolveTenantFlagFor`
  helper
  from
  M4.14.m;
  operators
  using
  that
  path
  must
  use
  UUIDs
  and
  accept
  bare-
  UUID
  output.

## Future Qs

1. **Apply
   reverse
   lookup
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
   Q1 +
   ADR-
   0323
   Q2
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

2. **Apply
   reverse
   lookup
   to
   retention
   history /
   summary
   gh-
   summary
   +
   JSON
   envelopes
   (when
   those
   surfaces
   ship):**
   pairs
   with
   ADR-
   0323
   Q3.

3. **Apply
   reverse
   lookup
   to
   gateway
   housekeeping
   +
   retention
   housekeeping
   (separate
   dashboards)
   gh-
   summary
   +
   JSON
   envelopes:**
   pairs
   with
   ADR-
   0323
   Q4.

4. **Cache
   reverse
   lookups
   in
   --watch
   loops:**
   slug-
   to-
   UUID
   mapping
   stable
   for
   the
   watch
   session
   duration;
   could
   memoize
   to skip
   repeated
   queries
   per
   tick.
   Defer
   until
   measured.

5. **Reverse
   lookup
   batching
   for
   matrix
   mode
   (`--all-
   tenants`):**
   a
   single
   `SELECT
   id,
   slug
   FROM
   meta.tenants
   WHERE
   id IN
   ($1,
   $2,
   ...)`
   query
   could
   replace
   N
   individual
   queries.
   Defer
   until
   operators
   ask
   for
   matrix-
   mode
   slug
   surfacing.

6. **Surface
   slug
   in
   `**Scope:**`
   line
   under
   `--all-
   tenants`:**
   pairs
   with
   batched
   reverse
   lookup
   above
   for
   matrix
   mode.
   Defer.

7. **Reverse
   lookup
   in
   error-
   path
   gh-
   summary:**
   when
   gh-
   summary
   fails
   due
   to
   gather()
   error,
   could
   still
   emit
   the
   slug
   in
   the
   error
   envelope
   for
   audit
   correlation.
   Defer.

8. **Multi-
   tenant
   reverse
   lookup
   for
   tenants
   list /
   get
   surfaces:**
   if
   `tenants
   list`
   gained
   `--format
   gh-
   summary`
   or
   tenants
   get
   gained
   slug
   resolution
   from
   UUID,
   the
   same
   pattern
   would
   apply.
   Pairs
   with
   ADR-
   0323
   Q5.
