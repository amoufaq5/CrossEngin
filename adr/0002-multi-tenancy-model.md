# ADR-0002: Multi-Tenancy Model

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0003, ADR-0008, ADR-0009, ADR-0010 |

## Context

CrossEngin's defining promise is that one platform serves many organizations, each with isolated data, custom schemas, custom workflows, and (often) regulatory boundaries that forbid mixing. The multi-tenancy model is the lowest-level expression of that promise. Get it wrong and:

- **Data leaks** — cross-tenant queries expose one tenant's records to another. The single most fundamental trust failure possible.
- **Customization breaks** — tenants cannot diverge their schemas without colliding.
- **Migration breaks** — schema changes for one tenant ripple into others.
- **Compliance breaks** — auditors cannot certify "tenant data is isolated."
- **Operations break** — backups, restores, deletions, exports all become harder.
- **Performance breaks** — one large tenant's load impacts all others.

CrossEngin's tenant landscape is heterogeneous:

- **Many small tenants** (a 5-person community pharmacy, a 20-person clinic, a 50-person construction firm) — thousands at scale. Want fast onboarding, low operational overhead, multi-tenant cost economics.
- **A few large tenants** (a 1,000-bed hospital chain, a 500-clinic ministry of health program, a national vaccination registry) — dozens at full scale. Want strong isolation, sometimes dedicated resources, sometimes their own region.
- **Regulated tenants** (pharma manufacturers under GxP / 21 CFR Part 11, healthcare programs under HIPAA, government tenants under national data-protection laws) — often want certified isolation, sometimes dedicated databases, sometimes on-prem or BYOC.
- **Tenants on customer cloud (BYOC) or on-prem** — single-tenant deployments inside customer infrastructure. Different operational model from SaaS but same kernel.

The model must serve all four with consistent abstractions.

Three technical realities also constrain:

1. **Postgres is the primary data store.** CrossEngin commits to Postgres for the kernel. Multi-tenancy decisions are Postgres-specific.
2. **Manifests dictate schemas.** A pharmacy tenant and a polyclinic tenant have different entities, different field sets, different relations. The kernel must let each tenant's schema evolve independently.
3. **The AI Architect changes schemas at runtime.** A pharmacist saying "track narcotic returns" results in a new table or new columns in their tenant's schema, applied within minutes. Multi-tenancy must accommodate frequent, per-tenant DDL.

## Decision

CrossEngin uses a **hybrid multi-tenancy model**:

| Tenant tier | Isolation level | Postgres mechanism |
|---|---|---|
| **Small / standard SaaS** | Logical | One schema per tenant in a shared Postgres cluster |
| **Large / enterprise SaaS** | Physical | One Postgres database per tenant in a shared cluster (or dedicated cluster) |
| **Regulated / on-prem / BYOC** | Network + physical | One Postgres cluster per tenant, isolated network |
| **Shared kernel data** | Row-level | Single meta-schema with Row-Level Security (RLS) policies |

### Schema-per-tenant (default for SaaS)

Each tenant gets a dedicated Postgres schema named `t_<short_uuid>` (e.g., `t_8f2a9c1b`). All entity tables defined by the tenant's manifest live in this schema. The schema is owned by a per-tenant Postgres role with full DML privileges on its own schema and no access to others.

A central **meta-schema** named `meta` holds shared kernel data:

- `meta.tenants` — registry of all tenants (id, region, plan, status, schema name)
- `meta.users` — global user registry (a user can belong to multiple tenants)
- `meta.user_tenant_membership` — many-to-many between users and tenants
- `meta.audit_log` — global append-only audit log (also mirrored per-tenant for fast tenant-scoped queries)
- `meta.billing_*` — subscription, usage metering, invoices
- `meta.manifests` — manifest history per tenant
- `meta.ai_runs` — AI Architect interaction history

The meta-schema is protected by **Row-Level Security (RLS)** policies that limit each request to rows where `tenant_id` matches the session-bound tenant context. RLS is defense-in-depth: the application also enforces tenant scoping, but RLS catches application bugs and SQL-injection edge cases.

### Database-per-tenant (large / enterprise / regulated)

A tenant tier flag (`enterprise`, `regulated`) provisions a dedicated Postgres database within the SaaS cluster instead of a schema. The database has its own connection string. The tenant's `t_<short_uuid>` schema lives inside that database. The meta-schema for kernel data is still centralized; the database-per-tenant choice is about the tenant's own data.

This tier gets:

