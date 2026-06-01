# ADR-0309: `workflow validate --format gh-summary`

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0256 (workflow validate baseline), ADR-0292 (M4.15.e gh-summary pattern), ADR-0307 (M4.15.t sessions list pivot) |

## Context

The M4.15.t pivot
extended output-
format polish from
the diff family to
list-style surfaces
(sessions, gateway
routes). `workflow
validate` is another
CLI surface that
benefits from gh-
summary: it's a CI-
oriented pre-publish
validator, exit code
gates the build, and
operators reading
CI step output want
the issues surfaced
visibly.

Prior to M4.15.v,
`workflow validate`
emitted only json
+ human. CI users
got either a JSON
blob (parseable
but unreadable in
the Actions UI) or
a stream of `error
[code] path: msg`
lines (readable but
not visually
distinguished from
plain log output).

## Decision

Add `--format gh-
summary` to
`workflow validate`.
Renders a Markdown
table (severity /
code / path /
message) plus a
verdict footer
matching the exit-
code semantic:

- Clean
  definition (0
  errors, 0
  warnings) →
  `:white_check_
  mark:
  **Definition
  is valid**`.
- Errors > 0 →
  `:x:
  **Validation
  failed** — N
  error(s) block
  publish.`
- `--strict` +
  warnings > 0 →
  `:warning:
  **Strict
  validation
  failed** — N
  warning(s)
  under
  --strict.`
- Warnings > 0
  without
  --strict →
  `:warning:
  **Validation
  passed with
  warnings** —
  N warning(s)
  (non-blocking).`

### Errors-
first row
ordering

Rows are
sorted
errors-then-
warnings so
blocking
issues
surface at
the top of
the table.
Operators
scanning a
CI step
summary
read top-
down and
hit the
blockers
first.

### Schema-
error path
parity

The pre-
parse
schema-
error path
(`Workflow
Definition
Schema.
safeParse`
failure)
gets the
same gh-
summary
shape with
definitionId
/Key marked
`(schema-
rejected)`
since the
ids couldn't
be read.
Verdict is
always :x:
since schema
errors are
unconditionally
blocking.

### Severity-
cell emoji

`:x: error`
/ `:warning:
warning` —
not just
emoji but
emoji-
prefixed
text labels.
This keeps
the cell
scannable
even when
emoji
rendering
fails
(accessibility).

### Type
permissiveness:
ValidationIssue
Like

The
`formatValidate
GhSummary`
input type
uses a new
`ValidationIssue
Like` interface
(`severity`,
`code`,
`path`,
`message`) —
permissive
enough to
accept both
`WorkflowValidation
Issue` (typed
`code`) and
the synthetic
`schema_error`
issues
constructed
from ZodError
mapping
(string `code`).
Without this
indirection the
schema-error
path would
need to
fabricate a
fake validation
code (e.g.,
cast as
`unreachable_
state`) which
would lie
about the
actual error
type.

## Rejected
alternatives

1. **Show
   only
   errors
   in the
   table,
   warnings
   in a
   summary
   line
   below** —
   operators
   triaging
   want to
   see
   warning
   detail
   in
   context.

2. **Group
   issues
   by code
   in
   collapsible
   `<details>`
   blocks** —
   over-
   engineered
   for the
   typical
   1-5 issue
   case.
   Adds
   visual
   complexity.

3. **Skip
   the
   verdict
   footer
   on
   clean
   definitions
   (just
   the
   header
   suffices)
   ** —
   operators
   want
   explicit
   confirmation;
   the
   verdict
   line is
   the
   primary
   tell.

4. **Emit
   `:warning:`
   for
   schema-
   error
   path
   instead
   of
   `:x:`**
   — schema
   errors
   are
   structural
   parse
   failures;
   no
   different
   from
   validation
   errors
   from a
   gate
   semantic.

5. **Drop
   the
   message-
   cell
   pipe
   escape**
   — error
   messages
   from
   `validateDefinition`
   are
   currently
   pipe-free
   but
   future-
   proof
   the
   rendering
   against
   any
   message
   containing
   `|`.

6. **Use
   `:bug:`
   /
   `:exclamation:`
   alternates
   for
   verdict
   emoji**
   — stuck
   with
   the
   M4.15.e
   `:white_
   check_
   mark:` /
   `:warning:`
   /
   `:x:`
   convention
   used
   across
   the
   policies/
   retention/
   housekeeping
   diff
   family.

7. **Emit
   GitHub
   workflow
   command
   annotations
   (`::error
   file=def.json
   ::message`)
   for
   in-line
   PR
   markers**
   — different
   feature.
   gh-summary
   targets
   the
   step
   summary;
   workflow
   commands
   target
   the PR
   diff
   margin.
   Could be
   future Q.

8. **Include
   raw
   definition
   excerpt
   per
   issue
   (show
   the
   states[2]
   JSON
   for
   context)
   ** —
   useful
   for
   complex
   issues
   but
   makes
   the
   table
   wide.
   Defer.

## Drawbacks

- **gh-
  summary
  table
  width is
  fixed at
  4 cols**
  — long
  message
  text
  wraps in
  the
  message
  cell.
  Acceptable
  given
  CI step
  summaries
  are
  full-
  width.

- **The
  `(schema-
  rejected)`
  marker
  is
  English-
  text
  literal** —
  no i18n
  story
  for
  CLI
  output
  yet.

- **Verdict
  for
  warnings-
  only +
  --strict
  uses
  `:warning:`
  not
  `:x:`** —
  intentionally
  to
  distinguish
  "strict
  gate
  caught
  this"
  from
  "actual
  error".
  Operators
  scanning
  by
  emoji
  might
  miss
  that
  `:warning:`
  with
  exit 3
  is
  blocking.
  Verdict
  text
  ("Strict
  validation
  failed")
  carries
  the
  signal.

- **ValidationIssueLike
  is a
  new
  exported
  interface**
  — small
  surface
  expansion;
  acceptable
  for the
  type-
  decoupling
  it
  enables.

- **No
  `--columns`
  or
  `--no-
  header`
  support**
  — those
  flags
  apply to
  CSV
  surfaces.
  gh-summary
  is
  Markdown
  with a
  fixed
  shape.

## Future Qs

1. **`--format
   csv`** for
   workflow
   validate
   issues
   table
   (4-col
   csv:
   severity,
   code,
   path,
   message)
   for
   pipelines
   that
   archive
   validation
   results.

2. **GitHub
   workflow
   command
   output
   (`::error
   file=
   ...`)**
   for
   inline
   PR
   markers
   on the
   def.json
   file.
   Different
   format
   (could
   be
   `--format
   github-
   annotations`).

3. **Per-
   issue
   raw
   definition
   excerpt
   in
   `<details>`
   blocks**
   for
   complex
   forensics.

4. **Aggregate
   multi-
   file
   validation
   summary
   (`workflow
   validate
   def-*.json
   --format
   gh-
   summary`)**
   for
   batch
   pre-
   publish
   gates.

5. **Severity
   color
   bars
   ("![ ](
   https://
   img.shields.io/
   badge/...)")
   ** —
   visual
   distinction.
   Adds
   external
   dependency
   on
   shields.io;
   defer.

6. **`--quiet`
   gh-
   summary
   variant**
   that
   skips
   the
   table
   and
   emits
   only
   the
   verdict
   line.
