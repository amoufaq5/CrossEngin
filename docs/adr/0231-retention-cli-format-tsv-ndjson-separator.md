# ADR-0231: Retention CLI output format expansion (`--format=tsv` + `--format=ndjson` + `--csv-separator`)

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.format-tsv-ndjson-separator
- **Closes**: ADR-0227 future Qs 1 (`--format=tsv`), 3 (`--format=ndjson`),
  4 (`--csv-separator`)
- **Related**: ADR-0227 (CSV output format), ADR-0224 (envelope shape
  conventions)

## Context

ADR-0227 shipped `--format=csv` and deferred three follow-up output
format variants:
- Q1: `--format=tsv` — tab-separated values for shell pipelines using
  `awk` / `cut` / `tab`-aware tools.
- Q3: `--format=ndjson` — newline-delimited JSON for streaming log
  pipeline ingestion (e.g., Loki, Splunk, Filebeat).
- Q4: `--csv-separator <char>` — custom CSV separator for locale-specific
  spreadsheet defaults (e.g., semicolon for European Excel).

All three share the mechanical "extend CSV output" pattern; bulking them
into one milestone avoids 3× admin overhead. This ADR closes all three
ADR-0227 follow-up Qs.

### Why bulk

- Each addition is mechanical (small code, share the CSV pattern).
- Operators using one of these formats often want another (CSV pipelines
  graduate to NDJSON; international operators need both `--csv-separator`
  and `--format=tsv`).
- Single ADR with consolidated rejected alternatives + future Qs.

### Why no `--format=yaml`

YAML output for tabular retention data isn't a common operator workflow
(YAML is usually for config-style structured documents, not row data).
Not included in this milestone; deferred.

## Decision

Extend the retention CLI's output format options to include `tsv`,
`ndjson`, and a `--csv-separator <char>` flag.

### `OutputFormat` extended

```ts
export const OUTPUT_FORMATS = ["human", "json", "csv", "tsv", "ndjson"] as const;
```

The parsed-command layer accepts `--format=tsv` and `--format=ndjson`.
Unknown format values still produce exit-2 errors per ADR-0227.

### Format helpers added to `format.ts`

```ts
export function escapeCsvCellWithSep(value: unknown, separator: string): string;
export function formatCsv(headers, rows, separator = ","): string;  // separator added
export function formatTsv(headers, rows): string;
export function printTsv(io, headers, rows): void;
export function formatNdjson(rows): string;
export function printNdjson(io, rows): void;
```

#### TSV escaping

TSV uses tab (`\t`) as the separator. Quoting rules borrow from CSV (RFC
4180-style): wrap cell in `"..."` if it contains tab, quote, newline, or
carriage return. Embedded quotes doubled (`""`). Commas are NOT quoted
(allowed in TSV).

#### NDJSON

One JSON object per line. No enclosing array, no commas between objects.
Trailing newline at end of file. Empty result emits just trailing
newline.

Streamable: each line is independently parseable. Compatible with
`jq -c` output, log aggregators (Loki / Splunk / Filebeat), and Spark /
DuckDB JSON readers.

#### `--csv-separator <char>`

Custom separator only applies to `--format=csv`. Default is `,`.
Validation:
- Cannot be `"` (RFC 4180 reserved quote character).
- Cannot be `\n` or `\r` (would conflict with line terminators).
- Any other character allowed (semicolon `;`, pipe `|`, etc.).

`escapeCsvCellWithSep` quotes cells containing the configured separator
(or `"` / `\n` / `\r`) per RFC 4180 rules.

### Per-surface support

All 3 retention surfaces handle the new formats:
- **retention history** — entries → CSV/TSV rows OR NDJSON entries
- **retention diff-history** — fieldDiffs → CSV/TSV rows OR NDJSON
  field-diff entries
- **retention diff-timeline** (3 dispatch paths) — entries → CSV/TSV
  rows OR NDJSON entries

### `--explain` interaction

