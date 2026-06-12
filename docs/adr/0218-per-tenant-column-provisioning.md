# ADR-0218: per-tenant column-store provisioning on install (Phase 3 P5.12)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-12 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0211 (per-tenant dispatch), ADR-0090 (column-mapped entity store) |

## Context

Under `--store pg-columns --marketplace`, the per-tenant composed gateway serves an
installed pack's entities (P5.5–P5.8), but the pack's **typed per-entity tables never
get created**: boot's `ensureSchema()` provisions only the base manifest's entities. So
the first per-tenant CRUD over an installed pack's entity fails with `relation does not
exist` — the gateway routes to a table that was never provisioned.

The column store's tables are **not** per-tenant: `ColumnMappedEntityStore` maps each
entity to one shared table with a `tenant_id` column + RLS (ADR-0090). So "provision on
install" doesn't mean a per-tenant table — it means **idempotently ensure the installed
pack's entity tables exist**, triggered when a pack is first installed by any tenant. The
JSONB document store (`--store pg`) and the in-memory store need no such step: they store
any entity as a document, so a newly-served entity needs no DDL.

## Decision

Add an awaited `onPackInstalled(packId, version)` hook to the marketplace install handler
and, under `--store pg-columns`, wire it to an idempotent `ensureSchema` over the composed
(base + installed pack) manifest.

- **`apps/operate-server` `marketplace-routes.ts`** — `MarketplaceRouteDeps` gains an
  optional `onPackInstalled?(packId, version): Promise<void> | void`. The install handler
  `await`s it **after** the `store.record(installed)` write and the existing
  `onInstallChange(tenantId)` eviction, **before** the 201. Awaiting it means the pack's
  tables exist before the response, so the caller's next CRUD can't race ahead of the DDL.
  It is **not** called on the 409 (already-installed) / 422 (bad input) rejection paths.
- **`apps/operate-server` `node.ts`** — `serve()` under `--marketplace` wires
  `onPackInstalled` **only** when `options.store === "pg-columns"` and the store connection
  is available; otherwise no callback is passed. The implementation resolves the pack's
  manifest via the same `buildBuiltinPackResolver()` the dispatcher uses (a null result —
  an unknown pack — is a no-op) and runs
  `new ColumnMappedEntityStore(storeConn, composeTenantManifest(base, [packManifest]),
  {schema}).ensureSchema()`. The DDL is global + idempotent (`CREATE TABLE IF NOT EXISTS`;
  FKs `DROP IF EXISTS` → `ADD`), so re-running it over the base entities is a harmless
  no-op, and the composed manifest gives `ensureSchema` the full topological graph so a
  pack's cross-pack FK (e.g. education `Course.account_id` → core `Account`) resolves
  against the already-provisioned base tables.

## Consequences

- **68 packages + 4 apps, 126 meta-schema tables, ~7,341 offline tests + 57 gated
  real-Postgres integration tests.** New offline tests in `marketplace-routes.test.ts`:
  `onPackInstalled` fires with `(packId, version)` after a successful install, is awaited
  before the 201, and does **not** fire on a 409 or 422. A new gated
  `integration-column-provisioning.test.ts` proves the end-to-end gap: a column store
  provisioned for the base `erp-retail` manifest has no `Course` table; running the
  provisioning step over `composeTenantManifest(retail, [education])` creates the education
  pack's tables; a `POST /v1/courses` (201) + `GET /v1/courses` (200, the course present)
  then succeed through a composed gateway (ran green against live Postgres 16). No new
  META_ tables — this provisions existing column tables, adds none.
- Provisioning is global (the first install of a pack creates its shared tables for every
  tenant), idempotent, and DDL-only; the row-level RLS / `WHERE tenant_id` confinement is
  unchanged. The JSONB and in-memory stores keep the prior behavior (no callback wired).
