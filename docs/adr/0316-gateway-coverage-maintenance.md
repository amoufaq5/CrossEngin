# ADR-0316: gateway.ts coverage maintenance pass (M4.15.ac)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0315 (M4.15.ab commands.ts coverage pass), ADR-0312 (M4.15.y apply.ts coverage pass), M-maint.coverage |

## Context

Third M-maint.
coverage milestone
in the M4.15.x
series after
M4.15.y (apply.ts
74.58% → 92.24%)
and M4.15.ab
(commands.ts
86.46% → 93.64%).
gateway.ts sat at
81.91% statements
after M4.15.x
shipped gh-summary
on prune-
idempotency —
above the 80%
threshold but the
lowest non-chat
file in the
architect-cli
tree.

Notable gaps in
the v8 coverage
report:

- Line 169:
  PostgresIdempotency
  Store construction
  when no
  idempotencyStore
  Override but
  pgConnection is
  available (every
  existing prune-
  idempotency test
  provides
  idempotencyStore
  Override directly).
- Lines 377-385:
  runGatewayStart
  serverFactory
  rejection error
  path (listen
  failure).
- Lines 527-552:
  runGatewayStart
  buildRuntime
  in-memory branch
  when no
  runtimeOverride
  (existing tests
  always provide
  runtimeOverride).
- Lines 568-579,
  586-596:
  runGatewayStart
  PG-mode branch +
  waitForShutdown
  Signal helper
  (require real
  signal handling).

## Decision

Add 5 new tests
targeting the
cheap wins via
the existing
fakePgConnection
and
fakeServerFactory
fixtures:

1. **prune-
   idempotency
   with
   pgConnection
   Override only**:
   no
   idempotencyStore
   Override
   provided, so
   the production
   path constructs
   a real
   PostgresIdempotency
   Store from
   the injected
   connection
   (line 169
   branch).
   Verifies the
   normal-flow
   delete count.

2. **prune-
   idempotency
   PG-env-missing
   exit**: no
   override + no
   PG env → exit
   1 with PG-
   required error
   (catch
   branch at
   lines 163-
   167).

3. **runGatewayStart
   serverFactory
   rejection**:
   factory
   throws
   EADDRINUSE-
   style error
   → printError
   with "failed
   to listen"
   message +
   exit 1
   (lines 377-
   385).

4. **runGatewayStart
   --in-memory
   without
   runtimeOverride**:
   forces
   buildRuntime
   to run the
   in-memory
   branch (lines
   527-552)
   constructing
   InMemoryRouteRegistry
   +
   InMemoryPrincipalResolver
   +
   InMemoryIdempotencyStore
   +
   InMemoryRateLimit
   Checker. Uses
   fakeServerFactory
   to avoid
   actually
   listening +
   waitForShutdown
   returning
   immediately
   to exercise
   the
   shutdown
   path.

5. **runGatewayStart
   --in-memory
   --format=
   json**:
   verifies
   the non-
   human format
   branch
   emits the
   "kind":
   "started"
   JSON
   envelope at
   startup
   (lines 424-
   431).

## Coverage
delta

| Metric | M4.15.ab | M4.15.ac | Δ |
|---|---|---|---|
| Statements | 81.91% | 89.50% | +7.59pp |
| Branches | 79.10% | 81.29% | +2.19pp |
| Functions | 87.50% | 87.50% | 0 |
| Lines | 81.91% | 89.50% | +7.59pp |

Function-count
unchanged
because the
2 uncovered
functions
(`beforeHandle`
at line 581
+
`waitForShutdown
Signal` at
line 586)
require real
HTTP request
handling + OS
signal
handling
respectively
— neither
testable
without
substantial
fixture
infrastructure.

Remaining
uncovered:
lines 568-
579 (PG-mode
buildRuntime
branch
constructing
PostgresRoute
Registry +
PostgresRate
LimitChecker
+
PostgresIdempotency
Store from a
real PG
connection)
+
line 586-
596
(waitForShutdown
Signal
function
that
hooks
SIGINT +
SIGTERM).
Defer to a
PG-mode
maintenance
pass when
adequate
PG-stub
infrastructure
is built.

