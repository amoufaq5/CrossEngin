# ADR-0227: Retention CLI `--format=csv` output format

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.csv-format
- **Closes**: ADR-0224 future Q5 (CLI output format variants —
  `--format=csv`)
- **Related**: ADR-0224 (family-wide JSON envelope conventions), ADR-0226
  (cross-flag contradiction detection)

## Context

ADR-0224 codified canonical JSON envelope conventions for retention CLI
actions. The future-Qs section deferred CLI output format variants
(`--format=csv`, `--format=tsv`, `--format=yaml`) to an operator-ergonomics
milestone. This ADR closes the `--format=csv` portion of that Q.

### Why CSV matters for operators

1. **Spreadsheet ingestion** — operators dropping retention history into
   Excel/Numbers/Google Sheets for ad-hoc analysis.
2. **Data pipeline integration** — CSV is the lingua franca of ETL
   pipelines (Airflow, dbt, custom scripts) without requiring JSON parsers.
3. **Audit logs in shared drives** — operators producing CSV exports for
   compliance/audit teams who work in spreadsheets.
4. **`awk` / `cut` shell pipelines** — line-oriented CSV is trivially
   processed with standard Unix tools.
5. **Dashboarding tools** — many BI tools accept CSV uploads directly.

### Why not TSV / YAML in same milestone

- TSV is a trivial variant of CSV (tab separator instead of comma); adding
  it doubles the code paths without adding meaningfully different
  operator workflows. Defer.
- YAML for tabular retention data is uncommon; operators preferring YAML
  usually want it for config-style structured documents, not row-wise
  data. Defer.
- `--format=csv` is the highest-impact single format addition.

## Decision

Add `--format=csv` as the 3rd output format option across all retention
CLI surfaces. Emits RFC 4180-compliant CSV with surface-appropriate column
schemas.

### `OutputFormat` extended

```ts
export const OUTPUT_FORMATS = ["human", "json", "csv"] as const;
```

The parsed-command layer accepts `--format=csv` and surfaces it to handlers
as `command.format === "csv"`.

### CSV helpers in `format.ts`

Two new exported helpers:

```ts
export function escapeCsvCell(value: unknown): string;
export function formatCsv(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): string;
export function printCsv(
  io: IoStreams,
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): void;
```

`escapeCsvCell` implements RFC 4180:
- `null` / `undefined` → empty string
- Strings containing `,`, `"`, `\n`, or `\r` are wrapped in `"..."` with
  embedded `"` doubled (`""`).
- Object/array values are JSON-stringified first then escaped.
- Primitives (number, boolean) rendered via `String()`.

### Per-surface column schemas

**Retention history** (10 columns base + 2 with `--with-actor-names`):

```
id, tenant_id, table_name, event_kind, actor_id, occurred_at,
prev_state, next_state, attributes
[, actor_display_name, actor_email]
```

**Retention diff-timeline pair-wise**:

```
id, tenant_id, tenant_side, table_name, event_kind, actor_id,
occurred_at, prev_state, next_state, attributes
[, actor_display_name, actor_email]
```

**Retention diff-timeline N-way (`--add-tenant`)**:

```
id, tenant_id, tenant_label, table_name, event_kind, actor_id,
occurred_at, prev_state, next_state, attributes
[, actor_display_name, actor_email]
```

**Retention diff-timeline cross-table (`--cross-table`)**:

```
id, tenant_id, table_name, table_label, event_kind, actor_id,
occurred_at, prev_state, next_state, attributes
[, actor_display_name, actor_email]
```

**Retention diff-history** (different semantic — emits field-diff rows
since the surface is per-event-pair comparison):

```
field, value_a, value_b
```

### Column naming convention

- Column headers use snake_case matching the underlying PG column names
  (where applicable) and the `OptOutHistoryEntry` / `TimelineEntry` field
  names (camelCase fields → snake_case columns).
- Surface-discriminator columns: `tenant_side` (pair-wise), `tenant_label`
  (N-way), `table_label` (cross-table). Operator can identify the surface
  by column presence.

### JSON columns within CSV

`prev_state`, `next_state`, `attributes` are JSON-typed columns in the
data model. CSV rendering JSON-stringifies them as a single cell value,
then escapes per RFC 4180 (typically wrapped in `"..."` since they
contain commas / quotes).

Example:
```csv
id,...,prev_state,next_state,attributes
abc,...,,"{""opt_out"":true,""retention_days"":365}",{}
```

### Empty-result CSV

