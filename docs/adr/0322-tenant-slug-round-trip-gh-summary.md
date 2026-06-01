# ADR-0322: Per-tenant slug round-trip in gh-summary headers (M4.15.ai)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-06-01 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0314 (M4.15.aa tenant housekeeping gh-summary baseline), ADR-0320 (M4.15.ag retention list-policies gh-summary baseline), ADR-0273 (M4.14.o tenant slug resolution via meta.tenants) |

## Context

ADR-0273 (M4.14.o)
gave operators a
`--tenant <uuid|
slug>` resolver
that short-
circuits on UUIDs
and looks up
slugs against
`meta.tenants`.
Operators
debugging
interactively now
type `--tenant
acme-prod` rather
than copy-pasting
36-character
UUIDs.

But the
`gh-summary`
output across the
diff family +
list surfaces all
echo back ONLY
the resolved UUID
— the slug the
operator typed is
lost. CI step
summaries
generated from
`crossengin
tenant
housekeeping
--tenant acme-
prod --format
gh-summary >>
$GITHUB_STEP_SUMMARY`
render
`**Tenant:**
\`<36-char-uuid>\``
with no hint
that `acme-prod`
was the input.
Reviewers
scanning step
summaries for a
specific tenant
have to mentally
map UUIDs back
to slugs.

ADR-0314 future
Q4 + ADR-0320
future Q3 both
flagged
"per-tenant slug
round-trip in
gh-summary
headers" as the
deferred fix.
This milestone
closes both Qs
with the same
mechanical
pattern applied
to two surfaces.

## Decision

Surface the
operator's
original
`--tenant` input
in gh-summary
headers when it
differs from the
resolved UUID
(i.e., the input
was a slug).
UUID input
preserves the
existing bare-
UUID shape
verbatim
(backward-
compatible).

### Tenant housekeeping (`formatTenantHousekeepingReportGhSummary`)

`TenantHousekeepingReportGhSummaryInput`
gains optional
`tenantSlug?:
string`. The
header line
renders:

- `tenantSlug !==
  undefined &&
  tenantSlug !==
  tenantId`:
  `**Tenant:**
  \`<uuid>\`
  (slug:
  \`<slug>\`)`
- otherwise:
  `**Tenant:**
  \`<uuid>\`` (M4.15.aa
  shape)

### Retention list-policies (`formatPoliciesListGhSummary`)

`PoliciesListGhSummaryInput`
gains optional
`tenantSlug?:
string | null`.
The
`**Filtered:**`
line surfaces:

- `tenantSlug !==
  undefined &&
  tenantSlug !==
  null &&
  tenantSlug !==
  tenantFilter`:
  `tenant=\`<uuid>\`
  (slug:
  \`<slug>\`)`
- otherwise:
  `tenant=\`<uuid>\``
  (M4.15.ag shape)

### Call-site threading

Both surfaces
read the
operator's raw
`--tenant` input
via
`getStringFlag(command,
"tenant")`. After
resolution they
have both the
raw value
(`tenantFlag` /
`tenantRaw`) and
the resolved
UUID. The
renderer-input
`tenantSlug` is
populated as:

```typescript
tenantSlug: rawInput !== null && rawInput !== resolvedUuid
  ? rawInput
  : undefined
```

UUID input →
`rawInput ===
resolvedUuid` →
`undefined` →
renderer
preserves bare-
UUID shape.

Slug input →
`rawInput !==
resolvedUuid` →
slug value →
renderer emits
round-trip line.

### Backward
compatibility

When `tenantSlug`
is `undefined`
the renderer
matches M4.15.aa
+ M4.15.ag shapes
exactly. CI
parsers reading
either header
shape continue
to work — the
slug suffix is
purely additive
text in
parentheses.

### Why
diff/diff-history/diff-timeline
surfaces skipped

The retention +
housekeeping
diff renderers
(M4.15.i,
M4.15.l,
M4.15.m,
M4.15.n,
M4.15.s,
M4.15.ah) thread
`anchorSide` +
`rhsSides` with
`{tenantId,
input}` shapes
separately —
each side has
its own slug
candidate.
Threading
`tenantSlug` for
multi-tenant
diffs needs N
slug values, not
one. Deferred
to a future
milestone (Q1 in
future Qs
below) since
the pattern is
mechanically
similar but
needs per-side
threading
through 4+
renderer
signatures.

## Tests added

5 new tests in
the new
"tenant
housekeeping
gh-summary slug
round-trip
(M4.15.ai)"
describe block
in
`tenant.test.ts`:

