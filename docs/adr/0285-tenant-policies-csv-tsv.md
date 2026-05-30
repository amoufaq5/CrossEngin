# ADR-0285: `tenant policies` CSV/TSV format

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0280 Q6 + ADR-0282 Q4 (closes), ADR-0280 (tenant policies aggregate), ADR-0281 (--effective), ADR-0282 (--diff), ADR-0283 (--explain), retention.ts CSV/TSV pattern (mirrors) |

## Context

ADR-0280 deferred Q6 was "CSV/TSV output:
single-row exports for spreadsheet correlation.
Defer; JSON + jq covers it." ADR-0282 deferred
Q4 was "CSV/TSV output for the diff: single-
record-per-diff layout fits CSV cleanly. Pairs
with ADR-0280 Q6."

Both Q's resolve now that the policy-axes
shapes have stabilized through M4.14.h →
M4.14.e. Real workflows driving the change:

1. **Compliance archival** — auditors want
   tenant-policy snapshots in CSV for the
   yearly retention compliance package; CSV
   plugs into Excel + Pandas pipelines that
   the JSON envelope doesn't.
2. **Cohort divergence reporting** — diffing
   tenants and exporting fieldDiffs to a
   spreadsheet that operations triages.
3. **NUMERIC(18,8) precision preservation** —
   spreadsheet round-trip of cost-ceiling
   values without JS number widening; the
   string preservation already in the JSON
   envelope carries through into CSV.

## Decision

Add `--format csv` and `--format tsv`
(reusing the existing format flag from
ADR-0070-era CLI infrastructure) to
`tenant policies` for BOTH single-tenant
and `--diff` paths. Reuse `printCsv`/
`printTsv` from `format.ts` (same helpers
as `retention.ts`, including `--csv-separator`
support and the `"` + newline rejection
guard).

### Single-tenant row schema

Long format — one row per axis with a shared
wide header. Axis-irrelevant cells render
empty (CSV null = empty string per
`formatCsv` convention).

```
tenant_id,input,axis,table_name,retention_days,
enabled,opt_out,opt_out_reason,opt_out_until,
last_pruned_at,max_usd_per_request,
max_usd_per_window,window_seconds,
effective_from,tier_id,display_name,
effective_source
```

Row ordering (deterministic, by axis
category):

1. Retention rows, sorted by `table_name`
   (defense-in-depth; the upstream
   `listTenantPolicies` already alpha-sorts).
2. Cost ceiling row (if `costCeiling !==
   null`).
3. Tier row (if `tier !== null`).
4. Effective row (if `--effective` set).
5. Explain rows (if `--explain` set):
   `explain.without_override` then
   `explain.without_tier`.

The `axis` column is the discriminator; the
17 data columns cover the union of fields
across all axis types. NUMERIC(18,8) ceiling
values are emitted as their preserved string
representation — spreadsheet round-trips
don't widen to floats.

### Diff row schema

One row per `PolicyFieldDiff` with tenant_a +
tenant_b columns prefixed:

```
tenant_a_id,tenant_a_input,tenant_b_id,
tenant_b_input,axis,field,value_a,value_b
```

Empty `fieldDiffs` still emits the header row
— operators piping into spreadsheet workflows
want the header present even when policies
match. The `--exit-on-divergence` + `--threshold`
exit-code semantic from ADR-0282 is preserved
across all formats including CSV/TSV.

### `--csv-separator` flag

Reuses the existing convention from
`retention.ts`: accepts any single character
EXCEPT `"` (would produce ambiguous quotes)
and newline (would break line-delimited
parsing). Rejected values exit 2 with a
clear error. Default is `,`. Applies to both
single-tenant and `--diff` CSV; ignored under
TSV (tab is hard-coded).

### `--explain` + CSV composition

`--explain` already implies `--effective`
(ADR-0283). Under CSV, this means three extra
rows beyond the base axes: `effective`,
`explain.without_override`, and
`explain.without_tier`. Each is emitted via
the same `buildEffectiveCsvRow` helper so
the layout stays consistent; `effective_source`
reflects the source of THAT walk (`override`
/ `tier` / `none`).

### `--diff` + `--explain` rejection preserved

The existing v1 rejection of `--diff` +
`--explain` from ADR-0283 applies before
the format branch — operators get the same
"mutually exclusive" error in CSV mode.

### Test injection

Reuses existing `pgConnectionOverride` +
`retentionOverride` + `idempotencyStoreOverride`
+ `clockOverride` — no new TenantContext
fields needed. The CSV/TSV branch is pure
output formatting; the gather pipeline is
unchanged.

### CLI help text

Extended the existing `tenant policies` help
block with one paragraph documenting the
row schema, the wide-header layout, the
NUMERIC(18,8) preservation, the empty-diff
header-row behavior, and the `--csv-separator`
flag.

## Rejected alternatives

