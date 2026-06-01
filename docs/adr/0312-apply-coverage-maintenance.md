# ADR-0312: apply.ts coverage maintenance pass (M4.15.y)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0310 (M4.15.w apply gh-summary), M-maint.coverage (precedent maintenance pass) |

## Context

After M4.15.w shipped
gh-summary for the
apply surface,
apply.ts coverage
was 74.58%
statements — the
lowest in the
architect-cli/src
tree. The
uncovered lines
broke down into:

1. **Live-apply
   path** (lines
   88-130): the
   actual
   `MigrationApplier
   .apply()` flow
   couldn't be
   tested because
   no injection
   point existed
   for replacing
   the
   `createNodePg
   Connection` or
   the applier
   itself.
2. **PackValidationError
   class** (lines
   133-141): the
   class was
   defined but not
   exported, so
   couldn't be
   instantiated
   from tests.
3. **Error-handler
   branches** for
   PackValidation
   Error /
   ExtendsCycleError
   /
   UnknownParent
   ManifestError
   (lines 53-69)
   and the
   throw-site
   inside
   buildPlan
   (lines 163-
   164):
   reachable
   only via pack-
   registry
   mocking which
   would
   require
   invasive
   changes to
   pack
   resolution.

The existing
`pgConnection
Override`
pattern from
other surfaces
(gateway,
tenants,
sessions) was
not present on
apply.

## Decision

Add two
injection
points to
runApply via a
new
`ApplyContext`
interface that
extends
`RunContext`:

1. `pgConnection
   Override?:
   PgConnection`
   — skips
   `createNodePg
   Connection`
   call (matches
   the
   convention
   used
   throughout
   the rest of
   the
   codebase).
2. `applierOverride
   ?: {
   apply():
   Promise<Apply
   Report> }` —
   replaces the
   MigrationApplier
   entirely.
   Used in
   tests that
   want to
   exercise the
   format-
   branching +
   exit-code
   logic
   without
   constructing
   a fake PG
   conn that
   responds to
   the
   applier's
   internal
   queries.

Also export
`PackValidation
Error` so the
class can be
directly unit-
tested.

### When
applierOverride
is set, PG env
validation is
skipped

The test
injection
shortcut bypasses
`parsePgEnvConfig`
+
`looksLikeProduction
Database`. This
matches the
mental model:
operators
testing apply-
report rendering
don't have PG
env vars set
and don't want
the production-
DB check getting
in the way.

When
applierOverride
is NOT set
(production
flow), the
env-validation
+ production-DB
check fire
normally — no
behavior
change.

### pgConnection
Override still
goes through
production-DB
check

Unlike
applierOverride
(which bypasses
all PG
plumbing),
pgConnection
Override only
swaps the
underlying
connection.
The production-
DB check still
fires because
config is
parsed from
ctx.env. Tests
using
pgConnection
Override must
supply a non-
production
PGDATABASE
name.

## Tests added

13 new tests:

**`runApply
(live) with
applierOverride
(M4.15.y)`** (10
tests):

1. clean apply
   human format
   exit 0
2. clean apply
   --pack appends
   pack-applied
   success
   message
3. --format
   json envelope
   includes
   report
   fields +
   pack slug
4. --format
   json no
   --pack
   reports
   pack: null
5. --format
   gh-summary
   emits
   Markdown
   via live
   path
6. exit 1 on
   report.failed
   > 0
7. exit 1 on
   preconditions.
   ok=false
8. exit 1 on
   applier.apply
   throw (Error
   message
   printed)
9. exit 1 on
   applier.apply
   throw non-
   Error (String
   fallback)
10. --format
    gh-summary
    with
    precondition
    failure
    emits
    :x: Apply
    blocked
    verdict

**`runApply
(live)
pgConnection
Override
path`** (1
test):

11. real
    MigrationApplier
    construction +
    applier.apply
    error → exit
    1 + conn.close
    called (covers
    lines 105 +
    110-114 +
    catch block +
    finally
    branch)

**`PackValidation
Error class`**
(3 tests):

12. stores name +
    kind +
    summarized
    message
13. instanceof
    Error
14. handles
    empty errors
    list

## Coverage
delta

| Metric | M4.15.x | M4.15.y | Δ |
|---|---|---|---|
| Statements | 74.58% | 92.24% | +17.66pp |
| Branches | 89.28% | 93.75% | +4.47pp |
| Functions | 85.71% | 100.00% | +14.29pp |
| Lines | 74.58% | 92.24% | +17.66pp |

