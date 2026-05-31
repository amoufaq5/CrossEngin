# ADR-0305: `tenants list --max-policy-count N` inverse cohort filter

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0298 Q1 (closes), ADR-0298 (M4.15.k --min-policy-count) |

## Context

ADR-0298 Q1
deferred
"`--max-policy-
count N`
counterpart
for inverse
cohort
queries".

M4.15.k
shipped
`--min-policy-
count N` for
the "over-
customized
tenants"
cohort. The
inverse case
("under-
customized" /
"platform-
default
tenants") had
to be done
via:

1. `tenants
   list
   --include-
   policy-
   count
   --format
   json` →
   jq to
   filter
   `policy_
   count <=
   N`.
2. No
   server-
   side
   filter
   meant
   transferring
   every
   tenant
   row
   then
   discarding
   most.

## Decision

Add `--max-
policy-count
<N>` to
`tenants
list`.
Server-side
filter:
`COALESCE
(pc.policy_
count, 0) <=
$N`. Reuses
the M4.15.k
LEFT JOIN
infra.

### N semantics

- `--max
  0` →
  tenants
  on
  PURE
  platform
  defaults
  (no
  overrides
  at
  all).
  Useful
  for
  "untouched
  tenants
  audit".
- `--max
  5` →
  tenants
  with
  ≤ 5
  overrides
  (lightly-
  customized
  cohort).
- N >= 0
  is
  valid
  (unlike
  --min
  where
  N=0
  is
  no-op
  and
  rejected).

### Validation

- N
  must
  be
  non-
  negative
  integer
  (>=
  0).
- Negative
  rejected
  ("expected
  a non-
  negative
  integer
  >= 0").
- Floats
  rejected
  via
  same
  round-
  trip
  String(
  parsed)
  !==
  input
  check
  as
  --min.
- Non-
  numeric
  rejected.

### Range
composition

`--min
3
--max
10`
→
tenants
with
3-10
overrides.
Both
bounds
in
WHERE
via
AND.
Single
shared
JOIN.

### Range
consistency
check

`--min
> --max`
exits
2 with
"--min-
policy-
count
(10)
cannot
exceed
--max-
policy-
count
(3)".
Almost
always
a
typo;
silent
empty
result
would
confuse.

### Help
text
update

`--max-
policy-
count
<N>` +
range
semantic
+ typo-
catcher
documented
inline.

## Rejected
alternatives

1. **Allow
   `--max
   0`
   silently
   to
   mean
   "no
   limit"**
   —
   conflates
   with
   the
   "no
   overrides"
   semantic.
   N=0
   has a
   meaningful
   interpretation;
   "no
   limit"
   is
   omission.

2. **Use
   `--policy-
   count-
   range
   min,max`
   as a
   single
   flag**
   —
   ranges
   work
   but
   composing
   two
   flags
   is
   simpler
   and
   doesn't
   require
   range
   parsing.

3. **Treat
   --min
   >
   --max
   as
   intentional
   empty
   result**
   —
   silent
   typos
   surprise.
   Reject
   loudly.

4. **Reject
   N=0
   for
   --max
   to
   match
   --min
   semantics**
   —
   N=0 is
   meaningful
   for
   --max
   ("pure
   platform"
   tenants);
   asymmetric
   validation
   reflects
   asymmetric
   semantics.

5. **Add
   `--exact-
   policy-
   count
   N`
   shorthand
   for
   `--min N
   --max
   N`** —
   over-
   engineered.
   Operators
   can
   use
   both
   flags.

6. **Server-
   side
   HAVING
   instead
   of
   WHERE**
   — same
   reasoning
   as
   M4.15.k.
   The
   JOIN
   subquery
   pre-
   aggregates,
   so
   WHERE
   on the
   COALESCE
   expression
   is the
   correct
   shape.

7. **Apply
   `--min`/
   `--max`
   on
   `tenants
   get`
   too** —
   doesn't
   make
   sense
   (get is
   single-
   tenant;
   no
   cohort
   filtering).

## Drawbacks

- **`--max
  0` =
  "no
  overrides"
  overlaps
  with
  hypothetical
  inverse-
  has-
  overrides
  flag** —
  but
  `--has-
  overrides`
  is the
  positive
  form;
  no
  current
  flag is
  its
  inverse.
  `--max
  0`
  serves
  that
  role.

- **Range
  validation
  is one-
  way**
  (--min
  > --max
  rejected,
  but
  --min
  ==
  --max
  is the
  exact-
  count
  case
  which
  is
  allowed).
  Operators
  using
  `--min
  3 --max
  3` get
  exactly-3-
  policy
  tenants
  — that's
  the
  documented
  semantic
  but no
  alias
  flag
  yet.

- **Composition
  with
  `--include-
  policy-
  count`
  is
  implicit
  the
  same
  way as
  --min**
  — JOIN
  shared,
  WHERE
  bound
  applied
  before
  the
  COALESCE
  outer
  column
  exposure.

## Future Qs

1. **`--exact-
   policy-
   count
   N`
   shorthand**
   if
   operator
   demand
   for
   `--min
   N
   --max
   N`
   emerges
   (cohort
   "tenants
   with
   exactly
   3
   overrides").

2. **`--max-
   policy-
   count-
   on-
   table
   <table>
   =<N>`**
   per-
   table
   inverse
   (same
   future
   Q as
   --min
   per-
   table).

3. **Same
   pattern
   on
   tenant
   policies
   --diff**
   if
   operator
   demand
   for
   axis-
   bound
   filtering
   emerges.

4. **`--no-
   policies`
   alias
   for
   --max
   0** —
   readable
   shorthand.
   Defer.

5. **CSV
   output
   includes
   `policy_
   count`
   automatically
   when
   `--max-
   policy-
   count`
   set** —
   currently
   requires
   --include-
   policy-
   count.
   Defer.
