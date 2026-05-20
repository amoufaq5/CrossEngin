# ADR-0159: `effectiveRetention` resolver on PostgresTraceRetention (Phase 2 M6.7.zz.tenant.dashboard)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0143 (M6.7.zz META_RETENTION_POLICIES), ADR-0155 (M6.7.zz.tenant META_TENANT_RETENTION_POLICIES) |

## Context

ADR-0155 / M6.7.zz.tenant shipped the META_TENANT_RETENTION_POLICIES table + the corresponding per-tenant prune/preview semantics in `PostgresTraceRetention`. Operators can now declare "this tenant retains workflow_traces for 365 days while the platform default is 90." The prune path correctly chooses the right policy at scrub time.

But operators building **dashboards, compliance audits, GDPR Article 15 export tooling, and admin UIs** need to answer a different question:

> "For tenant X and table Y, what retention policy is active *right now*, and where did it come from?"

ADR-0155 Q6 lined this up:

> Q6: Should there be a `getEffectiveRetention(tenantId, tableName)` resolver that returns the policy + source ("tenant" | "platform" | "none")?
> _Current direction:_ Useful operator workflow. Build it when a downstream consumer (admin dashboard, compliance export) needs source attribution.

The substrate's existing surface forces operators to write the resolution logic themselves:

```ts
const tenantPolicies = await retention.listTenantPolicies();
const platformPolicies = await retention.listPolicies();
const t = tenantPolicies.find((p) => p.tenantId === tid && p.tableName === tn);
const effective =
  t !== undefined && t.enabled
    ? { source: "tenant", days: t.retentionDays }
    : platformPolicies.find((p) => p.tableName === tn) !== undefined
    ? { source: "platform", days: platformPolicies.find((p) => p.tableName === tn)!.retentionDays }
    : { source: "none", days: null };
```

Three problems with that operator-side shape:

1. **Two full SELECTs even when one would do.** `listTenantPolicies` reads every tenant's policies (RLS-scoped but still); `listPolicies` reads every platform policy. To answer one (tenant, table) question we load everything.
2. **No discriminated union.** TypeScript can't narrow `source === "tenant"` to guarantee a `tenantId` field, so consumers either re-narrow or carry optional fields.
3. **Replicates prune-time resolution logic.** The prune path and the dashboard path now have two implementations of "which policy wins?" — drift becomes inevitable.

M6.7.zz.tenant.dashboard closes Q6 with a single-method resolver that returns a discriminated-union result.

## Decision

Add `effectiveRetention(tenantId, tableName): Promise<EffectiveRetentionResolution>` to `PostgresTraceRetention`. Single method, two PG round-trips worst case, one best case, discriminated-union return type.

```ts
export type EffectiveRetentionResolution =
  | {
      readonly source: "tenant";
      readonly retentionDays: number;
      readonly enabled: true;
      readonly tenantId: string;
    }
  | {
      readonly source: "platform";
      readonly retentionDays: number;
      readonly enabled: boolean;
    }
  | {
      readonly source: "none";
      readonly retentionDays: null;
      readonly enabled: false;
    };
```

### Resolution algorithm