## Rejected
alternatives

1. **Add
   PG-mode
   buildRuntime
   tests
   covering
   lines
   568-
   579** —
   would
   require
   constructing
   a fake
   PgConnection
   that
   satisfies
   PostgresRoute
   Registry's
   schema-
   probing
   queries +
   PostgresRateLimit
   Checker's
   index-
   existence
   queries +
   the
   advisory-
   lock
   contracts.
   Defer to
   a
   substantial
   PG-stub
   pass.

2. **Add a
   `signalRegistrar`
   injection
   to
   `waitForShutdown
   Signal`** —
   would
   require
   refactoring
   the
   signal-
   handling
   surface
   for
   coverage
   alone.
   Acceptable
   to leave
   uncovered
   given
   it's
   exclusively
   reached
   in
   production
   when
   `ctx.wait
   ForShutdown`
   is
   undefined
   (always
   true in
   tests).

3. **Add
   chat-
   surface
   coverage
   tests
   instead**
   — chat.ts
   is
   already
   at
   92.64%
   lines;
   gateway.ts
   was the
   lower-
   priority
   target.

4. **Use
   vi.mock
   to stub
   the
   InMemoryRoute
   Registry
   /
   InMemoryRate
   LimitChecker
   constructors**
   — brittle
   couples
   tests to
   internal
   module
   structure;
   real
   constructions
   via the
   buildRuntime
   path are
   honest.

5. **Co-
   locate
   the
   M4.15.ac
   tests
   inside
   existing
   describe
   blocks**
   — single
   maintenance
   block
   matches
   the
   M4.15.y
   /
   M4.15.ab
   precedent
   and
   makes
   the
   intent
   clear in
   test
   output.

6. **Mark
   PG-mode
   buildRuntime
   lines
   with
   `/* c8
   ignore
   */`** —
   would
   hide
   legitimate
   production
   code;
   accept
   the
   gap
   honestly.

## Drawbacks

- **gateway.ts
  still
  has
  10.5%
  uncovered**
  (lines
  568-
  579 +
  586-
  596).
  Documented
  as
  intentional
  trade-
  off
  awaiting
  PG-stub
  infrastructure.

- **The
  serverFactory
  rejection
  test
  uses
  a
  contrived
  EADDRINUSE
  error
  message**
  — actual
  EADDRINUSE
  errors
  on
  Linux
  come
  with
  errno
  codes;
  the
  test's
  string
  matching
  is
  loose.

- **The
  in-memory
  buildRuntime
  test
  doesn't
  verify
  the
  exact
  runtime
  components
  constructed**
  — only
  that
  the
  flow
  exits 0
  +
  prints
  the
  expected
  startup
  message.
  Acceptable;
  the
  GatewayRuntime
  internal
  shape
  is
  tested
  in the
  api-
  gateway-
  runtime
  package.

## Future Qs

1. **PG-
   mode
   coverage
   pass**
   to close
   lines
   568-579
   via a
   PG-stub
   that
   satisfies
   PostgresRoute
   Registry
   +
   PostgresRateLimit
   Checker
   +
   PostgresIdempotency
   Store
   construction
   contracts.

2. **Add
   signalRegistrar
   injection
   to
   waitForShutdown
   Signal**
   for
   waitForShutdown
   Signal
   coverage
   (already a
   pattern
   elsewhere
   in
   architect-
   cli for
   housekeeping
   watch
   mode).

3. **Extend
   the
   M-maint.
   coverage
   pattern
   to
   tenant.ts**
   (88.93%
   statements)
   for a
   fourth
   pass.

4. **Track
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
   ROI is
   visible
   across
   the
   M4.15
   series
   (mentioned
   in
   ADR-0315
   future
   Qs;
   still
   not
   shipped).

5. **Document
   the
   waitForShutdown
   Signal
   contract**
   in a
   comment
   so
   future
   coverage
   passes
   can
   construct
   a
   matching
   fake.
