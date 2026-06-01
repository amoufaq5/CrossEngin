# ADR-0318: tenant.ts coverage maintenance pass (M4.15.ae)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0317 (M4.15.ad chat-surface), ADR-0316 (M4.15.ac gateway.ts), ADR-0315 (M4.15.ab commands.ts), ADR-0312 (M4.15.y apply.ts), M-maint.coverage |

## Context

Fifth M-maint.
coverage milestone
in the M4.15.x
series. After
M4.15.aa shipped
tenant-housekeeping
gh-summary,
tenant.ts sat at
89.69% statements
— the lowest non-
chat file in
architect-cli
beyond gateway.ts
(now 89.50% post-
M4.15.ac).

Many uncovered
groups in tenant.ts
are PG-env-missing
catch branches that
tests bypass via
pgConnectionOverride
(production paths
construct real PG
connections; test
paths inject fake
ones). Other gaps:
flag mutual-
exclusivity checks
that exit 2 before
reaching PG.

## Decision

Add 8 new tests
under a new
"tenant.ts
coverage
maintenance
(M4.15.ae)"
describe block:

### PG-env-
missing exits
(no
pgConnectionOverride)

1. **tenant
   housekeeping
   PG-env-missing
   (lines 238-
   249)**: no
   pgConnection
   Override + no
   PG env →
   parsePgEnvConfig
   throws →
   catch branch
   prints "tenant
   housekeeping:
   requires PG
   env vars" +
   exit 1.

2. **tenant
   policies PG-
   env-missing
   (lines 857-
   868)**: same
   pattern,
   "tenant
   policies:"
   prefix.

3. **tenant
   policies
   --diff PG-
   env-missing
   (lines 954-
   965)**: same
   pattern,
   different
   code path
   inside the
   diff
   handler.

### Mutual-
exclusivity
checks
(pre-PG
validation)

4. **--diff +
   --watch
   rejected
   (lines 175-
   180)**: exit
   2 with
   explanatory
   error
   explaining
   v1
   diff-loop
   layout
   garbling.

5. **--tenant
   + --all-
   tenants
   rejected
   (lines
   127-132)**:
   exit 2.

6. **policies
   --diff +
   --vs-tier
   rejected
   (lines
   800-804)**:
   both
   define
   the RHS;
   pick
   one.

7. **policies
   --vs-tier
   +
   --explain
   rejected
   (lines
   820-825)**:
   synthetic
   RHS
   already
   answers
   the
   what-if;
   --explain
   doesn't
   compose.

8. **policies
   --add-
   tenant
   without
   --diff
   rejected
   (lines
   806-811)**:
   --add-
   tenant
   extends
   --diff's
   RHS
   chain.

## Coverage
delta

| Metric | M4.15.ad | M4.15.ae | Δ |
|---|---|---|---|
| Statements | 89.69% | 91.48% | +1.79pp |
| Branches | 86.75% | 86.90% | +0.15pp |
| Functions | 91.93% | 91.93% | 0 |
| Lines | 89.69% | 91.48% | +1.79pp |

Function-
count
unchanged
because the
uncovered
functions
are all
`closeConn`
async
closures
that fire
ONLY when
PG conn is
constructed
successfully
— the env-
missing
exits we
test
return
BEFORE
the
closeConn
assignment.

### Why
the modest
+1.79pp

The
remaining
8.5%
uncovered
in
tenant.ts
is
dominated
by:

1. **Per-
   field
   switch-
   case
   branches**
   (lines
   488-518)
   in
   `readGatewayField`
   /
   `readRetentionField`
   for
   alert
   evaluation
   — each
   case
   requires
   an
   alert
   spec
   targeting
   that
   specific
   field.
   Coverage
   would
   require
   an
   "alert
   per
   field"
   exhaustive
   test
   set.

2. **Watch-
   mode
   error-
   render
   paths**
   (lines
   344-353,
   396-401)
   — fire
   when
   gather()
   throws
   under
   --watch.
   Requires
   provider
   stub
   that
   throws
   mid-tick.

3. **Multi-
   tenant
   diff
   internal
   paths**
   (885-887,
   1149-
   1151,
   1229-
   1231,
   1300-
   1302,
   etc.) —
   reached
   only
   when
   specific
   tenant-
   ID
   resolution
   combinations
   succeed
   /
   fail.

## Rejected
alternatives

1. **Add
   per-
   field
   alert
   tests
   covering
   lines
   488-518**
   — would
   need 10+
   alert-
   per-
   field
   tests
   for
   gateway
   +
   retention
   field
   sets.
   Defer
   to a
   field-
   alert-
   specific
   pass.

2. **Add
   watch-
   mode
   error-
   render
   tests
   for
   lines
   344-
   353,
   396-
   401**
   — would
   require
   provider
   stubs
   that
   throw
   mid-
   tick
   under
   --watch
   +
   carefully-
   timed
   abort.
   Substantial
   fixture
   work.

