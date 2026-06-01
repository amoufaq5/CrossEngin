# ADR-0307: `sessions list --format csv|tsv|csv-full|gh-summary`

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0292 (M4.15.f tenants list csv-full precedent), ADR-0303 (M4.15.p --no-header), ADR-0304 (M4.15.q --columns) |

## Context

The M4.15.x stretch
shipped extensive CSV/
gh-summary polish on
the tenants/policies/
retention/housekeeping
diff family. But other
list-style surfaces in
the CLI still answered
in only json + human.

`sessions list` is the
clearest example: a
tenant-scoped list of
`ArchitectSessionRecord`
(12 fields including
per-token counts +
cost_usd) used for LLM
cost auditing and CI
gates on session spend.
Operators wanting
spreadsheet exports
("show me last week's
sessions by cost") had
to pipe `--format json`
through jq.

## Decision

Add 4 new output
formats to `sessions
list`:

1. **csv / tsv**:
   compact 6-col bulk
   export matching the
   human-format column
   set exactly
   (session_id, model,
   started_at, turns,
   cost_usd, status).
   `status` is derived
   (`in_progress` /
   `ended` based on
   `endedAt`).
2. **csv-full**:
   12-col TenantRecord
   shape with all
   ArchitectSession
   Record fields
   (adds id, tenant_id,
   system_prompt_sha
   256, ended_at, per-
   token counts).
3. **gh-summary**:
   Markdown for CI
   step summary
   integration —
   `## Sessions for
   tenant <tenantId>`
   header with cost-
   summary line
   (Sessions / Total
   cost / Total
   turns / Input
   tokens / Output
   tokens) +
   per-session
   table. No verdict
   emoji since
   sessions list is
   a query surface,
   not a gate.

### Composition

Reuses the M4.15.p +
M4.15.q + format-
layer infrastructure:

- `--no-header`:
  skip header row
  (same shared
  `printCsv` opt).
- `--columns
  col1,col2,...`:
  subset filter
  with caller-
  specified order
  (same shared
  `applyColumns
  Filter`).
- `--csv-separator
  <c>`: custom
  separator with
  same validation
  (rejects `"` +
  newlines).

### Field-value
conventions

- `cost_usd`
  always uses
  `.toFixed(6)`
  for stable
  currency precision
  (no floating-
  point jitter
  in spreadsheets).
- Empty
  `endedAt` /
  `systemPrompt
  Sha256` render
  as empty cells
  (printCsv null
  convention).
- gh-summary
  token counts
  use
  `toLocaleString
  ("en-US")` for
  thousands
  separators
  ("1,234,567"
  rather than
  "1234567")
  since these
  numbers are
  read-once by
  humans.

### Empty-state

- csv/tsv/csv-
  full: emit
  header-only
  (no human
  "no sessions"
  text); CSV
  contract is
  data shape.
- gh-summary:
  emit
  `_No
  sessions
  found._`
  italic
  marker.
- human:
  preserved
  existing
  "no sessions
  for tenant
  X" message.

## Rejected
alternatives

1. **Add
   csv/gh-
   summary
   to
   `sessions
   show` +
   `sessions
   replay`
   too** —
   show
   returns 4
   different
   result
   shapes
   (session
   + messages
   + invocations
   + proposals);
   each
   needs its
   own CSV
   schema.
   Replay is
   chat-
   transcript
   ordering,
   not
   tabular.
   Defer.

2. **Add
   `--include-
   cost-
   summary`
   flag to
   gh-summary**
   for
   operators
   wanting
   just the
   table
   without
   the
   summary
   line —
   over-
   engineered.
   The
   summary
   is 1 line;
   trivial to
   ignore.

3. **Add
   a
   `--sort-by
   cost_usd
   desc`
   flag** —
   stores
   already
   return
   in
   started_at
   DESC.
   Operators
   wanting
   cost-
   ranked
   output
   can
   pipe
   `| sort
   -t, -k5
   -rn`.
   Defer.

4. **Use
   `--format
   markdown`
   instead
   of
   `--format
   gh-
   summary`**
   —
   gh-
   summary
   is the
   established
   alias
   from
   M4.15.e
   for "this
   Markdown is
   specifically
   shaped
   for
   GitHub
   Step
   Summary".
   Consistency
   matters.

5. **Match
   the
   csv-full
   column
   order
   to
   ArchitectSession
   Record's
   declaration
   order
   (id first,
   tenantId
   second)
   vs.
   reorder
   to
   put
   sessionId
   first
   (since
   that's
   what
   operators
   primarily
   look up
   by)** —
   stuck
   with
   declaration
   order
   since
   that's
   the
   conventional
   csv-
   full
   pattern
   from
   tenants
   list
   (which
   also
   puts
   id
   first).

6. **Drop
   the
   derived
   `status`
   column
   from
   csv-full
   (already
   has
   `ended_at`)
   ** —
   `status`
   is
   useful
   in the
   compact
   csv
   shape
   where
   the
   raw
   timestamp
   isn't
   present.
   csv-
   full
   could
   omit
   it
   but
   inclusion
   trades
   1 col
   width
   for
   shape-
   parity
   with
   compact.
   Actually,
   csv-full
   does
   NOT
   include
   status —
   compact
   has
   it,
   csv-
   full
   has
   the
   raw
   `ended_at`
   timestamp.
   Operators
   filtering
   ended-
   only
   in
   csv-
   full
   use
   `awk
   -F, '$7
   != ""'`.

7. **Include
   verdict
   emoji
   in
   gh-
   summary**
   (✅/⚠️
   based on
   total
   cost
   threshold)
   —
   sessions
   list is a
   query
   surface
   not a
   gate.
   No
   threshold
   semantic.
   Operators
   wanting a
   gate
   should
   pipe
   gh-
   summary
   through
   a
   separate
   verdict
   step.

## Drawbacks

- **Empty-
  state
  behavior
  differs
  between
  human
  ("no
  sessions
  for
  tenant
  X")
  and csv
  (header-
  only,
  no body)
  ** —
  spreadsheet
  workflows
  expect
  this;
  shell
  operators
  switching
  formats
  may be
  surprised.

- **gh-
  summary
  cost-
  summary
  line is
  wide**
  (5
  metrics
  comma-
  separated)
  — may
  wrap on
  narrow
  CI
  displays.
  Acceptable
  given
  CI
  step
  summary
  width
  is
  typically
  generous.

- **`turns`
  column
  in
  compact
  CSV
  emits
  raw
  integer
  while
  `cost_
  usd`
  uses
  `.toFixed
  (6)`** —
  inconsistent
  formatting.
  Integers
  don't
  benefit
  from
  fixed
  decimal;
  the
  toFixed
  on
  cost
  is for
  precision.
  Acceptable
  asymmetry.

- **No
  cohort
  filter
  flags
  (--min-
  cost-usd,
  --min-
  turns)
  ** —
  comparable
  to
  tenants
  list's
  --min/
  --max-
  policy-
  count.
  Defer to
  future M.

## Future Qs

1. **`--min-
   cost-usd
   <N>` /
   `--max-
   cost-usd
   <N>`
   cohort
   filters**
   for
   spend-
   ranked
   audits.
   Same
   pattern
   as
   M4.15.k/r.

2. **csv +
   gh-
   summary
   for
   `sessions
   show`**
   — needs
   per-
   sub-
   resource
   CSV
   shape
   (messages,
   invocations,
   proposals).
   Larger
   scope.

3. **`sessions
   replay
   --format
   markdown`**
   — transcript
   as
   collapsed
   `<details>`
   blocks
   per
   turn for
   PR-comment
   integration.

4. **`--include-
   cost-
   tier`
   join
   against
   meta.
   llm_
   cost_
   ceilings**
   to
   include
   the
   tenant's
   ceiling
   bound
   per-
   session.

5. **`--by-
   model`
   group-
   by
   model
   summary
   row**
   in
   gh-
   summary
   ("4
   sessions
   on
   sonnet-
   4-6 =
   $0.0123,
   2 on
   opus-
   4-8 =
   $0.0892").
