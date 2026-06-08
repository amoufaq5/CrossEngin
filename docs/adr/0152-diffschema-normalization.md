# ADR-0152: diffSchema normalization — TIMESTAMPTZ / defaults / unique-index naming (Phase 3 P2.44)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0145 (schema drift CI gate), ADR-0047 (kernel-pg), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.44).

## Context

P2.36 (ADR-0145) wired `crossengin-pg drift` into CI as a schema-drift gate, but
it was never validated against a freshly-provisioned database — the implementing
work only ran `build` + `typecheck`. When the gated DB path was finally exercised
(during the P2.40–P2.43 consolidation), `crossengin-pg drift` reported drift on
**every one of the 125 meta tables** — all false positives from three
normalization gaps in `kernel-pg`'s `diffSchema`, leaving the CI gate red:

1. **Type spelling.** `META_TABLES` declares `TIMESTAMPTZ` / `UUID` / `VARCHAR(255)`
   / `BOOLEAN`; `pg_catalog.format_type` reports `timestamp with time zone` /
   `uuid` / `character varying(255)` / `boolean`. The old `normalizeType` only
   lowercased + collapsed whitespace, so every timestamp/varchar/etc. column read
   as a `[type]` change.
2. **Default casts.** Postgres renders string-literal / enum defaults with an
   explicit cast (`'active'` → `'active'::text`, `'sev3'` → `'sev3'::"Severity"`);
   `META_TABLES` declares them without, so every defaulted enum/text column read
   as a `[default]` change.
3. **Unique-constraint indexes.** Column-level `unique` + table-level
   `uniqueConstraints` are declared as *constraints*, not `indexes`, but Postgres
   backs each with an index that introspection returns — so every unique
   constraint read as a `removed index` (`…_key`).

## Decision

Three pure fixes in `packages/kernel-pg/src/diff.ts` (no introspection-query
change, no behavior change to genuine drift detection):

- **Type aliasing.** `normalizeType` now maps the declared SQL spellings to the
  canonical `format_type` form via a `TYPE_ALIASES` table (timestamptz → timestamp
  with time zone, varchar → character varying, int4/int8/int2/bool/decimal/float4/
  float8, …), splitting off any `(precision)` and normalizing comma spacing
  (`numeric(12, 4)` → `numeric(12,4)`) so it survives the alias rewrite.
- **Cast-insensitive defaults.** `normalizeDefault` strips `::type` casts (quoted
  ident or lowercase type words + optional precision) from both sides before
  comparing, so `'active'` ≡ `'active'::text` and `'[]'::jsonb` ≡ `'[]'::jsonb`.
- **Unique backing indexes.** `diffOneTable` computes the set of expected
  unique-constraint index names — `uc.name` for each `uniqueConstraints` entry,
  `col.unique.constraintName` for the object form, and the Postgres auto-name
  `<table>_<col>_key` for `unique: true` — and excludes them from `removedIndexes`
  (with a column-set fallback for a single-column `unique: true` in case Postgres
  truncated the auto-name). A declared unique constraint whose backing index is
  **absent** live is still surfaced as drift (added/missing).

## Cross-cutting invariants enforced (by tests)

- **Type aliases** — `TIMESTAMPTZ` / `NUMERIC(12, 4)` / `VARCHAR(255)` / `BOOLEAN`
  read no drift against `timestamp with time zone` / `numeric(12,4)` /
  `character varying(255)` / `boolean`.
- **Default casts** — `'active'` vs `'active'::text`, `'[]'::jsonb` vs
  `'[]'::jsonb`, `now()` vs `now()` all read clean.
- **Unique constraints** — `unique: true` (auto `<table>_<col>_key`),
  `unique: {constraintName}`, and table-level `uniqueConstraints` backing indexes
  are not flagged removed; a missing unique-constraint index *is* flagged.
- **Real-PG.** `crossengin-pg drift` over the freshly-bootstrapped 125-table
  `meta` schema now reports `(no drift)` / exit 0 — the gate is genuinely green.

## Alternatives considered

- **Suppress the gate / `--exit-zero-on-drift` in CI.** No — that defeats the
  point; the gate must detect real drift, which it now does without the false
  positives.
- **Change the introspection queries to emit the declared spellings.** No — the
  catalog's `format_type` output is the canonical truth; normalizing the
  comparison (not the source) is correct and keeps introspection faithful.
- **Match unique constraints by column-set only.** Used as a fallback for
  single-column `unique: true`, but name-based matching is exact for the explicit
  `uniqueConstraints` / object-form constraint names and catches a missing one.

## Consequences

- **62 packages + 3 apps, 125 meta-schema tables, 6,700 offline tests + 37 gated
  real-Postgres integration tests** (+4 offline diff tests; 0 new
  tables/columns/packages). The P2.36 schema-drift CI gate is now **truly green**
  on a freshly-provisioned database — the meta-schema applier path is genuinely
  self-policing, and a real added/removed/modified table/column/index/policy still
  fails the build.
- The four CI gates (schema-drift · incident-drift · PHI-encryption ·
  gateway-execution) all pass against the live database.