- Independent backups (point-in-time recovery on the dedicated DB).
- Independent scaling (read replicas, larger instance).
- Independent maintenance windows.
- Data residency options (the database can be in a specific region's cluster).

The same connection-routing layer handles both schema-per-tenant and database-per-tenant cases transparently.

### Cluster-per-tenant (on-prem and BYOC)

A tenant deployed on-prem or in BYOC mode runs its own Postgres cluster (single-tenant). The schema layout inside that cluster mirrors the SaaS layout: a `meta` schema with kernel data for that tenant only, and a `t_<short_uuid>` schema with manifest-defined entities.

This tier is operationally identical to a SaaS tenant from the application's perspective — the only difference is the connection string and the absence of other tenants on the same cluster.

### Tenant routing and context

Every request to the kernel API includes (or is associated with) a **tenant context**, set as follows:

1. Subdomain or path prefix in URL (e.g., `acme-pharma.crossengin.io` or `/t/acme-pharma/...`).
2. Session JWT contains `tenant_id` claim, verified by middleware.
3. Middleware looks up `meta.tenants` to get the tenant's database connection string and schema name.
4. Middleware opens (or reuses from pool) a Postgres connection with `SET ROLE tenant_<id>` and `SET search_path = t_<id>, public`.
5. Middleware also sets `app.current_tenant_id = '<id>'` as a Postgres session variable for RLS policies on the meta-schema.
6. The request is processed; all queries use the tenant's schema by default.
7. On request completion, the connection is reset and returned to the pool.

The application layer adds redundant `WHERE tenant_id = ...` clauses on meta-schema queries; RLS enforces them at the database level.

### Manifest-driven DDL per tenant

When a tenant's manifest changes (via the AI Architect or direct edit):

1. The manifest is validated against the kernel's meta-schema spec (ADR-0003).
2. The kernel computes the DDL diff between the tenant's current schema state and the target manifest.
3. The diff is applied to `t_<short_uuid>` within a transaction, with full rollback on any failure.
4. Generated artifacts (Prisma client, Zod validators, OpenAPI spec, UI form schemas) are regenerated for that tenant.
5. The manifest version is recorded in `meta.manifests` for audit and rollback.

Cross-tenant manifest changes (e.g., a new field on the global `meta.tenants` table) are applied via kernel migrations — separate from tenant manifest DDL.

### Isolation guarantees

- **Cross-tenant query is impossible by default.** A tenant connection sees only its own schema; the meta-schema is RLS-filtered to its own rows.
- **No `tenant_id` column on tenant-owned tables.** Tables in `t_<short_uuid>` don't carry a tenant_id because they don't need to — the schema IS the tenant boundary.
- **No shared sequences across tenants.** Each tenant's tables have their own sequences.
- **Foreign keys never cross schemas.** A reference from a tenant table to the meta-schema is by string ID, not by FK constraint.
- **Backups are per-tenant.** `pg_dump --schema=t_<id>` produces a complete tenant export.
- **Tenant deletion is `DROP SCHEMA t_<id> CASCADE` + meta-schema cleanup.** Atomic, complete, fast.

## Alternatives considered

### Option A — Shared schema with `tenant_id` column on every table (the "discriminator" approach)

All tenants share one big schema. Every table has a `tenant_id` column. RLS filters queries by the session's tenant.

- **Pros:** Simplest to implement. One schema to migrate. Many SaaS products use this. Lower overhead per tenant.
- **Cons:** A bug in the application that forgets to filter by `tenant_id` leaks across tenants. RLS catches it but requires correct policy on every table. Per-tenant schema customization is awkward — adding a tenant-specific field means either a JSONB column or a `tenant_id`-scoped column-presence convention. Hard to dump/restore a single tenant. Migrations affect all tenants simultaneously.
- **Why not:** The risk of cross-tenant leaks via application bugs is unacceptable for a platform serving regulated industries. Schema-per-tenant makes leaks structurally impossible, not just policy-prevented.

### Option B — Database-per-tenant always

Every tenant gets a dedicated Postgres database from day one.

- **Pros:** Maximum isolation. Independent everything. Easy compliance story.
- **Cons:** Operational overhead scales linearly. 10,000 small tenants = 10,000 databases. Postgres can handle it, but at significant ops cost. Onboarding is slower. Schema migrations are 10,000 separate operations.
- **Why not:** Too heavy for the small-tenant majority. Reserved for the enterprise tier, where the overhead is justified.

### Option C — One database per tenant tier (small, medium, large)

Tenants are bucketed by size; each bucket has its own Postgres database; each tenant has a schema within its bucket's database.

- **Pros:** Operational compromise.
- **Cons:** Bucket transitions (a small tenant grows into medium) require data migration. Adds a moving part. No real benefit over schema-per-tenant for small/medium.
- **Why not:** Schema-per-tenant in a shared database is already operationally clean. Bucket migration is unnecessary complexity.

### Option D — Distributed Postgres (Citus, Yugabyte)

Distributed Postgres with shard keys.

- **Pros:** Native horizontal scaling.
- **Cons:** Non-trivial operational profiles. Less mature than vanilla Postgres for our scale. Optimized for analytics throughput, not OLTP with thousands of small tenants. AWS RDS / Neon / Supabase don't natively support them at Year 1 maturity.
- **Why not:** Overengineered for our scale. Revisit at >10K tenants or >100M rows per tenant.

### Option E — Neon database branches per tenant

Neon's database branching feature lets a branch act as a copy-on-write fork. Each tenant could get a branch.

- **Pros:** Native Neon feature; cheap; isolated.
- **Cons:** Neon branches are designed for development workflows, not production tenant isolation. Limit on branch count. Not portable to other Postgres hosts.
- **Why not:** Vendor lock-in. Schema-per-tenant works on any Postgres host.

## Consequences

### Positive

- **Strong isolation by default.** Cross-tenant query is structurally impossible without an explicit cross-schema join, which the kernel never generates.
- **Per-tenant schema customization.** Each tenant's manifest produces tables specific to it, with no impact on others.
- **Easy compliance story.** "Tenant data lives in its own dedicated Postgres schema with role-based access control. Cross-tenant access is structurally prevented."
- **Easy backup / restore / delete.** Per-tenant operations are single-schema operations.
- **Easy SaaS → BYOC migration.** A schema in SaaS becomes a cluster in BYOC with the same internal structure.
- **Easy data residency.** Large / enterprise / regulated tenants pin to regional databases.

### Negative

- **Schema count grows linearly with tenants.** Postgres handles 100K schemas, but `pg_dump` and various tools slow with high schema counts. Mitigation: separate "active tenant" pool from archived tenants; archive idle tenants to cold storage.
- **Migrations per tenant.** Kernel migrations that affect tenant tables must be applied per-tenant in a coordinated way. Mitigation: kernel migrations apply manifest changes, which already run per-tenant.
- **Connection pool complexity.** Each connection must be configured for the right tenant role and search_path. Mitigation: PgBouncer or Supavisor with per-tenant connection handling.
- **Cross-tenant reporting requires extra work.** Internal admin views query the meta-schema; they cannot natively aggregate tenant data. Mitigation: per-tenant analytics events stream to ClickHouse (ADR-0013), where cross-tenant aggregation is allowed for internal ops.

### Neutral

- **Onboarding cost.** Creating a new tenant runs `CREATE SCHEMA`, `CREATE ROLE`, manifest DDL, and seed inserts. Takes seconds.
- **Disk usage.** Per-tenant tables have small fixed overhead. Negligible at scale.

### Reversibility

**High cost to reverse.** Switching from schema-per-tenant to shared-schema-with-discriminator after tenant data exists requires data migration across thousands of schemas. Switching to database-per-tenant after schema-per-tenant is established is easier (move tenants out individually).

The hybrid model itself is forward-compatible: a SaaS tenant can be migrated from schema-in-shared-DB to dedicated-DB without data loss; from dedicated-DB to on-prem cluster the same way. Each tier is a superset of the previous.

## Implementation notes

- **Per-tenant Postgres role.** Each tenant has a role `tenant_<id>` with `USAGE` on its schema and `ALL` on its tables. The application connects with this role.
- **Search path.** `SET search_path = t_<id>, public` is set on every connection acquire from pool.
- **RLS on meta-schema.** All meta-schema tables have policies like `USING (tenant_id = current_setting('app.current_tenant_id')::uuid)`.
- **Migration runner.** A `kernel-migrate` tool applies manifest DDL per tenant, with concurrency control and rollback. Lives at `tools/kernel-migrate/`.
- **Tenant provisioning** uses a single transaction: create role, create schema, grant privileges, apply manifest DDL, insert into `meta.tenants`. If any step fails, the entire transaction rolls back.
- **Connection pool sizing.** Per-tenant connections are short-lived (acquired per request). The pool is sized for concurrent request count, not tenant count.
- **Monitoring.** Per-tenant query latency, connection count, error rate are tagged for per-tenant alerting (ADR-0017).
- **Documentation.** A `KERNEL_INVARIANTS.md` in the monorepo lists "things the kernel must never do." Top of the list: "never run a query without a tenant context." Every PR is reviewed against this list.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Choice of Postgres host for Year 1 SaaS: Neon vs. Supabase vs. AWS RDS vs. CloudSQL. | amoufaq5 | Phase 1 |
| Per-tenant connection pooling: PgBouncer (session vs. transaction mode), Supavisor, or custom? | amoufaq5 | Phase 1 |
| Threshold for promoting a tenant from schema-in-shared-DB to dedicated-DB. Probably "first regulated industry contract" or "tenant exceeds X GB / Y RPS." | amoufaq5 + commercial hire | Phase 5 |
| Cross-tenant reporting strategy for internal ops. ClickHouse mirror only, or also a read-replica-with-RLS-disabled for internal queries? | amoufaq5 | Phase 4 |
| Tenant deletion / GDPR right-to-erasure: soft delete with schema retention period, hard delete immediately, or both with policy? | amoufaq5 | Phase 5 (before launch) |
| Tenant cloning (e.g., create a sandbox tenant from a production tenant) for testing and demos. | amoufaq5 | Phase 4 |

## References

- ADR-0003 (Meta-schema and dynamic entity engine) — defines what goes into each tenant's schema.
- ADR-0008 (RBAC, ABAC, audit) — defines how tenant roles map to Postgres roles.
- ADR-0009 (Security model) — defines encryption, key management, and signing for tenant data.
- ADR-0010 (Multi-region and data residency) — defines how tenants pin to specific regions.
- ADR-0017 (Observability and SLOs) — defines per-tenant monitoring.
- PostgreSQL documentation: schemas, RLS, roles, search_path.
