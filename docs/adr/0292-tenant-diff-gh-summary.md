# ADR-0292: `--format gh-summary` Markdown output for diff family

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0282 Q5 (closes), ADR-0286 Q7 (closes), ADR-0287 Q3 (closes), ADR-0288 Q3 (closes), ADR-0290 Q2 (closes) |

## Context

Five deferred Qs across the diff
family asked for Markdown output
suitable for GitHub Step Summary
redirection from CI workflows:
- ADR-0282 Q5 (policies --diff)
- ADR-0286 Q7 (policies --vs-tier)
- ADR-0287 Q3 (policies N-way)
- ADR-0288 Q3 (housekeeping --diff)
- ADR-0290 Q2 (housekeeping N-way)

Operators running cohort uniformity
gates from GitHub Actions wanted the
diff result surfaced in the workflow
run UI (not buried in raw log
output). The standard mechanism is
appending Markdown to
`$GITHUB_STEP_SUMMARY`. Each
deferred Q individually called for
the same Markdown shape; closing
them together as a single
milestone avoids redoing the
rendering helpers for each
surface.

Real workflows:

1. **CI gate visibility** —
   pipeline step "Verify cohort
   uniformity" prints a Markdown
   table to the run UI showing
   which fields drifted across
   3 tenants.

2. **PR review summary** —
   reviewers see a divergence
   table inline rather than
   clicking through to step
   logs.

3. **Compliance gate
   verdicts** — verdict emojis
   (✅ / ⚠️) give one-glance
   signal whether the gate
   passed.

## Decision

Add `gh-summary` as a new
`--format` value. Honored by the
diff family (5 paths total);
other surfaces silently fall
through to human format until
they grow Markdown renderers.

### Operator usage

```bash
crossengin tenant policies acme \
  --diff foo \
  --format gh-summary \
  >> "$GITHUB_STEP_SUMMARY"
```

The CLI writes Markdown to
stdout; operators redirect to
the appropriate destination.
The CLI does NOT read
`$GITHUB_STEP_SUMMARY` from
env and write directly to
the file — that would entangle
the CLI with GitHub-specific
side effects.

### Markdown shape

**Single-comparison policies
diff:**

```markdown
## Diff: tenant policies

**Left:** `<uuid-a>` (input: `<input-a>`)
**Right:** `<uuid-b>` (input: `<input-b>`)

### Field changes (N)

| Axis | Field | Left | Right |
|------|-------|------|-------|
| retention | `gateway_pipeline_executions.retentionDays` | `30` | `365` |
| ... |

:warning: **Divergence detected** — N field(s) differ.
```

When fieldDiffs is empty:

```markdown
## Diff: tenant policies

**Left:** ... **Right:** ...

:white_check_mark: **No differences** — both tenants match.
```

**Single-comparison housekeeping
diff:** Same shape but adds a
`Table` column (5-col table)
since `HousekeepingFieldDiff`
keys by (axis, tableName, field).

**Multi-comparison:** Wraps each
pair in a `### Comparison i/N:
vs <uuid>` section, ends with a
`---` separator + `**Summary:**`
footer reporting max-divergence
across pairs. Verdict emoji at
the end reflects max-divergence
state.

### Value escaping

`formatMdValue` wraps every
value in backticks and escapes:
- pipes (`|` → `\|`) so they
  don't break table cells
