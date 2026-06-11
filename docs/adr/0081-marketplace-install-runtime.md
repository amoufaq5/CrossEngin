# ADR-0081: marketplace install runtime — marketplace-pg (Phase 3 P5)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0080 (Phase 3 P3 plan, P5 reserved 0081), the `marketplace` contract package |

## Context

The `marketplace` package defines the per-tenant pack-installation **contract**: a
`PackInstallation` record, the 8-state install lifecycle (`requested` →
`permission_pending` → `installing` → `installed` → `updating`/`uninstalling` →
`uninstalled`/`failed`), `canTransitionInstallation`, update policies, permission
grants. Phase 3 P5 makes it a runtime — a tenant can actually request, install,
update, and uninstall a pack, with the lifecycle persisted.

## Decision

A new `@crossengin/marketplace-pg` package (the **68th**) — a pure install engine +
a Postgres store over the **pre-existing** tenant-scoped `meta.pack_installations`
table (no new META table, like `sdk_client_releases`).

- **`engine.ts`** — the pure install-lifecycle engine. `newInstallationRequest(req)`
  mints a fresh `requested` (or `permission_pending`) `PackInstallation`;
  `transitionInstallation(inst, to, patch)` applies a **guarded** status transition
  (`canTransitionInstallation` throws `IllegalInstallationTransitionError` on an
  illegal `from → to`) and re-validates through `PackInstallationSchema` (so the
  per-status required-field invariants — installed ⇒ installedVersion/At/By, failed
  ⇒ failureReason, uninstalled ⇒ uninstalledAt/By — always hold). Named helpers
  (`beginInstall` / `grantAndInstall` / `completeInstall` / `beginUpdate` /
  `completeUpdate` / `failInstallation` / `requestUninstall` / `completeUninstall`)
  drive the common paths. No DB.
- **`installation-store.ts`** — `PostgresPackInstallationStore` over
  `meta.pack_installations`. Every op runs inside a tenant context (`SELECT
  set_config('app.current_tenant_id', $1, true)` in a transaction), so the **RLS
  policy** — not just `WHERE tenant_id` — confines reads/writes to the tenant (the
  tenant id is a bound parameter, UUID-guarded, never interpolated). `record`
  upserts the engine's output keyed on `id` (`DO UPDATE` refreshes the mutable
  lifecycle columns); `get` / `listForTenant({status?, limit?})` / `activeForPack`
  (the single non-terminal install of a pack) reconstruct through the contract
  schema. `requested_by`/`installed_by`/`uninstalled_by` are `meta.users` UUID FKs.

## Consequences

- **68 packages + 4 apps, 126 meta-schema tables, ~7,282 offline tests + 54 gated
  real-Postgres integration tests + six CI gates.** New offline tests (fake
  `PgConnection` whose `transaction` runs against a recording tx): `engine.test.ts`
  (the happy path + uninstall + fail + the illegal-transition + schema guards) and
  `installation-store.test.ts` (tenant-context set_config, upsert SQL/params,
  schema-name + tenant-id guards, get/list/activeForPack, row coercion). Packs add
  no META_ tables.
- A tenant's pack installs are now a durable, RLS-isolated, state-machine-validated
  ledger. The deeper follow-ups: a `marketplace install` CLI/HTTP surface that drives
  the engine + resolves the pack manifest (via the builtin-pack registry) into the
  tenant's served surface, an install read+verify CLI (mirroring incidents/slo/
  sdk-releases), and a gated PG integration test.