1. **Wide format with one row per tenant
   and one column per axis-field** — would
   require dynamic columns (one per
   retention table) which break the
   spreadsheet header expectation. Long
   format is the right tradeoff.

2. **Separate `--format csv-retention` /
   `--format csv-ceiling` / `--format csv-
   tier` to emit narrow per-axis tables** —
   N format names doesn't scale and forces
   operators to run N commands for a full
   policy dump. Long format with axis
   discriminator beats it.

3. **Emit `null` literally for empty cells
   instead of empty string** — `formatCsv`
   convention is empty=null. Operators
   reading the CSV in Excel/pandas read
   empty as NaN/None naturally; emitting
   `null` literal would require parsing
   special.

4. **Render `effective_source` as an enum
   number (0=none, 1=tier, 2=override)** —
   string is more spreadsheet-friendly +
   matches the JSON envelope. No need for
   numeric encoding.

5. **Include the `THRESHOLD ALERTS` block
   in CSV** — alerts aren't a policy axis;
   they're an evaluation result. The
   policies CSV is a snapshot of state.
   Housekeeping CSV/TSV (if shipped
   future) would carry alert rows.

6. **Separate CSV path for `--diff` that
   includes the full left + right report
   inline (denormalized)** — explodes row
   count and duplicates data. The
   fieldDiff-per-row design is the right
   compactness.

7. **Header-row-suppression flag for empty
   diff** — header is one line; suppressing
   it makes the CSV invalid (no
   spreadsheet can recover columns from an
   empty file). The header-only output
   is the right v1 behavior.

8. **NDJSON for the policies action** —
   policies is a single-tenant aggregate
   shape, not a stream; NDJSON adds no
   value over the single-envelope JSON.
   CSV/TSV closes the spreadsheet gap;
   NDJSON would add another format-flag
   without a corresponding workflow.

9. **Add a `--format yaml` for tenant
   policies** — operators wanting YAML
   convert from JSON via `jq -y` / `yq`;
   adding a yaml branch duplicates the
   serialization without earning
   workflow value.

10. **Auto-detect format from output
    redirection (TTY → human, pipe → JSON
    or CSV)** — explicit `--format` flag
    is more predictable + scriptable. Auto-
    detect surprises users when behavior
    differs based on terminal.

## Drawbacks

- **Wide header with many empty cells per
  row** — long format means each row has
  ~13 empty cells out of 17. Acceptable
  trade-off; pandas/Excel handle empty
  cells natively. Operators wanting
  compact per-axis tables run `jq` over
  the JSON output.
- **The `axis` discriminator forces
  operators to filter** — to get just
  retention rows in Excel, operators
  filter `axis = "retention"`. One extra
  step vs separate per-axis CSV outputs;
  the simplicity of a single command
  outweighs the filter cost.
- **`--diff` CSV doesn't surface the full
  left + right report shape** — only the
  fieldDiffs. Operators wanting both raw
  reports run two single-tenant CSVs
  separately + join on tenant_id in their
  spreadsheet. Acceptable scope for v1.
- **NUMERIC(18,8) strings render with
  trailing zeros** ("0.10000000" not
  "0.1") — preserves the database
  representation faithfully but is
  cosmetically verbose. Operators wanting
  display-formatted numbers post-process
  in the spreadsheet.
- **`explain.without_*` axis names use
  snake_case while the JSON envelope uses
  camelCase** (`withoutOverride` /
  `withoutTier`) — CSV columns conventionally
  snake_case, JSON conventionally camelCase.
  Operators reading both formats need to
  remember the mapping; documented in the
  CLI help.

## Future Qs

1. **`--csv-effective-only` flag emitting
   ONLY the effective row** — useful for
   bulk operators dumping effective
   ceilings across many tenants without
   the per-axis rows. Pairs with a future
   `tenants list --policies` bulk export.

2. **`--csv-wide` mode pivoting retention
   rows into a single row with one column
   per table** — narrow target audience
   (operators with a fixed known table
   set); defer.

3. **CSV header customization (snake_case
   vs camelCase vs kebab-case)** — adds
   API surface for niche preference.
   Defer.

4. **Streaming CSV for `tenants list
   --has-overrides --format csv` (one
   row per tenant)** — pairs with a
   future bulk-export surface. Not in
   scope here.

5. **CSV/TSV for `tenant housekeeping`** —
   the dashboards have a wider field set
   (combined gateway + retention table
   rows). Pairs with ADR-0273 Q6 or
   ADR-0284 future work; defer.

6. **`--format excel` (XLSX binary)** —
   adds a binary-output complication
   (pipes don't work; need
   `--output <file>`). Operators run
   CSV through pandas/openpyxl if they
   want XLSX. Defer.

7. **Row-per-diff with synthesized
   "matched" rows when `value_a ===
   value_b`** — would emit one row per
   field-considered (matched OR
   diverged) for full audit trace.
   Larger output; opt-in via
   `--diff-include-matched` if needed.
   Defer.
