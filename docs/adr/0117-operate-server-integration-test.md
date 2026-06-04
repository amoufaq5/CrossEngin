# ADR-0117: operate-server real-Postgres integration test (Phase 3 P1.23)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-04 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0087 (apps/operate-server), ADR-0086 (operate-runtime-pg / PostgresEntityStore), ADR-0109 (worker real-PG integration test), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P1 (serving-stack) hardening increment (P1.23), the
> serving-side counterpart of the P2.6 worker integration test.

## Context

The P1 serving stack (`operate-runtime` + `operate-runtime-pg` + `apps/operate-
server`) was verified offline against the `InMemoryEntityStore` — the HTTP →
gateway → store path, redaction, RBAC, and keyset pagination all proven, but
never against a real `PostgresEntityStore` over real Postgres. The thing only a
real database shows is **tenant isolation**: that the store's `WHERE tenant_id =
$1` + `withTenantContext` actually confine one tenant's reads from another's in
the shared `meta.operate_entity_records` table. P1.23 adds that integration
test, mirroring P2.6 for the workers.

## Decision

- **`apps/operate-server/src/integration.test.ts`** — a real-PG suite gated on
  `CROSSENGIN_PG_TEST=1` (skipped offline / in CI). It seeds tenant rows in
  `meta.tenants`, builds the retail-pack server over a `PostgresEntityStore`, and
  dispatches genuine `RawHttpRequest`s through `OperateHttpServer.dispatch`,
  asserting:
  - **CRUD persists.** `POST /v1/products` (201) then `GET /v1/products/{id}`
    (200) round-trips the document through Postgres.
  - **Tenant isolation.** A product created by tenant A is **not** visible in
    tenant B's `GET /v1/products` — the store confines reads by tenant.
  - **Per-caller redaction.** A cashier's list drops `unit_cost`
    (commercial_sensitive); a manager's keeps it — over the real store.
  - **RBAC.** A cashier `POST` is 403.
  - **Keyset pagination.** `?limit=2` returns a page + `nextCursor`; the cursor
    fetches the remainder — against real SQL keyset seek.

All other operate-server logic stays offline-tested over the in-memory store; the
integration test reuses the exact `buildOperateHttpServer` + `parseApiKeySpec` +
`loadBuiltinPack` seam, swapping only the store.

## Cross-cutting invariants enforced (real PG, gated)

- **The serving path works against Postgres.** HTTP → 17-stage gateway →
  `PostgresEntityStore` → `meta.operate_entity_records` round-trips a create +
  read.
- **Tenant isolation holds.** Tenant B never sees tenant A's records (the store's
  `WHERE tenant_id = $1` + `withTenantContext`).
- **Classification redaction is per-caller** over the real store (cashier loses
  `unit_cost`, manager keeps it).
- **RBAC + keyset pagination** behave identically to the in-memory path.

## Alternatives considered

- **Test RLS enforcement with a non-bypassing role.**
  - **Decision.** Deferred — the test DB connects as a superuser/owner (RLS
    bypassed), so this suite proves isolation via the store's `WHERE tenant_id =
    $1` clause (the primary guarantee). A dedicated `NOBYPASSRLS` role to prove
    the RLS *policy* itself is a separate, deeper test-harness setup; the store's
    explicit tenant filter is defense-in-depth that the gated test already
    covers.
- **Test the `ColumnMappedEntityStore` (typed tables) too.**
  - **Decision.** Deferred — the JSONB `PostgresEntityStore` is the default and
    exercises the shared gateway path; a column-store integration pass (with
    `ensureSchema` + FK/encryption assertions) is a natural follow-up.
- **Boot the real Node HTTP listener (loopback) instead of `dispatch`.**
  - **Decision.** No — `OperateHttpServer.dispatch` is the framework-neutral core
    the loopback + edge adapters both wrap (already loopback-tested offline);
    driving `dispatch` directly keeps the integration test focused on the
    store/SQL, not the socket.

## Consequences

- **60 packages + 3 apps, 124 meta-schema tables, 6,514 offline tests + 14 gated
  real-Postgres integration tests** (9 worker + 5 serving; +5 this increment, 0
  new tables/columns/packages/production code). The P1 serving stack is now
  **proven end-to-end against real Postgres** — CRUD, tenant isolation,
  redaction, RBAC, and keyset pagination — not just mocked, matching the P2
  worker coverage.
- **Both apps now have a gated real-PG integration suite** — a CI job that
  spins up Postgres + applies the meta-schema can run `CROSSENGIN_PG_TEST=1`
  across the workspace to exercise the whole persistence surface.
- **A non-bypassing-role RLS test + a column-store integration pass** remain the
  deeper serving-stack follow-ups.
