# ADR-0086: operate-runtime-pg — the Postgres EntityStore (Phase 3 P1.6)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0078 (operate-runtime serving), ADR-0079 (gateway body parsing), ADR-0047 (kernel-pg), ADR-0002 (multi-tenancy / RLS), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P1 follow-on increment (P1.6), so it takes the next free
> number after those reservations.

## Context

P1 (ADR-0078) composed a resolved manifest into a live API over an injectable
`EntityStore`, shipping only the `InMemoryEntityStore` and listing the Postgres
binding as open question **Q3**. P1.5 (ADR-0079) closed the gateway gaps so the
full CRUD + lifecycle surface runs through the real pipeline — but still against
in-memory storage. To make the serving stack production-shaped, the entity data
must live in Postgres under the same **tenant row-level-security** discipline as
every other persisted record in the platform.

This increment delivers `@crossengin/operate-runtime-pg`: a Postgres
`EntityStore` backed by a single tenant-scoped JSONB document table, scoped per
request via the RLS session context — not merely a `WHERE tenant_id = $1`
clause.

## Decision

A new META table + a new package.

**`meta.operate_entity_records`** (kernel meta-schema, table #123): a JSONB
document store keyed by `(tenant_id, entity, record_id)`.

- `id UUID` PK (`uuid_generate_v7()`), `tenant_id UUID NOT NULL` (FK → tenants,
  CASCADE), `entity TEXT` (identifier-shaped check), `record_id TEXT`
  (1–200 chars), `document JSONB NOT NULL`, `created_at`/`updated_at TIMESTAMPTZ`.
- Unique `(tenant_id, entity, record_id)`; index `(tenant_id, entity)`.
- **RLS enabled** with the strict tenant-isolation policy
  (`tenant_id = current_setting('app.current_tenant_id', true)::UUID`) — the
  table holds tenant *data*, never platform rows, so `tenant_id` is `NOT NULL`
  and there is no `IS NULL OR …` platform escape hatch.

**`@crossengin/operate-runtime-pg`** (depends on `kernel-pg` + `operate-runtime`):

- **`records.ts`** — the persisted-row zod schema (`EntityRecordRowSchema`,
  accepting string or `Date` timestamps as node-postgres returns), `DocumentRow`
  (the `{ document }` read projection), `generateRecordId` (the same
  `rec_<base36>` shape the in-memory store mints), `resolveRecordId` (keep a
  usable own id, else mint), `mergeRecord` (pure existing ⊕ patch with the id
  pinned), `rowToRecord`.
- **`tenant-context.ts`** — `withTenantContext(conn, tenantId, fn)` runs `fn`
  inside a transaction after `SELECT set_config('app.current_tenant_id', $1,
  true)` (transaction-local; the tenant id rides as a **bound parameter**, never
  interpolated). A UUID-ish guard rejects a malformed tenant id *before* opening
  the transaction, so RLS scope can't be silently widened.
- **`entity-store.ts`** — `PostgresEntityStore implements EntityStore`: `list` /
  `get` / `create` / `update` (`SELECT … FOR UPDATE` then merge) / `remove`,
  each wrapped in `withTenantContext`, plus an admin `count`. The schema name is
  validated (`^[a-z_][a-z0-9_]*$`) since it can't be a bound parameter; the table
  is otherwise fixed.

## Cross-cutting invariants enforced (by tests)

- **RLS context, not just a WHERE clause.** Every operation sets
  `app.current_tenant_id` for the transaction before it touches data; the
  offline fake `PgConnection` enforces that a data query only sees rows for the
  tenant in context, so a record created in one tenant is invisible to another
  through `get` and `list`.
- **Parameterized everywhere.** The tenant id, entity, record id, and document
  are all bound (`$1…$4`, `$4::jsonb`); only the validated schema name is
  interpolated. A malformed tenant id or schema name throws rather than reaching
  SQL.
- **Drop-in behind the contract.** `PostgresEntityStore` satisfies the exact
  `EntityStore` interface P1 defined, so `buildOperateGateway(manifest, { store:
  new PostgresEntityStore(conn), … })` serves the retail pack from Postgres with
  no other change — the same contract-vs-impl split as every `*-runtime` /
  `*-pg` pair.
- **Id parity with the in-memory store.** Records created through either binding
  carry the same `rec_…` id shape, so downstream code can't tell them apart.

## Alternatives considered

- **Column-mapped per-entity tables (DDL emitted from the pack).**
  - **Decision.** Deferred. Emitting a real table per manifest entity (typed
    columns, FKs, per-field classification → encryption) via `kernel-pg` is the
    richer production target, but it couples storage to the manifest-compile step
    and the DDL applier. A single JSONB document table proves the RLS-scoped
    serving path now; the column-mapped store can swap in behind the same
    `EntityStore` contract later, table-by-table.
- **Rely on the `WHERE tenant_id = $1` clause alone (no RLS context).**
  - **Decision.** No — every other tenant-scoped table in the platform enforces
    RLS; the serving store must too, so a query bug can't cross tenants. Setting
    the session context is the platform's primary isolation control, the WHERE
    clause a secondary one.
- **`SET LOCAL app.current_tenant_id = '<uuid>'`.**
  - **Decision.** No — that interpolates the tenant id into SQL. `set_config(…,
    true)` takes it as a bound parameter, matching the "never inline a value
    that could be attacker-influenced" discipline used for encryption key refs.
- **A separate `operate-runtime-pg` migration runner.**
  - **Decision.** No — the table is a META table emitted by the kernel like every
    other; `kernel-pg`'s applier already creates it. No bespoke migration.

## Consequences

- **59 packages + 1 app, 123 meta-schema tables, 6,217 tests** (was 58 / 122 /
  6,192; +1 package, +1 table, +25 tests). The serving stack now persists to
  Postgres under tenant RLS — ADR-0078 **Q3 is resolved**.
- **Q4 (`apps/operate-server` binary) and Q5 (list pagination/filtering) remain**
  the open P1 follow-ups. The HTTP shell can now wrap `buildOperateGateway` over
  a `PostgresEntityStore` for a genuinely multi-tenant, persisted server.
- **The column-mapped store is unblocked.** Because storage sits behind
  `EntityStore`, the future per-entity DDL-mapped binding is an internal swap,
  not an API change — packs, handlers, redaction, and the gateway are all
  unaffected.