1. `SELECT … FROM meta.tenant_retention_policies WHERE tenant_id = $1 AND table_name = $2`.
2. If the row exists AND `enabled = true` → return `{source: "tenant", retentionDays, enabled: true, tenantId}`. **Skip query 2 — single round-trip.**
3. Else `SELECT … FROM meta.retention_policies WHERE table_name = $1`.
4. If the row exists → return `{source: "platform", retentionDays, enabled}` (the boolean reflects whatever's in the platform row — operators see "platform-policy-disabled" distinctly from "no-policy-at-all").
5. Else → return `{source: "none", retentionDays: null, enabled: false}`.

### Semantic alignment with prune

Step 2 wins **only if `enabled = true`** — matches ADR-0155's prune semantics where a disabled per-tenant policy falls back to platform-default. A disabled per-tenant policy is *not* the same as "this tenant opts out of retention"; it's "this tenant's override is currently turned off, so use the platform default." Operators wanting hard opt-out delete the row (or wait for a future opt-out flag — listed as Q1 below).

### Why discriminated union vs flat shape

```ts
// Flat alternative (rejected):
{
  source: "tenant" | "platform" | "none";
  retentionDays: number | null;
  enabled: boolean;
  tenantId?: string;
}
```

Three problems:

1. `tenantId` is optional in the type even when source === "tenant" → consumers re-check or carry "this should always be set" assumptions in their head.
2. `retentionDays: number | null` forces nullable handling everywhere, even on the `source === "tenant"` branch where it's guaranteed present.
3. Adding future variants (e.g. `source: "compliance_override"` for HIPAA/GDPR mandatory retention) requires touching the same flat type, breaking forward-compat for consumers narrowing on `source`.

The discriminated union solves all three: narrowing on `source` lets consumers access exactly the fields that variant carries; future variants extend the union additively.

## Use cases unblocked

**1. Admin dashboard "retention by tenant"**

```sql
-- conceptual; the resolver does this per (tenant, table)
SELECT
  t.id AS tenant_id,
  resolveRetention(t.id, 'workflow_traces') AS workflow_retention,
  resolveRetention(t.id, 'llm_call_traces') AS call_trace_retention
FROM meta.tenants t;
```

Application code:

```ts
const result = await retention.effectiveRetention(tenantId, "workflow_traces");
if (result.source === "tenant") {
  ui.showBadge("Custom Policy", { tenantId: result.tenantId });
} else if (result.source === "platform") {
  ui.showBadge(result.enabled ? "Platform Default" : "DISABLED");
} else {
  ui.showBadge("⚠️ No Policy");  // operator forgot to configure retention
}
```

**2. Compliance audit "is tenant X's retention compliant?"**

```ts
const r = await retention.effectiveRetention(tenantId, "llm_call_traces");
if (complianceTier(tenantId) === "hipaa_strict") {
  // HIPAA-strict requires ≤ 30 days for PHI-flowing tables
  if (r.source === "none") {
    flag(tenantId, "MISSING_RETENTION_POLICY");
  } else if (r.retentionDays > 30) {
    flag(tenantId, `RETENTION_EXCEEDS_HIPAA_STRICT (${r.retentionDays}d)`);
  }
}
```

**3. GDPR Article 15 export — "show me my data retention policy"**

```ts
const tables = PostgresTraceRetention.tablesWithTenantId();
const policies = await Promise.all(
  tables.map(async (t) => ({
    table: t,
    policy: await retention.effectiveRetention(dataSubjectTenantId, t),
  })),
);
// Article 15: include retention policy in the data subject's evidence pack
```

**4. CLI introspection — `crossengin retention effective <tenant> <table>`**

A future CLI subcommand can call this resolver directly to surface "what would happen if we ran prune right now?" without scanning the full database.

## Why a method on PostgresTraceRetention (vs new resolver class)

PostgresCostCeilingResolver (M6.7.x) is a separate class because it's used by `getTenantCostCeiling` callback wiring in the router — it has a lifecycle distinct from the cost-tracker. Retention has no router-side hot path; the resolver is a CLI / dashboard concern. Co-locating with the existing PostgresTraceRetention class keeps the SQL parameterization (SCHEMA + table names) consistent and avoids a per-call class instantiation pattern.

## Single-method vs split (`getTenantPolicy` + `getPlatformPolicy`)

Two methods would let callers parallelize the queries. Rejected for three reasons:

1. The happy path (enabled per-tenant policy exists) needs only one query — parallel-launching the platform query wastes a connection.
2. Operators almost always want the *resolved* answer, not the raw rows. Two methods leak resolution logic to callers.
3. The discriminated union is the natural return shape; constructing it operator-side defeats the type-safety win.

## Drawbacks

1. **Per-call cost.** Two queries worst case. At 10K tenants × 3 tables × dashboard refresh every 60s = ~30K queries/min. Acceptable for admin dashboards; consider caching for high-frequency consumers.
2. **Snapshot semantic.** The resolver returns the policy *now*. If a per-tenant policy is disabled between two calls, the resolution flips from "tenant" to "platform" with no audit trail. Operators wanting history-aware queries hit the tables directly (`policies WHERE updated_at < X`).
3. **No batch lookup.** Resolving N (tenant, table) pairs makes N method calls. Adding `effectiveRetentionBatch(pairs)` is straightforward future Q if dashboard performance demands it.

## Alternatives considered

1. **Reuse `listTenantPolicies()` + `listPolicies()` operator-side.** Existing surface; consumer writes resolution logic. Two full SELECTs, no discriminated union, drift risk. Rejected — the whole point of this milestone is to lift the resolution into the substrate.
2. **Return raw rows in a tuple `[tenant?, platform?]`.** Less prescriptive than the resolution. Rejected — operator still writes resolution logic; doesn't solve the dashboard pain.
3. **Cache resolved retentions in a materialized view.** Could be added later if the workload demands. For now operators control caching at their layer.
4. **Push resolution into a PG function `meta.effective_retention(tenant, table)`.** SQL-side resolution. Rejected — keeping it in TypeScript matches the existing PostgresTraceRetention pattern and avoids deploying server-side functions.
5. **Resolve via the existing `prune()` dry-run path.** `previewPrune()` returns counts; consumer would need to map back to policies. Rejected — preview is for cardinality estimates, not policy attribution; semantics drift would be inevitable.

## Open questions

1. **Tenant opt-out semantics.** If a per-tenant policy row has `enabled = false`, should we eventually distinguish "fall back to platform" (current) from "tenant explicitly opts out of retention" (hypothetical future enabled=false with opt_out=true)? For now there's only one disabled meaning. Defer.
2. **Batch resolution.** Add `effectiveRetentionBatch(pairs: ReadonlyArray<{tenantId, tableName}>)` returning a Map keyed by `${tenantId}:${tableName}`. Two SQL queries total — one IN-list per axis. Defer until a consumer needs it.
3. **History-aware queries.** "What was tenant X's retention on 2026-01-15?" requires append-only policy history. ADR-0143 + ADR-0155 both ship with `updated_at` not `effective_from`/`effective_to`; current shape doesn't support history. Future milestone could introduce versioned policy tables.
4. **Cache resolution.** A per-process LRU keyed by (tenant, table) → resolution with short TTL. Useful for dashboards refreshing every few seconds across thousands of tenants. Operator-side concern for now.
5. **CLI exposure.** `crossengin retention effective <tenant> <table>` subcommand mirroring the M5.9 sessions pattern. Defer to a later CLI milestone.
6. **Compliance-tier sourced retention.** A future variant `{source: "compliance_pack", retentionDays, packId}` for compliance packs that *override* tenant policies (e.g., HIPAA-strict caps tenant requests above 30 days). Discriminated union accepts this additively when needed.
