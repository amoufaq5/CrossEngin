# ADR-0291: `tenant housekeeping --diff --format csv|tsv` bulk-export

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0288 Q2 (closes), ADR-0285 Q5 (closes), ADR-0285 (CSV pattern), ADR-0290 (housekeeping N-way) |

## Context

ADR-0288 Q2 deferred "CSV/TSV format
for housekeeping --diff" + ADR-0285 Q5
deferred "--format csv|tsv for tenant
housekeeping" — both close together
since they require the same CSV row
shape design.

After M4.15.a (single-pair diff) and
M4.15.c (N-way diff) shipped with JSON
+ human output only, spreadsheet
workflows still required jq pipelines
to flatten the envelope. Operators
preparing cohort uniformity audits for
GRC review want the diff directly as
CSV ready for Excel + pandas.

Real workflows:

1. **Compliance audit export** —
   auditor exports "all
   housekeeping divergences across
   the prod cohort" as CSV for GRC
   review.
2. **Spreadsheet cohort triage**
   — operator opens the diff in
   Excel, filters by `axis` +
   `table_name`, sorts by
   `comparison_index` to find
   the most-divergent tenant.
3. **Pandas drift analysis** —
   data team imports the CSV
   into pandas, groups by
   `comparison_index` + `axis`,
   counts divergences per pair.

## Decision

Add `--format csv|tsv` +
`--csv-separator <c>` to `tenant
housekeeping --diff`. Single-
comparison emits 9 columns;
N-way (`--add-tenant`) prepends
`comparison_index` for 10 columns.
Mirrors the policies --diff CSV
pattern from M4.14.c (single) +
M4.14.a (N-way).

### Column shape

Single-comparison (N=1):

```
tenant_a_id, tenant_a_input,
tenant_b_id, tenant_b_input,
axis, table_name, field,
value_a, value_b
```

The `axis` column carries
"gateway" or "retention" (the
two housekeeping dashboards).
The `table_name` column is the
key distinction from policies
--diff CSV (which keys only by
axis+field): housekeeping
fieldDiffs are per-table by
nature since the dashboards
list per-table rows. Field
values like `tenantPolicy.exists`,
`tenantPolicy.retentionDays`,
or `exists` (table-presence
mismatch) appear in the
`field` column.

Multi-comparison (N>1):
prepends `comparison_index`
column 0..N-1 tagging each
row with which (anchor,
right[i]) pair it came from.

### Empty fieldDiffs

Header-only emission when no
divergences found. Matches
the CSV convention from
retention/policies/tenants
list: spreadsheet workflows
want the header present even
when no data rows match so
column-naming auto-population
works. Divergence exit code
still fires per
--exit-on-divergence
semantics — CSV doesn't
suppress it.

### --csv-separator
validation

Reuses the existing
`validatePoliciesCsvSeparator`
helper from tenant.ts (same
module). Rejects `"` and
newlines (would produce
ambiguous CSV no parser can
round-trip). Validated under
`--format csv`; under tsv /
human / json the flag is
silently ignored (matches
M4.14.c + M4.15.b patterns).

### Implementation

- New `HOUSEKEEPING_DIFF_CSV_HEADERS`
  9-column array constant.
- New `buildHousekeepingDiffCsvRows`
  helper: takes anchor +
  right + fieldDiffs, returns
  one row per fieldDiff. Empty
  fieldDiffs yields empty
  array; caller emits header-
  only CSV in that case.
- CSV branch added to both
  `n === 1` and `n > 1`
  paths in `runTenantHouse
  keepingDiff`. Each
  validates `--csv-separator`
  before emission.
- For N-way: per-comparison
  row list collected, each
  row prefixed with comparison
  index before being passed
  to `printCsv` / `printTsv`
  with `["comparison_index",
  ...HOUSEKEEPING_DIFF_CSV_
  HEADERS]` headers.

## Rejected alternatives

1. **Separate gateway-axis CSV
   + retention-axis CSV files**
   (NDJSON-style multi-file
   output) — operators preferred
   the unified table with axis
   column for spreadsheet
   filtering. Two-file output
   complicates the shell
   pipeline and the single-
   table-with-axis-column
   pattern is well-precedented
   (retention list, policies
   diff).

