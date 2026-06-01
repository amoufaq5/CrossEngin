# ADR-0317: commands.ts chat-surface coverage maintenance pass (M4.15.ad)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0315 (M4.15.ab commands.ts pass — deferred chat-surface gaps), ADR-0316 (M4.15.ac gateway.ts pass), M-maint.coverage |

## Context

Follow-up to ADR-0315
which deferred chat-
surface coverage gaps
to a separate pass.
After M4.15.ab,
commands.ts sat at
93.64% statements
with the remaining
6.36% concentrated in
chat-loop internal
state transitions
(lines 291-292
interactive
approver, 348-349
ProviderBuilder
rethrow, 407 router
suffix, 415-422
outer catch + finally
pgConnection close).

This pass targets
the tractable chat-
loop gaps via
StubProvider
extensions that
throw mid-stream
plus targeted flag-
validation tests.

## Decision

Add 6 new tests
under the existing
"commands.ts
coverage
maintenance
(M4.15.ab)"
describe block:

1. **--max-tool-
   iterations
   validation
   (lines 271-273)**:
   non-numeric flag
   value → exit 2
   with "invalid
   --max-tool-
   iterations".
2. **--allow-file-
   write + --one-
   shot without
   --auto-approve-
   writes (lines
   284-289)**: exit
   2 with explicit
   error explaining
   one-shot mode
   requires auto-
   approve.
3. **Provider
   throws mid-
   stream Error
   (lines 415-
   416)**: outer
   catch fires
   with `chat:
   <error.message>`
   + exit 1. Uses
   ThrowingProvider
   class extending
   StubProvider
   with an
   override of
   `complete()`
   that throws.
4. **Provider
   throws non-
   Error (String
   fallback)**:
   verifies the
   `String(err)`
   branch when
   thrown value
   isn't an
   Error
   instance.
5. **JSON
   envelope on
   success
   preserves
   providerKind=
   single +
   availableProviders**:
   exercises the
   non-human
   format branch
   at lines 396-
   402 with
   providerOverride
   (which forces
   providerKind=
   "single" +
   availableProviders=
   ["override"]).
6. **Human-
   format
   success
   session-
   ended line
   without
   router
   suffix
   (line 410)**:
   verifies the
   non-router
   path of the
   `providerSuffix
   ===
   "router"` ?
   ternary at
   line 406.

### JSON
streaming
quirk

Initial test
attempted to
`JSON.parse`
the final
envelope but
`printJson`
pretty-prints
with 2-space
indent, so
chat's
streaming
JSON output
is multi-
line per
envelope.
Switched to
string
matching
(`expect(
output).
toContain(
'"provider
Kind":
"single"'
)`) which
is robust
against the
pretty-
print
newlines.

This is a
test-side
workaround;
the actual
chat code
emits valid
JSON
(streaming
NDJSON-of-
pretty-
printed-
envelopes
isn't ideal
but matches
the
existing
M4.14
behavior).

## Coverage
delta

| Metric | M4.15.ac | M4.15.ad | Δ |
|---|---|---|---|
| Statements | 93.64% | 94.19% | +0.55pp |
| Branches | 84.92% | 85.49% | +0.57pp |
| Functions | 100.00% | 100.00% | 0 |
| Lines | 93.64% | 94.19% | +0.55pp |

The
modest +0.55pp
delta reflects
that many new
tests exercise
surfaces
(like the
provider-
throw catch)
that were
already
partially
covered by
other paths.
The provider-
throw test
specifically
covers lines
415-416 (the
outer catch
message
formatting)
which the
"no provider
keys"
existing
test did
NOT exercise
(that test
hits an
earlier
return path).

## Remaining
uncovered

Lines 78-80
(runInit
emptyManifest
catch),
120-129
(validateManifest
throw path
— effectively
dead code
since
tryValidateManifest
catches the
only
throwable
ManifestValidation
Error already),
291-292
(interactive
approver
when --allow-
file-write +
not --one-
shot + not
--auto-
approve —
requires
interactive
lineReader
that hangs
gracefully),
348-349
(ProviderBuilder
rethrow when
error is not
NoProviders
Configured
Error —
buildChatCompleter
internal),
407 (router
suffix —
requires
both
ANTHROPIC +
OPENAI keys
forcing
buildChatCompleter
to return
providerKind=
"router"),
419-422
(finally
pgConnection
close —
requires
--persist +
valid PG
env).

