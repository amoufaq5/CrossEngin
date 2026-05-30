# ADR-0296: `retention diff --format gh-summary` Markdown across 5 surfaces

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0292 Q4 (closes), ADR-0292 (gh-summary pattern), ADR-0282/0287/0288/0290 (other diff families) |

## Context

ADR-0292 Q4 deferred "Markdown
rendering for the retention diff
family." After M4.15.e closed
the policies + housekeeping
gh-summary work, CI workflows
running retention diff gates
still saw raw text output —
not the Markdown rendering
GitHub Step Summary consumers
expected.

The retention diff family has
5 distinct surfaces:

1. `retention diff` (pair) —
   tenant A vs tenant B on
   one table.
2. `retention diff
   --vs-platform` — tenant vs
   platform defaults on one
   table.
3. `retention diff
   --cross-table` — tenant on
   table A vs same tenant on
   table B.
4. `retention diff
   --add-tenant` — N-way
   tenant comparison on one
   table.
5. `retention diff
   --cross-table
   --add-table` — cross-table
   N-way comparison.

Each has a different result
shape (pair vs N-way, single
vs cross-table) so each
needs its own Markdown
renderer with appropriate
column labels.

## Decision

Add `--format gh-summary`
branches to all 5 retention
diff surfaces. Output
mirrors the policies +
housekeeping conventions
from M4.15.e: `## header`
+ metadata + Markdown
table + verdict-emoji
footer.

### Per-surface table
labels

- **Pair diff**: `Field |
  Tenant A | Tenant B`
- **vs-platform**: `Field
  | Tenant | Platform`
- **cross-table**:
  `Field | Table A |
  Table B`
- **N-way pair**:
  `Field | Distinct
  values` (with `value
  (label1, label2)`
  per group)
- **cross-table N-way**:
  same shape as N-way
  pair but labels are
  table names instead
  of tenant ids.

The N-way variants
differ from pair
because the result
shape is
`fieldVariations` (a
distinct-values
grouping) rather than
`fieldDiffs` (a
pair-wise list).
Distinct-value
grouping
naturally encodes
"these 3 tenants
match each other but
diverge from those
2" in a single
column cell.

### Verdict footer

- Pair / vs-platform
  / cross-table:
  - Empty fieldDiffs →
    `:white_check_mark:
    **No differences**`
  - Non-empty →
    `:warning:
    **Divergence
    detected**` (or
    "Override detected"
    for vs-platform,
    "Cross-table
    divergence" for
    cross-table).
- N-way:
  - Empty
    fieldVariations →
    `:white_check_mark:
    **No variations**`
  - Non-empty →
    `:warning:
    **Variations
    detected**`.

### Value formatter

`formatMdRetentionValue`
mirrors the policies +
housekeeping helper:
backtick-wrap + escape
pipe (`\|`), backtick
(`` \` ``), backslash
(`\\`); distinguishes
`undefined` →
`` `absent` `` from
`null` → `` `null` ``
(retention's
HistoryEntryFieldDiff
uses both
meaningfully — undefined
means "the field doesn't
exist on this side";
null means "explicitly
null").

## Rejected alternatives

1. **Single shared
   `renderRetentionDiff
   Markdown` helper** —
   5 result shapes
   differ enough that
   sharing would
   require a tagged-
   union. Inlining
   each renderer is
   simpler.

2. **Use HTML
   `<details>` for
   N-way distinct-
   value groups** —
   would require
   special-casing
   per group; inline
   `value (labels)`
   is more compact.

3. **Emit emoji
   directly as
   Unicode
   codepoints
   (`✅` vs
   `:white_check_mark:`)
   ** — GitHub
   renders both;
   shortcodes are
   diffable +
   grep-able + don't
   require Unicode
   font support.

4. **Add an option
   to omit the
   verdict emoji**
   — operators
   wanting raw
   tables use
   `--format json`
   + jq. The
   verdict emoji is
   the entire point
   of gh-summary.

5. **Use Markdown
   headings `####
   Tenant A` instead
   of bold labels**
   — too deep in
   the heading
   hierarchy;
   would clash with
   embedded usage
   in CI workflows
   that wrap the
   output in their
   own headings.

6. **Combine
   N-way distinct
   values into a
   nested table**
   — Markdown
   tables don't
   support nesting;
   inline grouping
   is the only
   clean rendering.

7. **Add column
   for the
   resolution
   `source` field
   (tenant/platform)
   ** — useful but
   already implicit
   from the
   labels. Defer.

## Drawbacks

- **Some N-way
  variations cells
  can be very wide**
  for many distinct
  values. Markdown
  renderers wrap.
  Acceptable for
  typical
  workflows (N ≤ 10).

- **Tenant IDs in
  N-way labels are
  UUID-shaped,
  hard to read**
  in the inline
  group format.
  Operators
  wanting slug
  labels need to
  pre-resolve.

- **`Field |
  Distinct values`
  is 2 cols vs the
  3-col pair
  shapes** —
  consumers
  switching
  between pair
  and N-way need
  to handle two
  shapes. Same
  trade-off as
  ADR-0292.

- **Five renderer
  functions adds
  ~150 LOC to
  retention.ts**
  — mostly
  boilerplate.
  Acceptable
  given each
  renderer is
  unit-tested
  independently.

- **No tests for
  the
  end-to-end
  format-branch
  integration** —
  I added unit
  tests for each
  renderer
  directly but
  not full
  `runRetention`
  → output
  paths.
  Acceptable;
  the format
  branch is
  one-line per
  surface and
  matches the
  M4.15.e
  precedent.

## Future Qs

1. **Same pattern
   for retention
   `diff-history` +
   `diff-timeline`**
   — these are
   different shapes
   (history entries,
   timeline events)
   so each needs
   its own Markdown
   renderer.

2. **Slug-aware
   N-way labels**
   — accept a
   resolver
   callback to
   convert UUIDs
   to slugs in
   gh-summary
   output.

3. **`--axis`
   filter for
   retention diff
   family** — once
   ADR-0295 Q1
   ships
   (--axis on
   policies
   --diff).

4. **Tier-aware
   override
   verdict** —
   for
   vs-platform,
   distinguish
   "tenant-level
   override" vs
   "tier-level
   override" in
   the emoji.

5. **CSV/TSV for
   retention
   N-way** — the
   distinct-
   values grouping
   would benefit
   from a column-
   per-tenant
   shape.

6. **Compact mode
   (just verdict
   + count, no
   table)** for
   cohort
   summaries.
