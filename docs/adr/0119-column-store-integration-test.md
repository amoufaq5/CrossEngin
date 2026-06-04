# ADR-0119: ColumnMappedEntityStore real-Postgres integration test (Phase 3 P1.24)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-04 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0090 (column-mapped store), ADR-0091 (at-rest encryption), ADR-0117 (operate-server JSONB integration test), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P1 (serving-stack) hardening increment (P1.24).

## Context

P1.23 (ADR-0117) proved the JSONB `PostgresEntityStore` against real Postgres,
but the typed `ColumnMappedEntityStore` (ADR-0090/91/92) — real per-entity
tables, column-native typed sort/filter, FKs, and **transparent at-rest
encryption** of `phi`/`regulated` columns via pgcrypto — was only offline-tested
(mocked connection). Its distinguishing features are exactly the ones that need
a real database: `ensureSchema` provisioning, a native `NUMERIC` sort, and
pgcrypto encrypt-on-write / decrypt-on-read. P1.24 adds that integration pass.

## Decision

- **`apps/operate-server/src/integration-columns.test.ts`** — a real-PG suite
  gated on `CROSSENGIN_PG_TEST=1` (skipped offline). It drives the
  `ColumnMappedEntityStore` directly (focused on the column store, not the
  gateway P1.23 already covers), with a **random tenant UUID per test** for
  isolation across re-runs:
  - **Typed tables + CRUD + native filter/sort (retail pack).** `ensureSchema`
    provisions `public.product` with a real `NUMERIC` `unit_price` (introspected
    via `information_schema`); create/get round-trips the typed record; a
    `status = 'active'` filter and a **keyset sort on the native NUMERIC column**
    paginate correctly.
  - **At-rest encryption (healthcare pack).** With an `encryptionKeyRef`, a
    `Patient` (`mrn` → phi) is created via `pgp_sym_encrypt`; the authorized
    `get` decrypts `mrn` back to plaintext, while the **raw column is `BYTEA`
    ciphertext** (`pg_typeof = bytea`, bytes ≠ the plaintext).

The test reuses `loadBuiltinPack` to resolve the retail + healthcare manifests;
NUMERIC values are asserted via `Number(...)` (node-postgres returns `numeric`
as a string).

## Cross-cutting invariants enforced (real PG, gated)

- **`ensureSchema` provisions typed tables.** `product.unit_price` is `NUMERIC`,
  not a JSONB text projection.
- **Column-native query.** Equality filter on a text column and keyset
  pagination on a native NUMERIC column return the right rows in the right order.
- **Encryption round-trips.** A phi column is written encrypted (`pgp_sym_encrypt`
  → `BYTEA`) and read decrypted (`pgp_sym_decrypt`) for the authorized caller;
  the stored bytes are ciphertext, never the plaintext.

## Alternatives considered

- **Build a minimal inline manifest instead of the packs.**
  - **Decision.** No — the packs (retail / healthcare) are the real schemas with
    real classifications (`Product.unit_cost` commercial_sensitive, `Patient.mrn`
    phi); reusing them via `loadBuiltinPack` exercises the actual classification →
    encryption path, not a synthetic one.
- **Set `app.column_encryption_key` via `ALTER DATABASE` for the default keyRef.**
  - **Decision.** No — passing `encryptionKeyRef: "'k_test_secret'"` (a literal
    SQL reference) keeps the key in the test's control with no session/DB-level
    setup; production still uses `current_setting('app.column_encryption_key')`.
- **Test through the gateway (HTTP) like P1.23.**
  - **Decision.** No — P1.23 already covers the gateway path (over the JSONB
    store); driving the column store directly keeps the assertions on the
    column-specific SQL (typed columns, BYTEA, keyset on NUMERIC) without RBAC /
    route noise.
- **Test a non-bypassing-role RLS policy + the m2m link API.**
  - **Decision.** Deferred — the same follow-ups ADR-0117 named; this increment
    targets the typed-table + encryption gap.

## Consequences

- **60 packages + 3 apps, 124 meta-schema tables, 6,520 offline tests + 17 gated
  real-Postgres integration tests** (10 worker + 7 serving; +2 this increment, 0
  new tables/columns/packages/production code). The typed column store is now
  **proven end-to-end against real Postgres** — typed DDL, native query, and
  transparent pgcrypto encryption — completing the serving-stack persistence
  coverage alongside the JSONB store (P1.23).
- **Both `EntityStore` bindings (JSONB + column-mapped) have a real-PG suite** —
  the full serving persistence surface is exercised under `CROSSENGIN_PG_TEST=1`.
- **A non-bypassing-role RLS test, the m2m link API, and FK `ON DELETE`
  semantics** over real PG remain the deeper column-store follow-ups.