When zero entries match, CSV emits the header row only (no separator
line, just the headers followed by trailing newline). This is RFC 4180-
compliant and parseable by standard CSV readers.

### Pagination cursor handling

CSV format does NOT emit pagination cursors (`nextAfterId`,
`nextBeforeId`). CSV is a flat row-oriented format; cursor pagination is
a JSON-envelope feature. Operators needing cursors should use
`--format=json`.

### Format flag validation

`--format=csv` accepted at the CLI parse layer; unknown format values
still produce exit-2 errors per existing behavior.

## Rejected alternatives

1. **Add TSV + YAML in same milestone** — scope creep; CSV is the
   highest-impact single addition; defer TSV/YAML to separate milestones.
2. **Use a CSV library dependency (e.g., `csv-stringify`)** — adds
   external dependency for ~30 lines of RFC 4180-compliant code; the
   in-repo helper is small and well-tested.
3. **Emit pagination cursors as a trailing comment line** — non-standard
   CSV; breaks parsers that don't expect comments; operators wanting
   cursors should use JSON.
4. **Use semicolon as separator (Excel-friendly in some locales)** — CSV
   means comma-separated; locale-specific defaults are out of scope.
5. **Emit BOM for Excel UTF-8 compatibility** — operators using `awk`/
   `cut` pipelines don't want BOM; if Excel compat matters, operators
   can prepend BOM via shell.
6. **JSON-stringify with pretty-printing inside CSV cells** — readability
   per-cell would be inflated; compact JSON is more spreadsheet-friendly.
7. **Per-cell type-aware rendering (boolean → TRUE/FALSE, number →
   number, string → quoted-when-needed)** — operators reading CSV want
   consistent quoting rules; type-aware would surprise operators when
   field types change.
8. **Different column schema per surface using a generic discriminator
   column** — surface-specific columns (`tenant_side`, `tenant_label`,
   `table_label`) more readable than a generic `discriminator` column
   with parsed-string values.
9. **Allow `--csv-headers=false` to skip header row** — headers are
   essential for operator readability; if scripts need headerless CSV,
   they can `tail -n +2` the output.
10. **Emit field-diff rows for diff-history with the per-event-pair
    metadata (id_a, id_b, tenant_id, etc.) as extra columns per row** —
    metadata is duplicated across all rows; cleaner to keep diff-history
    CSV focused on the field-diff data only.

## Future questions

1. **`--format=tsv` (tab-separated values)** — variant of CSV with tab
   separator; mechanical addition following the CSV pattern. Defer.

2. **`--format=yaml`** — operators using YAML for config-style output.
   Defer — less common for tabular retention data.

3. **`--format=ndjson` (newline-delimited JSON)** — for streaming JSON
   per-row; useful for log pipeline ingestion. Defer.

4. **`--csv-separator <char>` flag for custom separators** — accommodate
   locale-specific spreadsheet defaults. Defer — operator-policy.

5. **Pagination cursor emission as separate file or stderr-line** — for
   CSV pipelines that need to chain multiple pages. Defer — operators can
   parse cursor from JSON envelope and re-issue with `--format=csv` for
   the data.

6. **CSV output for non-list retention actions (`retention set`,
   `retention restore`, etc.)** — these actions return single-row
   results; CSV would be 1-row output. Defer — JSON envelope is more
   natural for single-row structured data.

## Consequences

- **Operator ergonomic improvement** — operators can pipe retention CLI
  output directly into spreadsheets, ETL pipelines, awk/cut, and BI
  tools without intermediate JSON parsing.
- **Test count: 9,170 → 9,194** (+24 net: 11 CLI tests in retention.test.ts
  for per-surface CSV + 13 unit tests in format.test.ts for CSV helpers).
- **No adapter changes** — pure CLI-side output rendering; adapter
  contract unchanged.
- **No breaking changes** — `--format=csv` is ADDITIVE alongside existing
  `--format=human` and `--format=json`.
- **`OutputFormat` type extended** — third value `"csv"` added to the
  union; parser accepts the new format string.
- **3 retention surfaces have CSV** — history (list), diff-timeline (list
  across 3 dispatch paths), diff-history (field-diff rows). Surface-
  appropriate column schemas.
- **Pagination cursors documented as JSON-only** — operators needing
  cursor-based pagination across multiple pages must use `--format=json`.
- **Pattern documented for future surfaces** — when new retention actions
  add list-style output, they inherit the CSV pattern via the shared
  `printCsv` helper.
