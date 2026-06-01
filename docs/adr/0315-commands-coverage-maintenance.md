# ADR-0315: commands.ts coverage maintenance pass (M4.15.ab)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0312 (M4.15.y apply.ts coverage pass), M-maint.coverage (precedent maintenance pass) |

## Context

After M4.14 shipped
error handling on
init/validate/diff/
hash/patch/chat,
commands.ts coverage
sat at 86.46%
statements / 79.66%
branches — above the
80% threshold for
statements but at
the edge for
branches. Several
defensive error
handlers (file-read
catches, JSON-format
error envelopes,
flag-validation
exits) were never
exercised by tests.

The M4.15.y apply.ts
maintenance pass set
the precedent for
coverage-only
milestones; this
follow-on targets
commands.ts as the
next-lowest file in
the architect-cli
tree.

## Decision

Add 14 new tests
targeting specific
uncovered statement
ranges surfaced by
the v8 coverage
report:

- runValidate: --
  format=json on
  duplicate-trait
  manifest (covers
  ok=false JSON
  branch via real
  validation failure
  using
  ManifestValidation
  Error from
  validateManifest's
  duplicate-trait
  check), human-
  format duplicate-
  trait manifest,
  missing-path
  exit 2, --format=
  json on file-not-
  found (read catch
  branch).
- runDiff: missing
  old-path and
  new-path catch
  branches (2 tests
  for each side).
- runHash: missing-
  path exit 2.
- runPatch: patch-
  file missing
  (readManifestFile
  catch), write
  refusal on
  --output to
  existing file
  (writeManifestFile
  refuses-to-
  overwrite branch),
  --format=json
  success envelope.
- runChat: --format
  ≠ human|json,
  --max-tokens
  non-numeric,
  --max-tokens
  zero, --max-
  tokens negative.

### Real-world
duplicate trait

The
`tryValidate
Manifest`
ok=false JSON
branch
(commands.ts
lines 110-116)
was the
hardest gap
to close —
requires a
manifest that
passes
`ManifestSchema.
parse` but
fails the
deeper
`validate
Manifest`
business-logic
check.
Constructed
by extending
`emptyManifest`
with two
traits sharing
the name
"foo" (the
`validateManifest`
duplicate-name
loop catches
this at
runtime
without
schema-level
rejection).

This pattern
mirrors how
operators
actually hit
the
ok=false
branch in
practice
(authoring
manifests
with
accidentally
duplicated
identifiers).

## Coverage
delta

| Metric | M4.15.aa | M4.15.ab | Δ |
|---|---|---|---|
| Statements | 86.46% | 93.64% | +7.18pp |
| Branches | 79.66% | 84.92% | +5.26pp |
| Functions | 100.00% | 100.00% | 0 |
| Lines | 86.46% | 93.64% | +7.18pp |

Remaining
uncovered:
lines 78-80
(runInit
emptyManifest
catch — hard
to trigger;
emptyManifest
is internally
constructed
from
TypeScript-
typed
parameters
that don't
reach the
runtime
validation
failures it
guards
against), and
lines 291-
292 / 348-
349 / 407 /
415-422
(runChat
various
error
rendering
paths
including
streaming
chunk errors,
tool-call
mismatch,
provider
disconnect)
— these are
chat-loop
internal
state
transitions
that
require
provider
stubs
producing
specific
chunk
sequences.
Defer to a
separate
chat-
specific
maintenance
pass.

## Rejected
alternatives

1. **Add
   chat-
   streaming
   tests
   covering
   the
   per-chunk
   error
   paths
   (lines
   291-292,
   348-349,
   407,
   415-422)**
   — would
   double
   the
   commands.test.ts
   size and
   requires
   constructing
   provider
   stubs
   that
   produce
   specific
   malformed
   chunk
   sequences.
   Defer
   to a
   chat-
   surface-
   specific
   pass.

2. **Mark
   the
   runInit
   emptyManifest
   catch
   (lines
   78-80)
   with
   `/* c8
   ignore */`
   ** —
   would
   force
   100%
   but
   hide
   a
   legitimate
   defensive
   guard.
   Accept
   the
   gap
   honestly.

3. **Make
   runChat
   accept
   a
   `provider
   Override`
   that's a
   generator
   to
   simulate
   error
   chunks**
   — already
   exists
   via
   StubProvider;
   the
   uncovered
   chat
   paths
   would
   need
   chunks
   that
   trigger
   specific
   internal
   transitions
   (e.g.,
   tool-call
   without
   matching
   pending,
   premature
   end).
   Test-data
   construction
   cost
   high.

4. **Refactor
   commands.ts
   to
   extract
   error
   helpers**
   so
   each
   catch
   block
   shares a
   single
   `formatRunError`
   function
   that's
   easier
   to test
   in
   isolation
   — would
   restructure
   the
   surface
   for
   coverage
   alone;
   not
   worth
   it.

5. **Co-
   locate
   the
   M4.15.ab
   tests
   inside
   the
   existing
   per-
   command
   describe
   blocks
   instead
   of a
   single
   "commands.ts
   coverage
   maintenance"
   block** —
   the
   maintenance-
   pass
   describe
   block
   makes
   the
   intent
   clear
   in
   test
   output
   (M-
   maint.
   coverage
   precedent).

6. **Use
   vi.mock
   to
   force
   manifestHash
   /
   emptyManifest
   to
   throw**
   — brittle
   and
   couples
   tests to
   internal
   module
   structure.
   Real
   inputs
   (duplicate-
   trait
   manifest)
   are
   honest.

## Drawbacks

- **commands.ts
  still
  has
  6.36%
  uncovered**
  (lines
  78-80,
  291-292,
  348-349,
  407,
  415-422).
  Documented
  as
  intentional
  trade-
  off
  awaiting
  a
  chat-
  surface
  pass.

- **Duplicate-
  trait
  test
  uses
  inline
  manifest
  construction**
  (spreading
  emptyManifest
  + adding
  traits)
  rather
  than a
  helper.
  Acceptable
  for
  one-off
  tests;
  if more
  invalid-
  manifest
  scenarios
  emerge,
  a
  `makeInvalid
  Manifest`
  helper
  could
  extract
  the
  pattern.

- **runPatch
  --output
  refusal
  test
  relies
  on
  writeManifestFile's
  "refusing
  to
  overwrite"
  string** —
  if that
  error
  message
  ever
  changes,
  the
  test
  breaks.
  Acceptable
  given
  the
  error
  is
  user-
  facing
  and
  intentionally
  stable.

## Future Qs

1. **Chat-
   surface
   coverage
   pass**
   (M-maint.
   coverage.
   chat)
   to
   close
   lines
   291-292,
   348-349,
   407,
   415-422
   via
   per-chunk
   stub
   sequences.

2. **Document
   the
   `emptyManifest`
   throw
   conditions**
   in a
   comment
   so a
   future
   maintenance
   pass
   can
   craft
   an
   explicit
   trigger.

3. **Add
   makeInvalid
   Manifest
   helper**
   if
   future
   tests
   need
   manifests
   that
   pass
   schema
   but
   fail
   validation
   (duplicate
   entity,
   duplicate
   trait
   shadowing
   built-in,
   etc.).

4. **Extend
   the
   M-maint.
   coverage
   pattern**
   to
   other
   files
   below
   90%
   statements
   (next
   candidates:
   gateway.ts
   at
   81.91%
   could
   be a
   third
   maintenance
   pass).

5. **Track
   per-
   milestone
   coverage
   delta**
   in a
   coverage-
   trend
   doc so
   the
   maintenance-
   pass
   ROI
   is
   visible
   across
   the
   M4.15
   series.
