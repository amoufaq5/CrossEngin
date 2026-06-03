# ADR-0090: column-mapped entity store — typed per-entity tables (Phase 3 P1.10)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0086 (operate-runtime-pg JSONB store), ADR-0088 (list pagination), ADR-0066/0067 (data classification), ADR-0070 (pgcrypto at-rest), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P1 follow-on increment (P1.10), the deeper follow-up
> ADR-0086 named.

## Context

ADR-0086 shipped `PostgresEntityStore` over a single JSONB document table and
explicitly deferred "column-mapped per-entity tables (DDL emitted from the
pack)" as the deeper follow-up behind the `EntityStore` contract. JSONB storage
works but leaves value on the table: no typed columns, sorts are JSONB **text**
ordering (`document ->> 'field'`), there's no place to hang foreign keys, and
the data-classification arc (ADR-0066/0067/0070) — which already emits
`crossengin.data_class` / `crossengin.encrypt=at_rest` column comments the
kernel-pg applier reads — never reaches the operate store because there are no
real columns to comment.

This increment delivers the typed sibling: a `ColumnMappedEntityStore` over
**real per-entity tables** whose columns are derived from the manifest entity's
fields, reusing the kernel's existing DDL machinery.

## Decision

Three new modules in `@crossengin/operate-runtime-pg`, behind the unchanged
`EntityStore` contract. The kernel's field-type and identifier helpers are
reused (no reinvention).

- **`column-plan.ts`** (pure) — `columnPlanForEntity(entity, { schema })` maps
  each manifest `Field` to a typed column via the kernel's
  `fieldTypeToPostgresType` + `columnNameForField` (reference fields →
  `<name>_id`, UUID), carrying the field's `classification` and an
  `encryptAtRest` flag (`requiresEncryptionAtRest`). `columnPlansForManifest`
  derives the plan for every entity; `columnIndex` is the field→mapping lookup.
- **`entity-ddl.ts`** (pure) — `emitEntityTableDdl(plan)` emits **idempotent**
  DDL: `CREATE TABLE IF NOT EXISTS` with the system columns (`tenant_id UUID`,
  **`id TEXT`**, `created_at`/`updated_at`) + each typed domain column +
  `(tenant_id, id)` PK, a tenant index, RLS enabled with the standard
  tenant-isolation policy (`DROP POLICY IF EXISTS` → `CREATE POLICY`, so re-runs
  are safe), and a `crossengin.data_class=…[; crossengin.encrypt=at_rest]`
  `COMMENT ON COLUMN` per classified column — the exact convention the kernel-pg
  encryption applier parses.
- **`column-store.ts`** — `ColumnMappedEntityStore implements EntityStore`:
  `ensureSchema()` applies the per-entity DDL; CRUD maps record field ↔ column
  on every op (only provided fields are written; columns map back to fields on
  read, nulls omitted); `listPage` **sorts on the native column type** (a real
  `ORDER BY "column"`, not JSONB text) and filters by safe text-cast equality
  (`"column"::text = $n`), with `LIMIT limit+1 OFFSET` keyset detection. Every op
  runs inside `withTenantContext` (RLS). A field absent from the entity's plan is
  dropped from filters/sorts (can't reach SQL).

`id` is kept **TEXT** (not the kernel's synthetic UUID PK) so a record is
indistinguishable across the in-memory, JSONB, and column-mapped stores — the
same `rec_…` / caller-supplied id flows through all three.

`apps/operate-server` gains `--store pg-columns`: `serve` builds the store from
the resolved manifest and calls `ensureSchema()` at boot, so the typed store is
a demonstrated drop-in for the JSONB one.

## Cross-cutting invariants enforced (by tests)

- **Typed columns from the manifest.** `text → TEXT`, `decimal(12,2) →
  NUMERIC(12, 2)`, `enum → TEXT`, `reference → UUID` on a `<name>_id` column —
  the kernel's `fieldTypeToPostgresType`, asserted on a synthetic entity.
- **Typed sort, safe filter.** `listPage` emits `ORDER BY "price" DESC, "id"
  ASC` (native numeric/temporal ordering) and `"status"::text = $2` (bound
  value); a field not in the plan is ignored — it never reaches the SQL.
- **Classification reaches storage.** A `phi` column gets `COMMENT … 'crossengin.
  data_class=phi; crossengin.encrypt=at_rest'`; a `commercial_sensitive` column
  gets the data-class comment without the encrypt directive — so the kernel-pg
  coverage/migration tooling can encrypt PHI columns in the operate tables.
- **Drop-in + RLS.** It satisfies the exact `EntityStore` interface (CRUD +
  `listPage`), every op is `withTenantContext`-wrapped, and `--store pg-columns`
  serves a pack from typed tables with no gateway/handler change.
- **Idempotent schema.** `ensureSchema` re-runs cleanly (`IF NOT EXISTS`, `DROP
  POLICY IF EXISTS` → `CREATE POLICY`).

## Alternatives considered

- **Reuse the kernel's `emitEntity` / `emitCreateTable` (manifest tier).**
  - **Decision.** No — it hardcodes a synthetic `id UUID` PK and emits neither a
    `tenant_id` column nor RLS (it targets a different deployment model). The
    store needs `(tenant_id, TEXT id)` + RLS + idempotent DDL, so the table
    shape is hand-emitted while still reusing `fieldTypeToPostgresType` /
    `columnNameForField` / `quoteIdent` / `qualifyTable`.
- **UUID `id` (matching the kernel) instead of TEXT.**
  - **Decision.** TEXT — cross-store record parity matters more than native UUID
    typing; the same id flows through in-memory / JSONB / column stores. A UUID
    PK is a per-pack option later if a pack wants it.
- **Transparent encrypt-on-write through the store.**
  - **Decision.** Deferred here; **delivered in ADR-0091 (P1.11).** The store now
    emits a `phi`/`regulated` column as `BYTEA` and wires
    `pgp_sym_encrypt`/`pgp_sym_decrypt` (key by SQL reference) into its
    read/write SQL, so PHI is encrypted at rest transparently.
- **Bind typed filter values (not `::text` cast).**
  - **Decision.** Text-cast equality is correct + injection-safe for the
    equality first cut (the column's native type drives the meaningful win —
    sorting). Typed/operator filters ride the same `ListFilter` shape later.
- **Foreign keys on reference columns.**
  - **Decision.** Deferred — cross-entity FKs within tenant data (and their
    apply ordering) are a separate concern; the column is typed `UUID` and named
    `<ref>_id`, leaving the FK as an additive migration.

## Consequences

- **59 packages + 2 apps, 123 meta-schema tables, 6,300 tests** (was 6,281;
  +19, 0 new packages/tables). The deeper ADR-0086 follow-up is delivered: the
  operate store now has a **typed, per-entity, classification-aware** option
  alongside the JSONB one, both behind one `EntityStore` contract.
- **`--store pg-columns` is real.** `operate-server --pack erp-retail --store
  pg-columns` provisions typed per-entity tables at boot and serves the pack
  from them, with typed `ORDER BY` on lists.
- **The classification arc closes into operate storage.** PHI/regulated columns
  in the operate tables now carry the at-rest comment, so the existing
  `crossengin-pg encrypt` coverage + migration tooling extends to served entity
  data — transparent store-level encryption is the remaining follow-up.
