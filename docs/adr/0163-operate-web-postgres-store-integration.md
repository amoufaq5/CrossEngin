# ADR-0163: operate-web Postgres entity store + gated integration test (Phase 3 P3.7)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0162 (operate-web kanban/calendar), ADR-0086 (PostgresEntityStore), ADR-0090 (ColumnMappedEntityStore), ADR-0087/0117 (operate-server store + integration test), ADR-0080 (Phase 3 P3 plan) |

> **Numbering.** ADRs 0081–0085 remain reserved for Phase 3 P4–P8 (per
> ADR-0077). This is a P3 follow-on increment (P3.7).

## Context

`apps/operate-web` (P3.1–P3.6) served redaction-aware view models, but only ever
over an `InMemoryEntityStore` — the data routes (`/ui/:entity`, `/ui/:entity/:id`,
`/ui/:entity/kanban`, `/ui/:entity/calendar`) read records that lived only in
process memory. `apps/operate-server` had long supported `--store memory|pg|
pg-columns` (ADR-0087) backed by `@crossengin/operate-runtime-pg`'s
`PostgresEntityStore` (JSONB) / `ColumnMappedEntityStore` (typed per-entity
tables + transparent PHI encryption), and a gated real-Postgres integration test
(ADR-0117) proving CRUD/tenant-isolation/redaction/pagination end-to-end. P3.7
brings operate-web to that parity: the UI view-model layer now reads the **same
persisted data** the serving API writes, and a gated test proves it against a
live database.

## Decision

- **`--store memory|pg|pg-columns` + `--schema`** on the operate-web CLI
  (`WebStoreKind`), mirroring operate-server exactly. `node.ts`'s new
  `resolveWebStore(options, manifest)` returns `{ store, conn }`: `memory` →
  `InMemoryEntityStore` (conn null); `pg` → `PostgresEntityStore` over
  `meta.operate_entity_records`; `pg-columns` → `ColumnMappedEntityStore` with
  `ensureSchema()` (provisions the typed tables + pgcrypto for PHI columns). The
  app gained deps on `@crossengin/kernel-pg` + `@crossengin/operate-runtime-pg`.
- **`serve()` threads the resolved store** into `buildOperateWebServer` (it
  previously let the server default to in-memory) and **closes the backing
  connection** in the returned `close()` handle (after the HTTP server closes;
  the in-memory case closes nothing). The background JWKS poller stop ordering is
  preserved.
- **A gated real-Postgres integration test** (`integration.test.ts`, gated on
  `CROSSENGIN_PG_TEST=1`, skipped offline) drives the GET `/ui/...` routes
  through `OperateWebServer` over a `PostgresEntityStore`. Since the web server is
  GET-only, records are seeded directly via `store.create(...)`, then read back
  through the routes. Five cases: a detail record read back from PG; **tenant
  isolation** (tenant B's table omits tenant A's rows); **redaction over real PG**
  (a cashier's `/ui/Product/:id` record + detail model omit the
  `commercial_sensitive` `unit_cost`, a manager's include it); **keyset
  pagination** (`?limit=2` → a 2-row page + `nextCursor`, the next page returns
  the remainder); and the **P3.6 kanban board over PG** (a manager's card model +
  data row carry `unit_cost`, a cashier's omit it from both).
- **CI** runs the operate-web gated suite alongside workflow-worker +
  operate-server in the `integration` job's gated step.

## Cross-cutting invariants enforced

- **The UI never carries a field the viewer can't read — over a real database.**
  Redaction is applied by `redactRecord` at the serving layer on rows fetched
  from PG, identically to the in-memory path; proven for the table, detail, and
  kanban routes.
- **Tenant isolation is the store's, not the test's.** Reads go through
  `withTenantContext` + `WHERE tenant_id = $1`; the test asserts a second tenant
  can't see the first's rows.
- **No new META_ tables.** Reuses `meta.operate_entity_records` (ADR-0086) and
  the column-mapped per-entity tables (ADR-0090); P3.7 is wiring + a test.

## Alternatives considered

- **Exercise mutations through the web server.** No — operate-web is read-only by
  design (the write path is the deferred P3 form-mutation follow-up); seeding via
  the store is the honest way to populate data for read routes.
- **Only test the JSONB store.** The gated suite uses `PostgresEntityStore`
  (JSONB); operate-server's `integration-columns*.test.ts` already cover the
  column store + encryption end-to-end, so operate-web doesn't re-prove the store
  internals — it proves the *UI routes* read persisted data correctly.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, 6,911 offline tests + 44 gated
  real-Postgres integration tests** (17 worker + 22 operate-server + **5
  operate-web**) **+ five CI gates** — the offline count is unchanged (the 5 new
  tests are gated). operate-web can now serve a manifest's UI off the same
  Postgres the API writes (`--store pg` / `pg-columns`), with the UI-routes-read-
  persisted-data path verified against a live database on every push/PR.
