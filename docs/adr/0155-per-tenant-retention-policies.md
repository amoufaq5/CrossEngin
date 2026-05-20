# ADR-0155: META_TENANT_RETENTION_POLICIES — per-tenant retention overrides (Phase 2 M6.7.zz.tenant)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0143 (M6.7.zz META_RETENTION_POLICIES + PostgresTraceRetention), ADR-0153 (M6.7.zz.dry-run previewPrune) |

## Context

ADR-0143 shipped platform-default retention policies. ADR-0153 added a preview mode. ADR-0143 Q1 lined up per-tenant retention:

> Q1: Per-tenant retention policies?
> _Current direction:_ Additive — add `tenant_id NULLABLE` column, change PK to `(tenant_id, table_name)` with NULL meaning "platform default." Adapter resolves "this tenant's policy" → fallback to platform default. Future milestone.

M6.7.zz.tenant closes Q1. Operator pain it solves:

1. **Long-tail customer compliance.** A regulated tenant needs 7-year retention while platform default is 90 days.
2. **Cost-shaping per tenant.** Free-tier tenants get 7-day retention; pro-tier gets 90 days; enterprise gets 365.
3. **GDPR Article 17 (right to erasure) accelerated for opt-in tenants.** Tenants requesting shorter retention than the platform default can override individually.
4. **A/B testing retention policies before rolling them out platform-wide.**

## Decision