1. **Integration
   slug
   round-trip:**
   `--tenant
   acme-prod
   --format gh-
   summary` →
   header
   contains
   ``**Tenant:**
   `<RESOLVED_UUID>`
   (slug:
   `acme-prod`)``.
2. **Integration
   UUID
   backward
   compat:**
   `--tenant
   <RESOLVED_UUID>
   --format gh-
   summary` →
   header
   contains
   ``**Tenant:**
   `<RESOLVED_UUID>` ``
   with NO
   `(slug:` suffix.
3. **Direct
   renderer
   round-trip:**
   `formatTenantHousekeepingReportGhSummary`
   with both
   `tenantId` +
   `tenantSlug`
   set to
   different
   values emits
   `(slug:`
   suffix.
4. **Direct
   renderer
   UUID input:**
   when
   `tenantSlug ===
   tenantId` no
   `(slug:`
   suffix.
5. **Direct
   renderer
   undefined:**
   when
   `tenantSlug`
   undefined no
   `(slug:`
   suffix.

6 new tests in
the new
"retention list-
policies gh-
summary slug
round-trip
(M4.15.ai)"
describe block
in
`retention.test.ts`:

1. **Integration
   slug
   round-trip:**
   `--tenant
   acme-prod
   --format gh-
   summary` →
   `**Filtered:**
   tenant=`<UUID>`
   (slug:
   `acme-prod`)`.
2. **Integration
   UUID
   backward
   compat:**
   `--tenant
   <UUID>
   --format gh-
   summary` →
   `**Filtered:**
   tenant=`<UUID>``
   with NO
   `(slug:`
   suffix.
3. **Direct
   renderer
   round-trip:**
   `formatPoliciesListGhSummary`
   with mismatch
   emits `(slug:`.
4. **Direct
   renderer
   UUID match:**
   no `(slug:`
   when values
   match.
5. **Direct
   renderer
   undefined:**
   no `(slug:`
   when
   `tenantSlug`
   undefined.
6. **Direct
   renderer
   composition:**
   slug round-
   trip composes
   correctly with
   `--table`
   filter
   (`tenant=
   \`<uuid>\`
   (slug:
   \`<slug>\`) |
   table=
   \`workflow_traces\``).

## Coverage
impact

tenant.ts stays
above the 80%
statements
threshold; the
new
`tenantSlug`
branch in
`formatTenantHousekeepingReportGhSummary`
is exercised by
both
integration and
direct unit
tests.

retention.ts
stays above
threshold; the
new
`tenantSlug`
branch in
`formatPoliciesListGhSummary`
is exercised
similarly.

## Rejected
alternatives

1. **Always
   surface
   slug:**
   resolver
   would need
   to remember
   the raw
   input even
   when UUID
   was passed
   — operators
   passing UUIDs
   wouldn't want
   a redundant
   `(slug:
   \`<uuid>\`)`
   line.
   Conditional
   rendering
   matches
   operator
   intent.

2. **Replace
   UUID with
   slug:**
   would break
   the audit
   reproducibility
   property —
   gh-summary
   captures
   what's
   stored,
   slug is
   operator
   convenience.
   Both values
   preserve the
   semantic.

3. **Surface
   slug ONLY in
   metadata,
   not in
   header:**
   would
   require
   operators to
   read further
   down the
   summary to
   find the
   slug
   correlation
   — defeats
   the
   ease-of-
   audit point.

4. **Use a
   custom
   delimiter
   (`/`, `→`):**
   parentheses
   are the
   natural
   choice for
   parenthetical
   annotations
   in Markdown
   and match
   how `(slug:`
   reads in CI
   step
   summaries.

5. **Resolve
   the slug on
   the fly in
   the
   renderer:**
   would
   require
   passing a
   slug
   resolver
   callback
   into
   renderer
   functions —
   couples the
   pure
   Markdown
   layer to
   resolver
   logic and
   adds an
   async
   surface to
   sync
   helpers.
   Threading
   the raw
   input from
   the
   dispatcher
   keeps
   renderers
   pure.

6. **Apply
   the same
   pattern to
   `--diff`,
   `--diff-history`,
   `--diff-
   timeline`
   in this
   milestone:**
   diff
   renderers
   take
   `anchorSide`
   + `rhsSides`
   with
   per-side
   `{tenantId,
   input}` —
   threading
   `tenantSlug`
   for each
   side is
   structurally
   more
   invasive
   (4+
   renderer
   signatures
   each
   ingest
   per-side
   slugs).
   Deferred to
   future Q1.