These all
require
either
substantial
fixture
infrastructure
(real PG
stub
satisfying
PostgresTranscript,
real
buildChatCompleter
with multi-
key env, or
an
interactive
lineReader
that returns
controlled
empty
sequences)
OR are
defensive
dead code
(78-80,
120-129).

## Rejected
alternatives

1. **Inject
   a
   `transcriptOverride`
   that wraps
   a fake
   pgConnection
   exposing
   the close
   path** —
   the chat
   code only
   sets the
   internal
   pgConnection
   when
   transcript
   is
   undefined
   AND
   --persist
   is set,
   so
   transcriptOverride
   bypasses
   that
   branch
   entirely.
   Defer.

2. **Add a
   `providerBuilder
   Override`
   that
   returns
   providerKind=
   "router"
   directly**
   — would
   require
   adding a
   new
   injection
   point to
   commands.ts
   just for
   one line
   of
   coverage.
   Not
   worth
   the
   surface
   expansion.

3. **Mark
   the 78-
   80 +
   120-129
   defensive
   lines
   with
   `/* c8
   ignore */`
   ** — would
   force
   higher
   coverage
   but hide
   legitimate
   defensive
   guards.
   Accept
   the gap
   honestly.

4. **Use
   vi.mock
   to stub
   buildChatCompleter**
   — brittle
   and
   couples
   tests to
   the
   internal
   chat
   helper
   API.

5. **Set
   real
   PG env
   vars +
   --persist
   in a
   test
   that
   gracefully
   handles
   the
   connection
   failure**
   — would
   exercise
   the
   PG env
   validation
   branch
   (line
   368-372)
   but not
   reach
   line
   419-422
   since
   pgConnection
   creation
   throws
   before
   the
   close
   path
   can
   fire.

## Drawbacks

- **Small
  +0.55pp
  delta**
  reflects
  the
  diminishing-
  returns
  reality
  of
  coverage
  passes —
  the
  remaining
  gaps are
  the
  hardest
  to
  close.

- **6
  test-
  additions
  for
  +0.55pp**
  has a
  worse
  ROI
  than the
  M4.15.ab
  pass
  (14
  tests
  for
  +7.18pp).
  Still
  useful
  for
  hardening
  the
  outer-
  catch
  paths
  against
  future
  regression
  but the
  next
  maintenance
  pass
  should
  pivot
  to a
  different
  file
  (chat.ts
  is bigger
  +
  separate).

- **`ThrowingProvider`
  class
  is
  defined
  inline
  inside
  each
  test
  rather
  than as
  a
  fixture**.
  Acceptable
  given
  it's a
  one-line
  override
  of
  `complete()`.

- **JSON-
  streaming
  test
  uses
  string
  matching
  instead
  of JSON
  parsing**
  due to
  the
  multi-
  line-
  per-
  envelope
  output
  shape.

## Future Qs

1. **Fixture
   for
   throwing
   provider
   chunks**
   if more
   chat-
   error
   tests
   land —
   extract
   `ThrowingProvider`
   into
   a
   reusable
   helper.

2. **Add
   a
   `providerInfoOverride`
   injection
   point**
   to
   exercise
   line 407
   router
   suffix
   without
   spinning
   up
   real
   ProviderBuilder
   with
   both
   keys.

3. **Document
   the
   defensive
   nature
   of
   lines
   120-129**
   in a
   comment
   so
   future
   coverage
   passes
   know
   not to
   bother.

4. **Pivot
   M-
   maint.
   coverage**
   to
   tenant.ts
   (88.93%
   statements)
   for
   the
   next
   pass
   —
   higher
   ROI
   than
   continued
   commands.ts
   work.

5. **Track
   the
   M-maint.
   coverage
   pattern
   ROI**
   in
   ADR-0315/
   0316
   /this
   ADR
   future
   Qs;
   the
   pattern
   is
   showing
   diminishing
   returns
   per
   pass
   as the
   easy
   gaps
   close.
