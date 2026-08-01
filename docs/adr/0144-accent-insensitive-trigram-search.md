# ADR-0144: Accent-insensitive + trigram-indexed substring search

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0143 (`contains` operator + typeahead), ADR-0090 (column-mapped store) |

## Context

The `contains` list-filter operator (ADR-0143) was case-insensitive (`ILIKE`) but not
accent-insensitive, and its `ILIKE '%…%'` had no index acceleration — a full scan on large
tables. Delivered as one of a four-agent batch of polish follow-ups.

## Decision

- **Accent-insensitive `contains` (`list-sql.ts`).** The `contains` predicate now folds both
  sides with `unaccent()`: `unaccent(<expr>::text) ILIKE ('%' || unaccent($n) || '%')` — so
  "jose" matches "José". The value stays bound (`$n`), never interpolated. Serves both PG
  stores through the shared builder.
- **Extensions (`column-store.ts`).** `ensureSchema` now runs `CREATE EXTENSION IF NOT
  EXISTS unaccent` + `pg_trgm` (idempotent), alongside the existing pgcrypto provisioning.
- **Trigram GIN index (`entity-ddl.ts`).** `emitEntityTableDdl` emits one plain-column
  trigram GIN index per plaintext text/varchar/char column (`isTrigramIndexable` excludes
  BYTEA/encrypted + non-text types): `CREATE INDEX IF NOT EXISTS "<t>_<c>_trgm" ON … USING
  gin ("<col>" gin_trgm_ops)`, name deterministic + truncated to Postgres's 63-char limit.
  Deliberately a **plain-column** index, not `unaccent(col)` — `unaccent()` is not IMMUTABLE
  and cannot back a functional index.

## Consequences

- Substring search is accent-insensitive and index-accelerated on the column store; the
  reference-picker typeahead (ADR-0143) benefits directly.
- `operate-runtime-pg` tests updated (the new `contains` SQL form; 4 DDL assertions — index
  emitted for text, none for numeric/encrypted, no functional-unaccent index). 101 pass.
- **Follow-up / caveat:** the JSONB store's `contains` also emits `unaccent(...)`, but its
  `meta.operate_entity_records` table is provisioned by the kernel bootstrap, which does not
  yet `CREATE EXTENSION unaccent/pg_trgm`. A deployment serving `--store pg` (JSONB) with a
  contains filter must have those extensions present; wiring them into the kernel bootstrap
  is the follow-up. The column store (`--store pg-columns`) is self-sufficient.