7. **Echo
   slug in
   JSON
   envelope
   too:**
   ADR-0314 +
   ADR-0320
   JSON
   envelopes
   currently
   omit
   tenantSlug
   from the
   shape.
   Adding it
   would
   change the
   envelope
   shape for
   programmatic
   consumers
   — defer
   unless
   asked.
   gh-summary
   is operator-
   facing
   Markdown
   distinct
   from JSON
   audit
   shape.

## Drawbacks

- **Tightly-
  coupled
  pair of
  surfaces:**
  this
  milestone
  applies one
  pattern to
  two
  renderers
  in one
  commit.
  Future
  milestones
  applying
  the
  pattern to
  diff/diff-
  history/
  diff-
  timeline
  surfaces
  (Q1) will
  need to
  thread
  per-side
  slugs
  differently
  — operators
  reading
  ADR-0322
  shouldn't
  expect the
  same
  trivial
  threading
  to apply
  there.

- **No
  envelope
  exposure:**
  the slug
  appears
  only in
  gh-summary
  Markdown,
  not in
  JSON/YAML
  envelopes.
  Programmatic
  consumers
  parsing
  JSON
  envelopes
  for
  audit-trail
  purposes
  still need
  to re-
  resolve
  slugs at
  their
  layer.

- **No
  reverse
  resolution
  for
  display:**
  operators
  passing
  `--tenant
  <uuid>`
  won't see
  the slug
  even if
  one
  exists in
  `meta.tenants`
  for that
  UUID. The
  round-
  trip is
  one-way
  (slug-
  input
  preserved)
  not
  bidirectional
  (UUID-
  input
  enriched).
  Adding
  reverse
  resolution
  would
  require an
  extra
  query —
  deferred
  to future
  Q.

- **JSONB-
  shaped
  characters
  in slugs:**
  the slug
  regex from
  meta-
  schema
  (`^[a-z][a-z0-9-]*$`)
  doesn't
  allow
  Markdown-
  special
  characters
  (backticks,
  parentheses,
  pipes) so
  the
  parenthetical
  rendering
  is safe
  without
  escaping.
  If the
  slug regex
  ever
  widens,
  escaping
  needs to
  be added.

## Future Qs

1. **Apply
   slug
   round-trip
   pattern to
   diff/diff-
   history/
   diff-
   timeline
   gh-summary
   surfaces:**
   each side
   has its
   own
   `{tenantId,
   input}`
   shape;
   threading
   slug per
   side
   through
   renderers
   like
   `formatPoliciesDiffGhSummary`,
   `formatPoliciesMultiDiffGhSummary`,
   `formatHousekeepingDiffGhSummary`,
   `formatHistoryDiffGhSummary`,
   `formatTimelineDiffGhSummary` is
   structurally
   the same
   but
   touches
   more
   surfaces.

2. **Reverse
   slug
   resolution
   for UUID
   input:**
   operators
   passing
   `--tenant
   <uuid>`
   currently
   see only
   the UUID;
   could
   look up
   the slug
   against
   `meta.tenants`
   and render
   both. One
   extra
   query per
   gh-summary
   call —
   defer
   unless
   operator
   demand
   emerges.

3. **Surface
   slug in
   JSON
   envelope:**
   add
   `tenantSlug?:
   string`
   field to
   the
   gh-summary-
   adjacent
   JSON
   envelope
   shape so
   programmatic
   consumers
   parsing
   JSON for
   audit-
   trail
   purposes
   don't
   need to
   re-resolve
   slugs.
   Pairs
   with Q2.

4. **Apply
   to
   retention
   history /
   summary
   gh-summary:**
   `retention
   history`
   +
   `retention
   summary`
   accept
   `--tenant`
   but don't
   currently
   have
   `--format
   gh-summary`
   surfaces.
   When they
   do
   (future
   milestone),
   apply the
   M4.15.ai
   pattern.

5. **Surface
   slug in
   `**Scope:**`
   line under
   `--all-
   tenants`:**
   currently
   `--all-
   tenants`
   mode
   renders
   `**Scope:**
   all
   tenants` —
   no per-
   tenant
   slug
   context.
   If
   operators
   want a
   slug roll-
   up
   ("scope:
   all
   tenants
   (acme-
   prod,
   acme-
   staging,
   ...)"
   they'd
   need the
   per-table
   tenantOverrides
   matrix
   from
   ADR-0271
   M4.14.q.
   Defer.
