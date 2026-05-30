# ADR-0289: `tenants list --format csv|tsv` bulk export

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0285 Q4 (closes), ADR-0273 (tenants namespace), ADR-0285 (CSV/TSV pattern) |

## Context

ADR-0285 deferred Q4 was "tenants list
--format csv|tsv for bulk export." The
`tenants list` command has shipped with
JSON + human-table output (M4.14.k);
operators doing bulk compliance
enumeration (e.g., "give me every
active tenant in CSV for the auditor")
were piping JSON through jq to flatten
the array, which adds friction for
spreadsheet-driven workflows.

Real workflows:

1. **Compliance enumeration** — auditor
   requests "all tenants with status
   active" as a CSV for review. Direct
   `--format csv` removes the
   jq-flatten step.
2. **Spreadsheet-driven tenant
   inventory** — operator opens the
   CSV in Excel/Google Sheets for
   sorting by tier/region.
3. **Pandas analytics pipelines** —
   data team imports the tenant
   inventory into pandas for
   cohort analysis.

## Decision

Add `--format csv|tsv` + `--csv-separator
<c>` to `tenants list`. Mirrors the
pattern established by ADR-0285 for
retention/policies CSV output.

### Column shape

Five columns matching `TenantRow`:

```
id,slug,name,status,tier
```

Same columns as the human-table output
(M4.14.k). Why not include the
TenantRowFull set (region, schema,
residency, search_locale, timestamps)
seen in `tenants get`? Two reasons:

1. **`tenants list` returns the compact
   row**; the SQL `SELECT` lists only
   these 5 columns. Extending CSV to
   include TenantRowFull would require
   widening the list query, which
   changes the human-table layout
   in a way users don't expect.
2. **Operators wanting the FULL row
   use `tenants get`** for one
   tenant at a time. Bulk-full
   enumeration is a different
   workflow (would join with
   retention policy counts etc.)
   and deserves a future
   `--format csv-full` flag.

### Header on empty result

Empty result set still emits the
header row. Matches the CSV/TSV
convention established by ADR-0285:
spreadsheet workflows want the
header present so column-naming
auto-population works even when
no data rows match.

### --csv-separator validation

Rejects `"` and newlines (would
produce ambiguous CSV that no
parser can round-trip). Inlined
in `runTenantsList` rather than
extracted to format.ts since the
4-line check is small and
inlining avoids cross-module
coupling. Identical validation
to retention's pattern.

Silently ignored under non-CSV
formats (json/tsv/human) —
matches retention precedent
(no error for redundant flag,
allowing operators to set it
in shell aliases without
needing to remember to omit
it for JSON output).

### Filter composition

All existing list filters
(`--status`, `--table-filter`,
`--has-overrides`) compose
with `--format csv|tsv` without
change. The filter logic lives
in the SQL WHERE clause built
by `buildListQuery`; format
selection happens after the
result set comes back, so
filtered + formatted output
falls out naturally.

## Rejected alternatives

1. **Include TenantRowFull
   columns in CSV** — would
   widen the list query +
   change human-table layout
   unexpectedly. Future
   `--format csv-full` flag
   covers this if needed.

2. **Emit a "row count"
   metadata header** (e.g.,
   `# tenants: 3`) — breaks
   strict CSV parsing.
   Spreadsheets choke on
   non-data leading rows.
   Use JSON envelope for
   counts; CSV is pure data.

3. **Add `count` column
   tracking per-tenant
   policy overrides** —
   useful but requires a
   GROUP BY join against
   meta.tenant_retention_policies.
   Different query
   semantic; defer.

4. **Default `--format csv`
   to use semicolon** —
   matches some European
   spreadsheet locales but
   would surprise English-
   locale users. Keep comma
   default; operators set
   `--csv-separator ";"`
   explicitly.

5. **Extract csv-separator
   validation to format.ts
   as a shared helper** —
   over-engineered for a
   4-line check used in 3
   places (retention,
   policies, tenants
   list). Each module's
   inline check stays
   small and local.

6. **Error on
   `--csv-separator` set
   under non-CSV formats**
   — would surprise
   operators who use shell
   aliases setting both
   `--format` and
   `--csv-separator`
   flexibly. Silent
   ignore matches
   retention precedent.

7. **Emit JSON-style
   quoted column names in
   CSV header** (`"id",
   "slug"...`) — breaks
   spreadsheet
   auto-detection of
   headers. Plain unquoted
   names are universal.

## Drawbacks

- **No TenantRowFull
  columns in CSV** —
  operators wanting full
  rows for every tenant
  need to script via `jq
  '.tenants[] | .id' |
  xargs ... tenants
  get --format csv-full`
  (when csv-full ships).
  Acceptable for v1;
  `tenants get` is the
  full-row path.

- **5-column shape can't
  grow without widening
  the list query** —
  future feature additions
  (e.g., a `policy_count`
  column from a GROUP BY)
  require new query
  variant. Acceptable;
  bulk-export is a stable
  shape.

- **--csv-separator
  silently ignored under
  non-CSV formats** —
  operators might
  reasonably expect an
  error to catch typos.
  Matches retention
  precedent and avoids
  shell-alias friction;
  the trade-off is
  intentional.

- **Empty-result header**
  — operators piping
  empty output into a
  null-check might be
  surprised that
  `wc -l` reports 1
  instead of 0. Document
  in CLI help; the
  spreadsheet workflow
  win dominates the
  scripting surprise.

## Future Qs

1. **`--format csv-full`
   variant emitting all
   TenantRowFull columns
   (id, slug, name,
   status, tier, region,
   schema_name,
   residency, search_locale,
   created_at, updated_at)**
   — useful for full
   audit exports. Defer
   to follow-up
   milestone.

2. **`--include-policy-
   count` flag adding a
   computed column for
   per-tenant retention
   policy overrides** —
   pairs with cohort
   analysis workflows.
   Defer.

3. **`--include-cost-
   ceiling` flag adding
   the per-tenant
   override (if any)
   from meta.tenant_
   cost_ceilings** —
   compliance gate
   workflows. Defer.

4. **`--csv-quote-all`
   flag forcing quoting
   on every field** —
   some downstream
   tools require it;
   CSV spec allows
   either. Defer
   unless requested.

5. **Stream NDJSON
   format for very
   large tenant lists
   (10k+)** — not
   needed for current
   meta.tenants
   cardinality but
   future-proofing
   could matter.

6. **`tenants list
   --format markdown-
   table` for GitHub
   Step Summary
   integration** —
   pairs with
   ADR-0287 Q3 +
   ADR-0288 Q3 across
   the diff family.
   Defer; can roll
   into the broader
   `--gh-summary`
   milestone.

7. **Per-column
   sort-by flag
   (`--sort-by tier`
   etc.)** — currently
   sorted by slug.
   Operators wanting
   tier-grouped output
   would benefit.
   Defer; can be
   client-side via
   sort/head.