2. **Include global per-table
   stats in CSV** — same
   rationale as M4.15.a JSON
   envelope: race noise
   between gather calls
   dominates signal.
   tenantPolicy-only stays.

3. **Use the policies CSV
   header schema unchanged**
   (omit `table_name`) —
   housekeeping fieldDiffs
   key by (axis, tableName,
   field) so omitting
   `table_name` would lose
   information. The
   tableName always lives in
   the `field` value (e.g.,
   `gateway_pipeline_executions.tenantPolicy.exists`)
   but a separate column is
   cleaner for filtering.

4. **JSON-style fieldDiffs
   array embedded as quoted
   JSON in a single column**
   — defeats the purpose of
   CSV (operators wanting
   structured nested data
   use --format json).

5. **Markdown table output
   under `--format md`** —
   future M4.15.e
   (--gh-summary) covers
   Markdown rendering for
   GitHub Step Summary.
   Separate flag.

6. **`comparison_index`
   column at the END
   instead of position 0**
   — matches the M4.14.a
   policies precedent
   (leading position).
   Spreadsheet pivot tables
   group by leading key
   naturally.

7. **Extract a shared
   `validateCsvSeparator`
   helper to format.ts**
   — over-engineered for
   a 4-line check now used
   in 4 modules
   (retention, policies,
   tenants list, house
   keeping diff). Each
   module's inline check
   stays small and local.

## Drawbacks

- **Empty-result header row
  surprise** — operators
  piping empty CSV into
  `wc -l` see 1, not 0. Same
  trade-off as M4.15.b
  (`tenants list` CSV).
  Acceptable; the
  spreadsheet workflow win
  dominates.

- **--csv-separator under
  --format json silently
  ignored** — operators
  setting it in shell
  aliases for ergonomic
  defaults won't catch
  typos. Matches retention
  precedent.

- **No way to emit gateway-
  only or retention-only
  CSV** — operators wanting
  just one axis filter
  client-side (`grep
  '^[^,]*,[^,]*,[^,]*,[^,]*,
  gateway,'` or pandas
  `df[df.axis=='gateway']`).
  Adding `--axis gateway|
  retention` would shrink
  the unified-table
  semantic; defer.

- **table_name column
  inflates wide-CSV cost
  marginally** — average
  housekeeping field-
  diff CSV row is now
  ~50 chars (~10 cols)
  vs ~40 (~8 cols) for
  policies. Negligible
  for the typical 5-50
  row range; would
  matter at thousands
  of rows.

## Future Qs

1. **`--gh-summary`
   Markdown rendering**
   (closes ADR-0287 Q3
   + ADR-0288 Q3 +
   ADR-0290 Q2 + ADR-
   0286 Q7 + ADR-0282
   Q5). The CSV row
   builder maps
   directly to Markdown
   table rows; this is
   the natural follow-up
   for CI integration
   workflows.

2. **`--axis gateway|
   retention` filter**
   for single-axis CSV
   export. Useful when
   operators are auditing
   only one substrate
   surface. Defer.

3. **Pre-formatted human-
   readable diff values**
   (e.g., `"override→
   inherit"` instead of
   `value_a=true,
   value_b=false` for
   tenantPolicy.exists
   diffs) — readability
   win for human-CSV
   consumers but
   complicates
   downstream parsing.
   Defer behind
   `--format csv-human`
   variant if needed.

4. **`comparison_index`
   sortable in CSV
   shell tools via
   `sort -k1n`** —
   already trivially
   true; documentation
   point not a feature.

5. **`--csv-include-anchor`
   echo column** —
   redundant under
   single-comparison
   (tenant_a_* columns
   already echo it).
   Useful only for
   spreadsheet pivot
   workflows. Defer.

6. **NDJSON stream
   format for very
   large fieldDiffs
   sets** — current
   workflows max out
   at ~100 diffs per
   comparison; CSV
   handles fine.

7. **CSV with embedded
   newlines in value
   columns (rare but
   possible for
   optOutReason
   freetext)** — current
   printCsv already
   handles via standard
   quote-and-escape;
   verify in a future
   robustness test.
