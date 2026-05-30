# ADR-0293: `tenants list --format csv-full` 11-column bulk export

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0289 Q1 (closes), ADR-0289 (tenants list CSV/TSV), ADR-0273 (tenants namespace) |

## Context

ADR-0289 Q1 deferred "`--format csv-full`
variant emitting all TenantRowFull
columns" after M4.15.b shipped the
compact 5-column shape. Operators
preparing full audit exports (e.g.,
quarterly SOC 2 evidence) needed the
wider row shape including region,
schema, residency, locale, and
timestamps — not just the 5
compact columns.

Real workflows:

1. **Quarterly compliance audit
   export** — GRC team needs every
   tenant's full record (region,
   residency, timestamps) as CSV
   for SOC 2 evidence.
2. **Migration verification** —
   operators verifying tenant
   data residency post-migration
   want the full row including
   schema_name + residency JSONB.
3. **Tenant inventory bulk-
   review** — auditor opens
   full-shape CSV in Excel,
   pivots by region + tier.

## Decision

Add `csv-full` as a new format
value. Honored by `tenants list`
only; other surfaces fall through
to human format (consistent with
gh-summary precedent).

### Column shape

11 columns matching
TenantRowFull:

```
id, slug, name, status, tier,
region, schema_name, residency,
search_locale, created_at,
updated_at
```

Same columns as `tenants get`
single-row output. The
`residency` JSONB column
serializes to compact JSON
string for CSV cell
embedding. Timestamps emitted
in stable ISO format
(`YYYY-MM-DDTHH:MM:SS.MSZ`)
via PostgreSQL `to_char` —
identical to the per-tenant
`tenants get` query.

### Query path

New `buildListQueryFull`
mirrors the structure of
`buildListQuery` but with
the wider SELECT clause +
ISO timestamp formatting.
Filters (`--status`,
`--table-filter`,
`--has-overrides`) compose
identically.

### CSV rendering

`residency` JSONB column
serialized via
`JSON.stringify(r.residency)`
before passing to printCsv.
The CSV-quote mechanism in
printCsv handles embedded
commas + quotes via the
standard quote-wrapping
convention
(`"{""primary"":""us-east-1""}"`).

Null residency → null
cell → empty CSV string
(matches printCsv null
convention from existing
codepaths).

### Format value naming

`csv-full` not `csv2` or
`csv-extended`:
- Semantically clear:
  "the full version of CSV"
- Doesn't suggest
  versioning (csv2 implies
  the existing csv is
  obsolete)
- Hyphenated form matches
  `gh-summary` precedent
- Leaves `csv` as the
  compact default

### Fall-through for other
surfaces

Surfaces that don't
implement csv-full silently
fall through to human
format (matches gh-summary
M4.15.e pattern). This
means `tenant policies acme
--diff foo --format
csv-full` produces human
output, not an error.
Documented in CLI help.

## Rejected alternatives

1. **Use `--full` boolean
   flag combined with
   `--format csv`** —
   couples format choice
   with a separate flag,
   complicating downstream
   consumers (CSV
   processors that
   inspect `--format`
   alone wouldn't see the
   variant). The
   separate format value
   is clearer.

2. **Replace the
   compact `--format csv`
   with the full shape**
   — breaks backward
   compat for operators
   already scripting
   against M4.15.b
   output.

3. **Make csv-full the
   default and rename
   the compact form
   `csv-compact`** —
   same backward-compat
   break.

4. **Include
   per-tenant policy
   counts in csv-full**
   — would require
   GROUP BY join; the
   query semantic
   differs. Defer to
   the future
   `--include-policy-
   count` flag from
   ADR-0289 Q2.

5. **Use NDJSON for
   the full shape**
   (one TenantRowFull
   per line) — useful
   for streaming but
   spreadsheet
   workflows want CSV.
   Operators wanting
   NDJSON use
   `--format ndjson`
   (planned, not yet
   wired for tenants).

6. **Embed residency
   as multiple
   denormalized
   columns** (primary,
   failover, etc.)
   — residency JSONB
   has variable shape
   per tenant; flatten-
   ing requires
   knowing the schema
   upfront. JSON-in-
   cell preserves
   flexibility.

7. **Add column
   selection via
   `--columns
   region,tier`** —
   over-engineered for
   v1. The two-format
   compact/full split
   covers the common
   cases.

## Drawbacks

- **JSON-in-CSV cells
  are awkward for raw
  reading** — operators
  inspecting CSV with
  `head` see escaped
  quotes around the
  residency cell.
  Spreadsheet imports
  handle it correctly;
  raw-text consumers
  need to JSON-parse
  the cell content.

- **Two query paths**
  (`buildListQuery` +
  `buildListQueryFull`)
  means filter-logic
  changes need
  updating in two
  places. Acceptable
  — the filter logic
  is identical
  modulo SELECT;
  future refactor
  could extract a
  shared WHERE
  builder.

- **csv-full not
  available on other
  surfaces yet** —
  operators expecting
  `--format csv-full`
  on retention diff
  etc. silently get
  human output.
  Documented but
  could surprise.

- **Timestamp
  rendering hardcoded
  to UTC + ISO 8601**
  — operators wanting
  local time zone
  would need
  post-processing.
  Acceptable; UTC is
  the canonical
  audit format.

## Future Qs

1. **`--include-
   policy-count`
   computed column**
   (closes ADR-0289
   Q2). GROUP BY
   join. Adds 1
   column to either
   compact or full
   variant.

2. **`--columns
   id,slug,region`
   selection** —
   override format-
   chosen columns
   with a custom
   subset.

3. **`--format
   csv-full` for
   `tenants get`
   too** — currently
   `tenants get`
   has json + human
   only; would need
   a single-row CSV
   path.

4. **Timezone
   flag (`--tz
   America/New_York`)
   for timestamp
   rendering** —
   useful for
   timezone-aware
   GRC reports.

5. **`--include-
   tier-detail`
   joining
   meta.llm_cost_
   tiers for the
   tier display
   name + ceiling**
   — pairs with
   tier-membership
   audits.

6. **NDJSON
   format for the
   full shape**
   for streaming
   large tenant
   lists (>10k).

7. **`--exclude-
   residency`
   privacy flag**
   to omit the
   residency
   column when
   exporting
   externally
   (PII-aware
   audits).