Remaining
uncovered:
lines 64-80
(error
handlers for
PackValidation
Error /
ExtendsCycle
Error /
UnknownParent
ManifestError
in the catch
block) +
183-184
(throw site
inside
buildPlan).
Both require
pack-registry
mocking that
would need
invasive
changes to
pack
resolution
(currently
the pack
registry is a
module-level
constant
without
injection
points).
Acceptable
trade-off:
92.24% is
the highest
apply.ts has
ever been
and these
3 error
handlers
are
defensive
paths
unlikely to
regress
silently.

## Rejected
alternatives

1. **Mock
   the pack
   registry
   module
   with
   vi.mock**
   — brittle
   and
   couples
   tests to
   pack-
   registry
   internals.

2. **Add a
   test-only
   invalid
   pack to
   the prod
   registry**
   —
   pollutes
   production
   pack
   listings;
   would
   appear
   in
   `apply
   --pack=
   bogus-test
   pack`
   error
   messages.

3. **Make
   buildPlan
   accept
   a pack-
   resolver
   function**
   — adds
   another
   injection
   point for
   limited
   benefit
   (already
   have
   pgConnection
   Override +
   applierOverride
   covering the
   biggest gap).

4. **Use
   jest.spyOn
   on
   resolvePack**
   — vitest
   doesn't
   have
   spyOn for
   module-
   level
   exports
   that
   cleanly;
   would
   require
   ESM
   intricacies.

5. **Mark
   the
   uncovered
   error
   handlers
   with
   `/* c8
   ignore */
   `
   pragma to
   force
   100%
   coverage**
   — would
   hide
   legitimate
   gaps;
   accept
   92.24%
   honestly.

6. **Add a
   `applier
   Factory?:
   (opts)
   =>
   Migration
   Applier`
   instead
   of
   `applier
   Override`**
   — factory
   pattern
   adds
   indirection
   without
   benefit;
   override
   is
   simpler
   and
   matches
   the
   `pgConnection
   Override`
   precedent
   used
   elsewhere.

7. **Co-
   locate
   the
   tests
   with
   the
   M4.15.w
   tests
   instead
   of a
   separate
   M4.15.y
   describe
   block** —
   the
   M4.15.y
   block is
   coverage
   maintenance
   not
   feature
   addition;
   separate
   describe
   makes
   the
   intent
   clear in
   the
   test-
   output
   tree.

## Drawbacks

- **`applier
  Override`
  bypasses
  production-
  DB check**
  — could
  be
  misused
  in real
  usage if
  someone
  wires it
  through
  to
  production
  config.
  Acceptable
  since
  it's
  test-only
  by
  convention
  (named in
  the
  TSDoc as
  "test-
  only").

- **3
  injection
  points
  now on
  ApplyContext
  (env via
  RunContext
  inheritance,
  pgConnection
  Override,
  applier
  Override)
  ** — slight
  cognitive
  load but
  matches
  established
  test-
  injection
  patterns
  elsewhere
  in
  architect-
  cli.

- **8.76%
  of
  statements
  still
  uncovered**
  (3 error
  handlers
  +
  build-
  plan
  throw).
  Documented
  as
  intentional
  trade-
  off.

- **Coverage
  delta
  isn't
  pure
  feature
  work**
  —
  M4.15.y
  is a
  maintenance
  pass.
  The
  M4.15
  series
  has
  established
  precedent
  (M-maint.
  coverage)
  for
  coverage-
  only
  milestones.

## Future Qs

1. **Inject
   pack
   resolver
   into
   buildPlan**
   if
   coverage
   of the
   build-
   plan
   validation
   paths
   becomes
   priority.

2. **Cover
   the
   ExtendsCycle
   Error +
   UnknownParent
   ManifestError
   catch
   handlers**
   by
   constructing
   a
   synthetic
   pack
   manifest
   that
   triggers
   those
   errors
   via
   resolveManifest.

3. **Add
   a
   `crossengin
   pack
   validate
   <slug>`
   subcommand**
   that
   would
   naturally
   exercise
   the
   PackValidation
   Error
   path
   without
   requiring
   apply
   to
   actually
   run.

4. **Document
   the
   apply
   injection
   points**
   in the
   CLI
   architecture
   doc so
   operators
   know
   they
   exist
   for
   test-
   fixture
   purposes
   only.

5. **Extend
   the
   M-maint.
   coverage
   pattern
   to
   other
   files
   below
   80%**
   (next
   candidates:
   commands.
   ts at
   86.46%
   could
   be a
   smaller
   maintenance
   pass).