3. **Use
   pgConnectionOverride
   with a
   fake
   conn
   that
   closes
   cleanly**
   to
   cover
   the
   closeConn
   async
   closures
   (lines
   241-
   243,
   860-
   862,
   etc.)
   — the
   closures
   are
   assigned
   but
   only
   called
   in
   finally
   blocks
   after
   action
   completion.
   Existing
   tests
   using
   pgConnectionOverride
   already
   exit
   without
   triggering
   the
   parsePgEnvConfig
   /
   createNodePgConnection
   path
   that
   sets
   the
   closeConn
   ref.

4. **Add
   `--add-
   tenant
   +
   --vs-
   tier`
   mutual
   exclusivity
   test
   (lines
   813-
   818)**
   — that
   branch
   is
   effectively
   unreachable
   because
   `--add-
   tenant`
   requires
   `--diff`
   (line
   806-
   811
   check
   fires
   first)
   AND
   `--diff
   +
   --vs-
   tier`
   conflict
   (line
   800-
   804
   check
   fires
   first).
   Document
   as
   dead-
   code-
   under-
   current-
   check-
   ordering.

5. **Mark
   dead-
   code
   branches
   with
   `/* c8
   ignore
   */`**
   —
   hides
   legitimate
   defense-
   in-
   depth
   coverage;
   accept
   the
   gap
   honestly.

6. **Co-
   locate
   tests
   inside
   existing
   per-
   command
   describe
   blocks**
   —
   single
   maintenance
   block
   matches
   the
   M4.15.y
   /
   .ab /
   .ac /
   .ad
   precedent
   making
   intent
   clear
   in
   test
   output.

## Drawbacks

- **Modest
  +1.79pp
  delta**
  reflects
  the
  diminishing-
  returns
  reality
  consistent
  with
  M4.15.ad
  (+0.55pp).
  The
  M-maint.
  coverage
  pattern
  is
  approaching
  the
  point
  of
  diminishing
  returns —
  each
  successive
  pass
  yields
  smaller
  gains as
  the
  remaining
  gaps
  require
  more
  invasive
  fixture
  infrastructure.

- **The
  --add-
  tenant +
  --vs-
  tier
  check
  at
  lines
  813-
  818 is
  effectively
  unreachable**
  under
  current
  check-
  ordering.
  Either
  reorder
  the
  checks
  to
  make
  it
  reachable
  OR
  remove
  the
  defense-
  in-
  depth
  branch
  (the
  former
  is the
  right
  fix
  if
  operators
  can
  trigger
  it via
  obscure
  flag
  combos).

- **Function-
  count
  coverage
  unchanged**
  (91.93%
  → 91.93%)
  because
  the
  closeConn
  closures
  remain
  uncovered
  —
  requires
  tests
  that
  exit
  via the
  finally
  path
  after
  real-
  conn-
  like
  setup.

- **Per-
  field
  alert
  coverage
  deferred**
  — the
  most
  significant
  uncovered
  surface
  area
  (lines
  488-518
  + 504-
  519)
  requires
  a
  separate
  pass.

## Future Qs

1. **Per-
   field
   alert
   coverage
   pass**:
   write 10+
   tests
   covering
   each
   field
   in
   readGatewayField
   +
   readRetentionField
   switch
   statements.
   Highest-
   ROI
   remaining
   target
   for
   tenant.ts.

2. **Reorder
   check
   precedence**
   so
   `--add-
   tenant +
   --vs-tier`
   (line
   813)
   becomes
   reachable
   OR
   remove
   the
   branch
   as
   defense-
   in-
   depth.

3. **Add
   closeConn
   coverage
   tests**
   via
   pgConnectionOverride
   that
   wraps
   the
   conn-
   close
   path
   — but
   currently
   the
   override
   skips
   the
   conn-
   construction
   entirely,
   so
   closeConn
   never
   gets
   assigned.

4. **Watch-
   mode
   error-
   render
   coverage**
   for
   lines
   344-
   353,
   396-
   401
   via
   throwing
   gather()
   under
   --watch.

5. **Track
   M-maint.
   coverage
   ROI**:
   apply.ts
   +28.86pp /
   14
   tests
   →
   commands.ts
   +7.18pp /
   14
   tests
   →
   gateway.ts
   +7.59pp /
   5
   tests
   →
   commands
   (chat)
   +0.55pp /
   6
   tests
   →
   tenant.ts
   +1.79pp /
   8
   tests.
   Pattern
   suggests
   the
   M-maint.
   coverage
   series
   should
   either
   wind
   down
   or
   pivot
   to
   targeted
   fixture-
   infrastructure
   work
   that
   unlocks
   the
   remaining
   gaps
   in
   one
   substantial
   pass
   (e.g.,
   a real-
   PG-like
   stub).