A SEPARATE `META_TENANT_RETENTION_POLICIES` table — not a NULLABLE column on `META_RETENTION_POLICIES`. The original direction (NULLABLE tenant_id with PK on `(tenant_id, table_name)`) ran into PG PK semantics issues (PG's UNIQUE allows multiple NULLs by default; NULLS NOT DISTINCT requires PG 15+). Two-table design is PG-version-portable, semantically cleaner, and matches the established pattern from `META_LLM_TENANT_TIER_MEMBERSHIPS` (which separates tier definitions from tenant→tier links).

### Schema additions

```ts
export const META_TENANT_RETENTION_POLICIES: TableDefinition = {
  schema: "meta",
  name: "tenant_retention_policies",
  columns: [
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "table_name",
      type: "TEXT",
      notNull: true,
      check: "table_name IN ('workflow_traces', 'llm_call_traces')",
    },
    {
      name: "retention_days",
      type: "INTEGER",
      notNull: true,
      check: "retention_days >= 1",
    },
    { name: "enabled", type: "BOOLEAN", notNull: true, default: "true" },
    { name: "last_pruned_at", type: "TIMESTAMPTZ" },
    { name: "updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["tenant_id", "table_name"],
  rls: {
    enabled: true,
    policies: [
      {
        name: "tenant_retention_policies_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};
```

Key design points:

- **`table_name` CHECK excludes `llm_latency_samples`.** That table has no `tenant_id` column (per ADR-0140 — latency samples are provider-level, not tenant-scoped). Per-tenant retention is mechanically impossible there; the DB CHECK enforces it.
- **PK on `(tenant_id, table_name)`.** Standard composite, no PG-version dependencies.
- **RLS enabled.** Same `TENANT_ISOLATION_USING` policy as other tenant-scoped tables.
- **`tenant_id REFERENCES META_TENANTS.id`.** FK ensures deleted tenants don't orphan policies.
- **No CASCADE on `META_RETENTION_POLICIES`.** The two tables are independent — deleting a platform-default policy doesn't invalidate per-tenant overrides.

### Adapter changes

`PostgresTraceRetention` extended:

1. **New method `listTenantPolicies()`** — returns all per-tenant policies (ORDER BY table, tenant).
2. **`prune()` refactored** — iterates tenant policies FIRST, then platform-default policies. Tenant DELETEs scoped via `WHERE tenant_id = $1 AND time_column < cutoff`. Platform-default DELETEs on tables with tenant_id include a `tenant_id NOT IN (SELECT tenant_id FROM meta.tenant_retention_policies WHERE table_name = $X AND enabled = true)` subquery to skip tenants with overrides.
3. **`previewPrune()` mirrors the same structure** — per-tenant COUNTs + platform-default COUNTs with the NOT IN subquery.
4. **`RetentionRunResult` and `RetentionPreviewResult`** gain an optional `tenantId?: string` field — present for per-tenant policy results, absent for platform-default.
5. **New static helper `tablesWithTenantId()`** — exposes which prunable tables support per-tenant policies (workflow_traces + llm_call_traces; NOT llm_latency_samples).
6. **PRUNABLE_TABLES map upgraded** to `{timeColumn, hasTenantId}` — keeps the schema-aware allowlist.

### SQL safety: platform-default with per-tenant exclusion

The interesting SQL is the platform-default DELETE on tables WITH tenant_id:

```sql
DELETE FROM meta.workflow_traces
WHERE occurred_at < to_timestamp($1 / 1000.0)
  AND tenant_id NOT IN (
    SELECT tenant_id FROM meta.tenant_retention_policies
    WHERE table_name = $2 AND enabled = true
  )
```

The subquery filters by `enabled = true`. A DISABLED per-tenant policy means "fall back to platform default" — those tenants' rows ARE affected by the platform default DELETE.

This correctly handles both directions of tenant-vs-default deviation:
- **Tenant with SHORTER retention than default** (e.g., free tier 7d vs default 90d). Per-tenant DELETE runs first → deletes their rows older than 7d. Platform-default DELETE excludes them via NOT IN — their newer rows survive.
- **Tenant with LONGER retention than default** (e.g., enterprise 365d vs default 90d). Per-tenant DELETE deletes only rows older than 365d. Platform-default DELETE excludes the tenant entirely, so rows aged 90-365d for that tenant ARE PRESERVED.

Without the NOT IN clause, the platform default would wipe tenant rows aged 90-365d even though their per-tenant policy specifies 365-day retention. The exclusion is critical for the LONGER-retention case.

### Ordering: tenant policies first, then platform default

The adapter runs per-tenant prunes FIRST. This order:
- Lets tenant policies clear their own rows independently.
- Ensures the platform-default `last_pruned_at` watermark reflects the COMPLETE prune cycle (after both tenant + default ran).
- Doesn't affect correctness — the platform-default's NOT IN subquery scopes correctly regardless of order.

## Cross-cutting invariants enforced

- **Two-table design.** Cleaner than NULLABLE tenant_id; PG-version-portable; matches `META_LLM_TENANT_TIER_MEMBERSHIPS` pattern.
- **`llm_latency_samples` can't have per-tenant policies.** DB CHECK + adapter allowlist enforce this both at the schema layer and the code layer.
- **RLS on `META_TENANT_RETENTION_POLICIES`.** Standard tenant isolation.
- **Per-tenant prune is independent.** A tenant's DELETE is `WHERE tenant_id = $1 AND time_column < cutoff` — no leakage between tenants.
- **Platform-default DELETE handles both shorter-and-longer-than-default cases correctly via NOT IN subquery.**
- **Disabled per-tenant policies fall back to platform default.** The `enabled = true` filter in the NOT IN subquery means disabled policies don't shield their tenants from platform-default DELETEs.
- **Per-tenant policy result rows carry `tenantId`.** Platform-default results don't. Operators discriminate via the field's presence.
- **No CASCADE between platform-default and per-tenant tables.** Independent lifecycles.
- **TS-side type narrowing.** `tenantId?: string` lets TypeScript distinguish per-tenant from platform results.

## End-to-end semantic

```ts
import { createNodePgConnection, PostgresTraceRetention } from "@crossengin/kernel-pg";

const conn = createNodePgConnection(parsePgEnvConfig());
const retention = new PostgresTraceRetention({ conn });

// Operator sets up platform-default + per-tenant overrides:
await conn.query(
  `INSERT INTO meta.retention_policies (table_name, retention_days, enabled)
   VALUES ('workflow_traces', 90, true)
   ON CONFLICT (table_name) DO UPDATE SET retention_days = EXCLUDED.retention_days`,
);
await conn.query(
  `INSERT INTO meta.tenant_retention_policies (tenant_id, table_name, retention_days, enabled)
   VALUES
     ($1, 'workflow_traces', 7, true),        -- Free-tier: 7-day retention
     ($2, 'workflow_traces', 365, true)       -- Enterprise: 365-day retention
   ON CONFLICT (tenant_id, table_name) DO UPDATE
     SET retention_days = EXCLUDED.retention_days,
         enabled = EXCLUDED.enabled,
         updated_at = now()`,
  [freeTierTenantId, enterpriseTenantId],
);

// Preview before pruning:
const previews = await retention.previewPrune();
for (const p of previews) {
  if (p.status === "previewed") {
    console.log(
      `${p.tableName}${p.tenantId !== undefined ? ` (tenant ${p.tenantId})` : ""}: would delete ${p.wouldDeleteCount.toString()}`,
    );
  }
}

// Run actual prune:
const runs = await retention.prune();
// runs contains:
// - Per-tenant entries (one per tenant policy) with tenantId field set
// - Platform-default entries (one per platform policy) with tenantId undefined

// Dashboard query — retention coverage by tenant:
//   SELECT t.tenant_id, COUNT(*) AS row_count, MAX(t.retention_days) AS max_days
//   FROM meta.tenant_retention_policies t
//   GROUP BY t.tenant_id;
```

## Alternatives considered

- **NULLABLE tenant_id on META_RETENTION_POLICIES.**
  - **Considered.** Single-table simpler.
  - **Cons.** PG's standard UNIQUE allows multiple NULLs — would let operators create duplicate platform-default rows. NULLS NOT DISTINCT requires PG 15+. Partial unique indexes work but add complexity. Two-table design is portable.
  - **Decision.** Two tables.

- **Single table with sentinel UUID for "platform default" (e.g., all-zeros).**
  - **Considered.** Avoids NULL semantics.
  - **Cons.** Requires the sentinel tenant_id to either bypass the FK constraint or have a corresponding tenants row. Operator confusion ("what's this UUID?"). Two-table design has no such ambiguity.
  - **Decision.** Two tables.

- **Cascade delete from META_RETENTION_POLICIES.**
  - **Considered.** Deleting a platform-default policy auto-deletes overrides.
  - **Cons.** Confusing semantics — per-tenant overrides are independent. Operator wanting to remove the platform policy should explicitly remove per-tenant policies first.
  - **Decision.** No cascade.

- **Allow per-tenant policies for llm_latency_samples.**
  - **Considered.** Symmetric API.
  - **Cons.** llm_latency_samples has no tenant_id column. Per-tenant retention is mechanically impossible. The DB CHECK + adapter allowlist enforce this at both layers.
  - **Decision.** Disallow at schema + adapter.

- **Run platform-default DELETE FIRST, then per-tenant.**
  - **Considered.** Cleanup the bulk first.
  - **Cons.** For tenants with LONGER retention than default, platform-default DELETE would wipe their rows aged platform-cutoff-to-tenant-cutoff. The NOT IN subquery handles this correctly regardless of order, but the tenant-first order is more intuitive in the adapter code.
  - **Decision.** Tenant first, then platform.

- **Auto-cascade enabled=false → fall back to platform default.**
  - **Considered.** Already the behavior via the NOT IN subquery filtering on `enabled = true`.
  - **Decision.** Already handled.

- **Per-tenant retention multiplier (e.g., "this tenant gets 2× platform default").**
  - **Considered.** Operator convenience.
  - **Cons.** Adds a second column with new semantics. Operators can compute the multiplied days client-side and store the absolute value.
  - **Decision.** Absolute days only.

- **Composite metaschema view that unions both tables.**
  - **Considered.** Single read for dashboards.
  - **Cons.** Hidden complexity. Operators can write the union query themselves; dashboard tooling handles it.
  - **Decision.** No view.

## Consequences

- **56 packages + 1 app, 128 meta-schema tables, 8,036 tests** (+10 from M6.7.zz.tenant: all in `trace-retention.test.ts`). All green, zero type errors.
- **128th meta-schema table** — `META_TENANT_RETENTION_POLICIES`.
- **Closes ADR-0143 Q1.**
- **Operator workflows unlocked:** long-tail customer compliance (7-year retention), cost-shaping per tenant, GDPR Article 17 acceleration, A/B retention testing.
- **`PostgresTraceRetention` adapter extended** with `listTenantPolicies()`, modified `prune()`/`previewPrune()`, new `tablesWithTenantId()` static helper.
- **Result types extended additively.** `RetentionRunResult.tenantId` and `RetentionPreviewResult.tenantId` are optional — present only on per-tenant results.
- **Existing platform-default behavior preserved.** Pre-M6.7.zz.tenant code still works: when no per-tenant policies exist, the NOT IN subquery returns empty and platform-default DELETE runs unchanged.
- **No data migration required.** Existing `META_RETENTION_POLICIES` rows continue working as platform-default policies.

## Open questions

- **Q1:** Should there be a `META_TENANT_RETENTION_POLICIES.policy_version` for optimistic-concurrency on updates?
  - _Current direction:_ Out of scope. Operators set policy at most once per provisioning workflow; high-concurrency policy updates are unlikely.
- **Q2:** Should the platform-default DELETE's NOT IN subquery be replaced with NOT EXISTS for PG planner efficiency on large tenant counts?
  - _Current direction:_ NOT IN is clearer + PG planner optimizes both equivalently. Revisit if benchmarks show otherwise.
- **Q3:** Should there be a `effective_from` column on `META_TENANT_RETENTION_POLICIES` for time-bounded retention overrides (e.g., "give tenant X 365-day retention until 2027-01-01, then revert to platform")?
  - _Current direction:_ Out of scope. Operator workflow can set + remove policies.
- **Q4:** Should per-tenant retention support a `min_retention_days` floor (preventing operators from accidentally setting too-short retention for compliance-required tenants)?
  - _Current direction:_ Operator-side policy enforcement. Substrate just stores + executes.
- **Q5:** Should `prune()` emit per-policy events on a future `RetentionInstrumentation` rail for audit?
  - _Current direction:_ Future enhancement. Substrate's per-policy result list is sufficient for synchronous audit.
- **Q6:** Should there be a `effective_retention_days(tenantId, tableName)` helper resolving per-tenant → platform-default → undefined?
  - _Current direction:_ Yes if operator dashboards demand it. Operators currently inspect the result of `listTenantPolicies()` + `listPolicies()` themselves.
- **Q7:** When tenant deleted (cascade FK), per-tenant retention policies are deleted by FK CASCADE. Should the substrate emit a notice/audit?
  - _Current direction:_ Operator-level concern. The tenant-deletion workflow handles its own audit.
- **Q8:** Should per-tenant policy creation require an explicit "override the platform default" confirmation flag?
  - _Current direction:_ Operator-side workflow. The substrate doesn't second-guess INSERTs.
