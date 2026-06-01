# ADR-0311: `gateway prune-idempotency --format gh-summary`

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0310 (M4.15.w apply gh-summary), ADR-0309 (M4.15.v workflow validate gh-summary), M4.12 (prune-idempotency baseline) |

## Context

The M4.15.x stretch
has extended gh-
summary Markdown
to multiple CI-
oriented surfaces:
workflow validate
(M4.15.v), apply
(M4.15.w). The
`gateway prune-
idempotency`
action is another
CI-runnable
maintenance
operation: it
DELETEs expired
rows from
meta.gateway_
idempotency_
records on a
scheduled basis.

Before M4.15.x it
emitted only json
+ human. Operators
running `gateway
prune-idempotency`
as a periodic CI
job (e.g., nightly
GitHub Actions
workflow) got
either a JSON
blob or a one-
line success
message — no
emoji-prefixed
verdict signaling
in the Actions
step summary UI.

## Decision

Add `--format gh-
summary` to
`runGatewayPrune
Idempotency`,
covering both
dry-run and
actual-delete
paths. Shared
`formatPrune
IdempotencyGh
Summary` renderer
takes a dryRun
flag, asOf
timestamp, count,
and scope; emits
matching shape
for both modes
with verdict
differing per
mode.

### Dry-run
path

Title `## Gateway:
prune idempotency
(dry-run)` (suffix
distinguishes from
the actual-delete
title). **Would
delete:** label
on the count
line. No verdict
emoji — operator
hasn't decided
yet; dry-run is
informational.
Italic footer
`_Dry-run: no
records deleted.
Re-run without
--dry-run to
delete._` nudges
toward the
follow-up
command (same
ADR-0310
precedent).

### Actual-
delete path

Title `## Gateway:
prune idempotency`.
**Deleted:**
label on the count
line. Verdict
branches by count:

- count > 0 →
  `:white_check_
  mark: **Prune
  succeeded** —
  N record(s)
  deleted.`
- count === 0 →
  `:white_check_
  mark: **Nothing
  to prune** —
  0 records
  matched the
  scope.`

Both are success
verdicts (the
prune is
operationally
idempotent — 0
deleted is the
same outcome as
N from the gate
perspective).
The distinct
phrasing avoids
"Prune
succeeded — 0
records
deleted" which
operators
might
misinterpret
as "the scope
filter
swallowed
everything".

### Scope
line

Emitted only
when at least
one scope field
is set:

```
**Scope:** operationId=`tenants.create` | method=`POST` | limit=100
```

Order: operationId,
method, limit
(matches the
flag declaration
order in the
help text). `|`
separator
matches the
M4.15.t
sessions-list
cost-summary
header
convention.

Each scope value
wrapped in
backticks for
identifier
emphasis, except
`limit` which is
numeric.

Omitting the
scope line when
empty keeps the
header tight in
the common case
(operators
running a bare
`prune-
idempotency`
without scope
get a 3-line
header instead
of 4).

## Rejected
alternatives

1. **Include
   a `--limit`
   warning
   when count
   == --limit
   value
   ("hit the
   limit;
   re-run for
   more")** —
   useful but
   requires
   knowing the
   pre-limit
   count.
   Operators
   wanting
   that can
   re-run
   with
   --dry-
   run.

2. **Use
   `:hourglass:`
   for
   dry-run
   instead
   of no
   emoji** —
   would
   signal
   "still
   waiting"
   but
   dry-run
   is not
   pending,
   it's
   informational.

3. **Emit
   a
   `:warning:`
   verdict
   when
   count
   > 1000
   ("large
   prune")**
   — large
   prunes
   aren't
   error
   conditions
   for an
   idempotency
   table
   designed
   to age
   out.
   Operators
   wanting a
   threshold
   gate
   should
   pipe
   gh-
   summary
   through
   their
   own
   check.

4. **Show
   per-
   operation
   /
   per-
   method
   breakdown
   when no
   scope
   set** —
   would
   require
   GROUP
   BY
   query
   not
   currently
   issued.
   Defer.

5. **Use
   `:tada:`
   for
   Nothing-
   to-prune
   verdict** —
   too
   celebratory
   for a
   noop.
   Stick
   with
   `:white_
   check_
   mark:`.

6. **Match
   the
   human-
   format
   phrasing
   exactly
   ("deleted
   N expired
   idempotency
   record(s)")
   ** — too
   verbose
   for
   gh-
   summary
   verdict.
   Distilled
   to
   "Prune
   succeeded
   — N
   record(s)
   deleted."

7. **Skip
   `asOf`
   timestamp
   in the
   header**
   — would
   make
   the
   gh-
   summary
   non-
   reproducible
   in
   audit
   trails.
   The
   timestamp
   is a
   key
   gate
   detail.

## Drawbacks

- **Two
  success
  verdicts
  ("Prune
  succeeded"
  vs.
  "Nothing
  to
  prune")
  means
  CI
  scripts
  grepping
  for a
  single
  string
  need to
  handle
  both
  cases**
  — accept
  the
  duality;
  the
  distinct
  phrasing
  is
  worth
  it for
  readability.

- **Dry-
  run with
  --limit
  showing
  the
  preview
  count
  may
  underestimate
  the real
  population**
  — operators
  often
  set
  --limit
  for
  batch
  safety
  in
  actual
  apply,
  not for
  dry-run
  preview.
  Behavior
  inherited
  from
  M4.12
  baseline.

- **Scope
  line
  with
  only
  `limit`
  set
  looks
  oddly
  isolated
  (no
  `operationId`
  or
  `method`)
  ** —
  acceptable;
  operators
  using
  bare
  `--limit`
  understand
  the
  semantic.

- **No
  cohort
  filters
  (only
  the
  3
  existing
  scope
  flags)
  ** —
  out of
  scope
  for
  M4.15.x;
  prune-
  idempotency
  isn't a
  list
  surface.

## Future Qs

1. **`--include-
   breakdown`
   group-by
   query
   for
   prune
   reports**
   showing
   what
   operationId/
   method
   accounts
   for the
   bulk of
   prunes.

2. **`--format
   csv`** for
   prune
   results
   ("date,
   scope,
   count")
   for
   pipelines
   archiving
   prune
   history.

3. **`--max-
   age <N>
   days`**
   flag to
   prune
   expired-
   for-more-
   than-N-
   days
   (currently
   prunes
   on
   expires_
   at < now
   only —
   any
   expired
   row
   matches).

4. **Per-
   batch
   summary
   when
   the
   delete
   is
   batched
   (operator-
   visible
   total +
   per-
   batch
   counts)
   ** —
   currently
   prune-
   idempotency
   does
   a
   single
   DELETE
   with
   LIMIT.
   If
   that
   evolves
   to
   loop-
   until-
   exhausted,
   gh-
   summary
   could
   show
   per-
   iteration
   progress.

5. **`gateway
   housekeeping
   --format
   gh-summary`**
   for the
   broader
   housekeeping
   dashboard.

6. **Mirror
   to
   `retention
   prune
   --format
   gh-
   summary`**
   if the
   retention
   side
   doesn't
   already
   have it.