`--explain` already emits JSON-only output for non-human formats (ADR-
0228 explicit choice — plan is single-row, doesn't fit tabular). Updated
condition from `format === "json" || format === "csv"` to `format !==
"human"` so tsv/ndjson also fall back to JSON for explain output.

### `--csv-separator` only applies to CSV

TSV uses tab (hardcoded; tab IS the defining feature of TSV).
NDJSON doesn't have a separator concept (newline-delimited objects).
`--csv-separator` with `--format=tsv` is parsed but ignored.
`--csv-separator` with `--format=ndjson` is parsed but ignored.

### Help text

Global flag documentation updated:
```
--format human|json|csv|tsv|ndjson  Output format (default: human). csv/tsv/ndjson are
                                    supported on list-style retention actions (history +
                                    diff-timeline); diff-history csv/tsv emits field-diff
                                    rows. ndjson emits one entry per line (no envelope).
--csv-separator CHAR                Custom CSV separator (default: ','). Only applies to
                                    --format=csv. Cannot be '"' or newline.
```

## Rejected alternatives

1. **Ship `--format=tsv` / `--format=ndjson` in 3 separate milestones**
   — admin overhead (3× CLAUDE.md/README.md/index.md/commit churn)
   without architectural benefit; bulking is the pragmatic choice.
2. **Auto-detect TSV vs CSV based on separator** — `--format=csv
   --csv-separator='\t'` would produce TSV; conceptually unclear;
   explicit `--format=tsv` is operator-friendlier.
3. **YAML format in same milestone** — uncommon for tabular retention
   data; defer.
4. **Use `--separator` instead of `--csv-separator`** — `--separator`
   too generic; might apply to TSV/NDJSON ambiguously. `--csv-separator`
   is explicit about scope.
5. **`--ndjson-pretty` for prettyprinted NDJSON** — defeats NDJSON's
   line-oriented purpose; operators wanting pretty JSON should use
   `--format=json`.
6. **Allow `--csv-separator` to be multi-character** — RFC 4180
   single-char separator is canonical; multi-char separator complicates
   escaping rules; defer.
7. **Include BOM in TSV / CSV for Excel UTF-8** — operators using
   awk/cut pipelines don't want BOM; if Excel compat matters, operators
   prepend BOM via shell.
8. **Support `--csv-quote <char>` for custom quote character** — RFC
   4180 standard quote is `"`; custom quote breaks parser
   compatibility; defer.
9. **NDJSON line-prefix discriminator (`{"_action":"history", ...}`)** —
   operators using NDJSON typically pipe into structured log
   aggregators that key on field names; line-prefix discriminator
   would duplicate the `action` field that JSON envelope provides.
   Defer.
10. **TSV with mandatory double-quote wrapping (Excel-friendly TSV)** —
    standard TSV doesn't wrap unless needed; Excel-friendly variant
    would be operator-policy.

## Future questions

1. **`--format=yaml`** — operators using YAML for config-style output.
   Defer — less common for tabular retention data.

2. **`--ndjson` aliasing for `--format=ndjson`** — operators familiar
   with `jq -c | ndjson` may want shorter flag. Defer — `--format=
   ndjson` is consistent with existing pattern.

3. **`--format=parquet` for columnar data analysis pipelines** — would
   require parquet encoding dependency; significant scope. Defer.

4. **`--format=arrow` for Apache Arrow streaming** — similar to parquet.
   Defer.

5. **Compression flags `--gzip` / `--zstd`** — for very large result
   sets; operators can pipe through `gzip` shell util. Defer.

6. **CSV/TSV/NDJSON output for non-list retention actions** — single-
   row results (set / restore / etc.) don't naturally fit tabular
   formats; JSON envelope is more natural. Defer.

## Consequences

- **3 ADR-0227 future Qs closed in one milestone** — `--format=tsv`
  (Q1), `--format=ndjson` (Q3), `--csv-separator` (Q4).
- **Operator format coverage expanded** — operators can pipe retention
  output into:
  - Spreadsheets (csv, tsv with locale-specific separator via
    `--csv-separator`)
  - awk/cut shell pipelines (tsv preferred; csv if no embedded
    commas)
  - Log aggregators (ndjson via Loki / Splunk / Filebeat)
  - Spark / DuckDB / Pandas (ndjson or csv)
  - International Excel (csv with `--csv-separator=';'`)
- **Test count: 9,229 → 9,257** (+28 net: 18 format unit tests + 10
  CLI retention tests).
- **No adapter changes** — pure CLI-side rendering; adapter contract
  unchanged.
- **No breaking changes** — `--format=tsv` / `--format=ndjson` /
  `--csv-separator` are ADDITIVE alongside existing formats.
- **`--explain` JSON fallback simplified** — `format !== "human"` now
  covers json/csv/tsv/ndjson uniformly (instead of `json || csv`
  enumeration).
- **All 3 retention surfaces support new formats** — history (list),
  diff-history (field-diffs), diff-timeline (3 dispatch paths).
- **`--csv-separator` validation** — operators get clear exit-2 error
  for `"` / newline; other characters allowed.
- **Pattern documented for future formats** — when new format variants
  are added (yaml, ndjson, parquet), they extend the same
  `OutputFormat` union + per-surface branches.