- backticks (`` ` `` → `` \` ``)
  so they don't terminate the
  wrapping
- backslashes (`\` → `\\`)
  for completeness

`null`/`undefined` render as
`` `null` `` for visibility
(distinct from empty string).
Booleans + numbers stringify
to their natural form, wrapped
in backticks.

### Verdict emoji convention

- `:white_check_mark:` ✅ —
  no divergences (or all
  comparisons match in
  multi-mode).
- `:warning:` ⚠️ — at least
  one divergence found.

GitHub renders these
automatically; operators don't
need to embed Unicode codepoints
directly.

### Exit code

Identical to other formats:
`diffDivergenceExitCode(command,
fieldDiffsLength)` —
`--exit-on-divergence` still
fires exit 3 on divergence
regardless of format. Markdown
output is a render mode, not
a gate override.

### Implementation

- Added `"gh-summary"` to
  `OUTPUT_FORMATS` const +
  parser whitelist.
- 4 new renderers in tenant.ts:
  - `renderPoliciesDiffGhSummary`
  - `renderPoliciesMultiDiffGhSummary`
  - `renderHousekeepingDiffGhSummary`
  - `renderHousekeepingMultiDiffGhSummary`
- Branches added to:
  - `emitDiffOutput` (policies single)
  - `emitMultiDiffOutput` (policies multi
    + vs-tier multi)
  - `runTenantHousekeepingDiff` (both
    N=1 and N>1 paths)
- `--vs-tier` automatically picks
  up `gh-summary` since it
  routes through
  `emitDiffOutput` / `emitMultiDiffOutput`
  for single + N-way respectively.

## Rejected alternatives

1. **Separate `--gh-summary`
   boolean flag** (not a format
   value) — would require
   special-casing alongside
   `--format`. Cleaner to make
   it a format value so the
   existing branching machinery
   handles it.

2. **`--format md` (generic
   Markdown)** — risks colliding
   with a future general
   Markdown output (e.g., docs
   generation). The `gh-summary`
   name signals "this targets
   GitHub Step Summary"
   specifically, leaving room
   for `md` to mean something
   else later.

3. **Write directly to
   `$GITHUB_STEP_SUMMARY`
   from the CLI** — entangles
   the CLI with GitHub
   conventions. The redirect-
   in-shell approach is more
   composable (operators can
   redirect to any file or
   pipe elsewhere).

4. **Emoji rendering via
   Unicode codepoints** —
   GitHub-flavored Markdown
   already renders
   `:white_check_mark:` etc.
   The shortcode form is
   diffable and grep-able.

5. **Collapsible
   `<details>` sections per
   comparison** — adds
   visual noise for small
   N; reviewers want to
   skim. Heading hierarchy
   (### per comparison)
   gives the same scanning
   behavior with no
   collapse mechanics.

6. **JSON+Markdown hybrid
   (Markdown wraps a JSON
   block)** — defeats the
   purpose. Operators
   wanting both use jq on
   `--format json`.

7. **Format-validation
   error when `--format
   gh-summary` is set on
   surfaces that don't
   support it** — would
   surprise operators with
   subtle command-specific
   failures. Falling
   through to human
   format means the
   command always works,
   even if the output isn't
   Markdown.

8. **Build a shared
   `renderDiffMarkdown`
   helper across policies
   + housekeeping** — the
   table column counts
   differ (4 vs 5 cols).
   Inlining keeps each
   renderer simple +
   self-contained. The
   `formatMdValue` helper
   IS shared.

## Drawbacks

- **Fall-through behavior for
  unsupported surfaces** —
  operators running e.g.
  `tenants list --format
  gh-summary` get human-table
  output, not Markdown. The
  CLI doesn't reject; this
  matches the spirit of
  "graceful degradation"
  but could surprise users
  who expect Markdown
  everywhere.

- **Heading levels hardcoded
  at ## / ### / ####** —
  works for top-level Step
  Summary content but
  operators embedding the
  output inside a larger
  Markdown doc would need
  to munge headings.
  Acceptable trade-off;
  the primary use case is
  Step Summary at root.

- **Verdict emoji is
  binary** — operators
  wanting nuance (e.g.,
  "1-2 diffs is yellow,
  3+ is red") need to
  post-process. Defer
  threshold-based
  verdicts.

- **Pipe-escaping reads
  oddly in copy-paste**
  — `ticket\|456` looks
  off when extracted
  from Markdown. The
  alternative
  (HTML-encoded `&#124;`)
  is worse for
  human-readability.

- **No GitHub Actions
  test-coverage in this
  milestone** — we test
  the Markdown OUTPUT,
  not the integration
  with GitHub Actions
  workflow files. Defer
  to a future CI
  integration test.

## Future Qs

1. **Threshold-based verdict
   emojis** (yellow/red/green
   based on count). Pairs
   with `--threshold N` flag.

2. **Collapsible `<details>`
   per comparison for very
   large N** (>10 pairs).

3. **`--gh-summary-write
   $PATH` flag** that
   writes directly instead
   of stdout — avoids the
   redirect dance. Defer
   unless requested.

4. **Markdown rendering
   for the retention diff
   family** (--format
   gh-summary on `retention
   diff` etc.). Same
   pattern.

5. **Linkified field
   references** to ADR
   docs or schema
   documentation. Pairs
   with a `--docs-base-url`
   flag.

6. **Compact mode**
   (just verdict +
   count, no field
   table) for cohort
   summaries that
   roll up dozens
   of comparisons.

7. **HTML output**
   (`--format html`)
   for non-GitHub
   targets (Slack,
   Confluence). Future
   surface.
