# ADR-0218: `residency-runtime-pg` — durable tenant residency directory (Phase 3 P6.5)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-24 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0217 (operate-server region guard), ADR-0216 (residency-runtime), ADR-0086 (tenant RLS pattern), ADR-0077 (P3 plan — P6) |

## Context

ADR-0217 enforced residency at the serving edge, but the tenant→profile directory was a static
`--residency-file`. This adds the Postgres sibling so the directory is a durable, editable table — the
`-runtime` → `-runtime-pg` step for residency.

## Decision

- **New META table** `meta.tenant_residency_profiles` (#128): `tenant_id` (PK, tenant FK), `profile`
  (JSONB), `updated_at`, `updated_by`. Tenant-scoped **RLS** (same posture as `operate_tenant_settings`).
- **`@crossengin/residency-runtime-pg`** — `PostgresTenantResidencyDirectory implements
  TenantResidencyDirectory` (the ADR-0216 seam) over that table: `resolve(tenantId)` returns the profile
  (or null), `upsert(tenantId, profile, updatedBy?)` writes it (`INSERT … ON CONFLICT (tenant_id) DO
  UPDATE`, `profile` cast `::jsonb`). Every op runs under `withTenantContext(tenantId)` — the lookup is
  "give me *this* tenant's profile", so binding the RLS context to the looked-up tenant is exactly the
  intended scope (the profile is routing metadata, not tenant data). A row that comes back is
  re-validated through `ResidencyProfileSchema`, so drift/corruption is an error, not a bad routing
  decision.
- **operate-server wiring** — `--residency-store` (requires `--region` + a pg store, mutually exclusive
  with `--residency-file`) builds a `PostgresTenantResidencyDirectory` over the serving connection and
  hands it to the region guard. The guard is otherwise unchanged — it consumes the structural
  `TenantResidencyDirectory`, oblivious to file-vs-Postgres.

## Consequences

- Residency profiles are now durable and per-tenant editable in the database rather than a redeploy of a
  static file — an operator (or a future control-plane API) can register/change a tenant's home region
  live, and every region instance reads the same source of truth.
- The region guard is source-agnostic: `--residency-file` (static) and `--residency-store` (Postgres)
  both satisfy the same seam, so the P6.6 edge routing works identically over either.
- RLS scoping is deliberate and safe: the guard binds the context to the very tenant it's resolving, so
  it reads only that tenant's routing profile and nothing else — even pre-auth, there's no cross-tenant
  read.
- 7,271 tests pass (+6 residency-runtime-pg: upsert/resolve round-trip, upsert-replace, null-when-absent,
  tenant isolation, schema+tenant-id guards, default+custom schema targeting; +2 operate-server CLI:
  `--residency-store` parse + its `--region`/pg-store/mutual-exclusion rejections; meta-schema table
  count 127 → 128). Full build + typecheck green.
- Follow-ups: a control-plane admin route to edit residency profiles; deriving the tenant's region into
  the marketplace `tenantContext` (P5.6 follow-up) now that it's queryable.
