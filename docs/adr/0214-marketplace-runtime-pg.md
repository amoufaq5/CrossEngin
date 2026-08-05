# ADR-0214: `marketplace-runtime-pg` — durable pack install lifecycle (Phase 3 P5.5)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0213 (marketplace-runtime), ADR-0086 (operate-runtime-pg tenant RLS pattern), ADR-0077 (P3 plan — P5) |

## Context

ADR-0213 shipped `marketplace-runtime` — the in-process install engine — but it held no state: the caller
owned the `PackInstallationSet`, and nothing persisted it. This adds the Postgres sibling (the
established `-runtime` → `-runtime-pg` step), persisting installations to the existing
`meta.pack_installations` table under tenant RLS, so an install survives a restart and the
already-installed guard sees real cross-request state.

## Decision

`@crossengin/marketplace-runtime-pg` — no new META tables (the M-era `pack_installations` catalog table
already exists). 4 modules:

- **records** — `rowToInstallation` projects a `pack_installations` row back into a `PackInstallation`,
  validating through `PackInstallationSchema` (a drifted row is rejected, not trusted) and coercing
  TIMESTAMPTZ (driver `Date`s) to ISO strings; `installationParams` is the column-ordered bound-param
  list, with `config`/`permission_grants` JSON-serialized.
- **tenant-context** — `withTenantContext` runs each op inside a transaction after
  `SELECT set_config('app.current_tenant_id', $1, true)` (tenant id bound, never interpolated; a
  malformed id fails fast), so the **RLS policy** — not just a `WHERE tenant_id` clause — confines every
  read/write. Same pattern as `operate-runtime-pg`.
- **installation-store** — `PostgresInstallationStore`: `upsert` (`INSERT … ON CONFLICT (id) DO UPDATE`
  over the mutable columns, `config`/`permission_grants` cast `::jsonb`), `get`, `listForTenant` (the
  engine's `existing` set), and `activeForPack` (non-uninstalled/failed). The schema name is the only
  interpolated identifier (validated); everything else is bound.
- **persistent-engine** — `PersistentMarketplaceInstallEngine` wraps a `MarketplaceInstallEngine`:
  `install(request)` loads the tenant's installs from the store as the `existing` set, admits, and
  upserts the outcome (a **rejected** decision writes nothing); `grant` / `complete` / `fail` /
  `beginUninstall` / `completeUninstall` / `beginUpdate` / `completeUpdate` apply the in-memory
  transition then upsert, so the DB always mirrors the latest record. It defaults its id generator to
  `UuidInstallationIdGenerator` (bare UUIDs) since `pack_installations.id` is a `UUID` column — not the
  in-memory `inst_…` form.

## Consequences

- The install engine is now durable and multi-node: two requests that don't share a process still see
  each other's installs (the already-installed guard reads from Postgres), and an install survives a
  restart. The persistent engine is a drop-in over the pure one — same lifecycle API, plus persistence.
- Records are RLS-confined per tenant exactly like the other tenant-scoped stores, and every row that
  comes back is re-validated through the schema, so drift/corruption surfaces as an error rather than a
  bad in-memory record.
- The pg engine mints UUID ids to match the table PK; the pure engine keeps its `inst_…` ids for
  in-memory use. The record mapper bridges the two id shapes (both are `z.string()` on the record).
- 7,226 tests pass (+13: upsert/get round-trip, id-conflict update, JSONB config/grants preservation,
  `listForTenant`/`activeForPack`, tenant isolation, schema + tenant-id guards; persistent install →
  reject-second-install-from-persisted-state → full grant/install/uninstall lifecycle →
  rejected-writes-nothing). Full build + typecheck green.
- Follow-up: an `operate-server` admin route (`POST /v1/admin/packs/install`) driving the persistent
  engine, so packs install per-tenant over HTTP — the last step to make P5 serveable end-to-end.
