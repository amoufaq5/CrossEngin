# ADR-0297: `tenants get --format csv|tsv|csv-full` single-row export

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0293 Q3 (closes), ADR-0285 Q4 (M4.15.b list csv), ADR-0292 (M4.15.f list csv-full) |

## Context

ADR-0293 Q3 deferred "single-row
CSV/TSV format support for
`tenants get`." After M4.15.b
(list csv) + M4.15.f (list
csv-full) closed the bulk-export
path, operator workflows like:

```bash
# Export bulk
crossengin tenants list \
  --format csv-full > all.csv
# Append per-tenant fetches
crossengin tenants get acme-prod \
  --format csv-full | tail -1 \
  >> all.csv
```

didn't work — `tenants get` only
supported json/human format,
forcing operators to either
re-fetch via `tenants list
--slug acme-prod` (no such
filter) or post-process JSON
with jq into CSV.

## Decision

Add `--format csv|tsv|csv-full`
branches to `runTenantsGet`.
Column order matches `tenants
list` exactly:

- **csv/tsv** (5 cols): id,
  slug, name, status, tier
- **csv-full** (11 cols): id,
  slug, name, status, tier,
  region, schema_name,
  residency (JSONB → compact
  JSON), search_locale,
  created_at, updated_at

Single-row output means
header + 1 data row. The
column-order parity with
`tenants list` is the
critical operational
property: per-tenant
fetches can be concat'd
onto list-bulk output
without re-aligning
columns.

### --csv-separator
support

Honored on both csv +
csv-full (TSV uses tab
always). Same validation
as list path.

### residency
serialization

JSONB → compact
`JSON.stringify` for CSV
cell. printCsv quotes
the cell because of
embedded quotes (",")
producing the standard
RFC-4180 escaped form
`"{""primary"":""...""}"
`. Null residency → empty
cell (printCsv handles
null gracefully).

### Resolve path
unchanged

Slug→UUID resolve still
runs for slug input
regardless of format
(2 queries for slug, 1
for UUID input). CSV
output is a presentation
concern only.

## Rejected
alternatives

1. **Match human
   format's 9-column
   subset rather than
   11-col TenantRow
   Full** — would break
   list/get concat
   workflows. csv-full
   means csv-full,
   identically.

2. **Add an
   `--include-policy-
   count` to `tenants
   get` mirroring
   list** — per-tenant
   policy count is a
   trivial COUNT(*),
   useful for cohort
   work, but operators
   wanting it have
   `tenants list
   --filter slug=X
   --include-policy-
   count` (hypothetical
   future filter)
   already. Defer.

3. **Emit only data
   row, no header** —
   would be more
   concat-friendly
   (avoid duplicate
   headers when
   appending). But
   makes the output
   useless standalone
   and breaks pandas
   `read_csv`. Defer
   a `--no-header`
   flag to a future
   Q if requested.

4. **Use a different
   column order
   (timestamps first
   for sortability)**
   — would break
   list/get column
   parity, the whole
   point of this
   milestone.

5. **Special-case
   null residency to
   `null` string
   rather than empty
   cell** — printCsv's
   contract is "null
   → empty cell"
   (RFC-4180-ish). The
   "" empty-cell
   convention is what
   pandas + Excel
   expect when
   importing.

6. **Add Markdown /
   gh-summary
   single-row** —
   gh-summary is a
   verdict format
   (✅/⚠️ + diff
   table), not a
   data dump. A
   single tenant row
   is the wrong
   shape for it.

## Drawbacks

- **CSV header on
  every per-tenant
  fetch** means
  concat'd output has
  duplicate headers
  unless operators
  use `tail -1` (the
  exact pattern
  documented in the
  help text). Manual.
  Acceptable until
  `--no-header` is
  added.

- **No way to
  fetch only a
  subset of columns**
  — operators
  wanting just slug
  + name use jq on
  `--format json`.
  A `--columns
  slug,name` flag
  could come later
  but adds a
  surface to
  maintain.

- **printCsv's
  quote-on-quote
  behavior makes
  the residency
  cell verbose**
  — escaped JSON
  is hard to
  eyeball. Operators
  wanting clean
  JSON use
  `--format json
  | jq '.tenant
  .residency'`.

## Future Qs

1. **`--no-header`
   flag** — for
   per-tenant fetches
   that will be
   concat'd onto
   list output, the
   header is
   redundant.

2. **`--columns
   col1,col2`
   filter** — select
   a subset of
   columns to emit.

3. **`tenants get
   --slugs
   a,b,c`** — bulk
   per-slug fetch
   in one call.

4. **Same csv +
   csv-full for
   `tenants
   resolve`** —
   currently only
   emits UUID +
   newline; csv
   would be slug,
   uuid pair.

5. **CSV envelope
   `# action:
   tenants.get` as
   a leading
   comment line**
   — matches the
   JSON envelope's
   `action`
   field. Maybe a
   `--csv-envelope`
   opt-in.
