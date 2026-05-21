# ADR-0177: `effectiveRetentionBatch` resolver for dashboard performance (Phase 2 M6.7.zz.tenant.batch)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0159 (effectiveRetention single-pair resolver) |

## Context

ADR-0159 / M6.7.zz.tenant.dashboard shipped `effectiveRetention(tenantId, tableName)` returning the 4-variant discriminated `EffectiveRetentionResolution`. Each call issues 2 PG round-trips (tenant policy lookup + platform policy lookup) per (tenant, table) pair.

For single-policy debugging or per-tenant audit lookups, this is fine. For **dashboard rendering at scale** (10K tenants × 3 prunable tables = 30K resolutions per page render), the round-trip cost becomes prohibitive — 30K × 2 = 60K queries per render.

ADR-0159 Q2 lined this up:

> Q2: Batch resolution. Add `effectiveRetentionBatch(pairs: ReadonlyArray<{tenantId, tableName}>)` returning a Map keyed by `${tenantId}:${tableName}`. Two SQL queries total — one IN-list per axis. Defer until a consumer needs it.

M6.7.zz.tenant.batch closes Q2. With this milestone, dashboards rendering arbitrary numbers of pairs make exactly **two queries total** (not 2N).

## Decision

### Adapter

```ts
export interface EffectiveRetentionBatchPair {
  readonly tenantId: string;
  readonly tableName: string;
}

export interface EffectiveRetentionBatchInput {
  readonly pairs: ReadonlyArray<EffectiveRetentionBatchPair>;
}

export function effectiveRetentionKey(
  tenantId: string,
  tableName: string,
): string;

async effectiveRetentionBatch(
  input: EffectiveRetentionBatchInput,
): Promise<ReadonlyMap<string, EffectiveRetentionResolution>>;
```

Returns a Map keyed by `${tenantId}:${tableName}` → `EffectiveRetentionResolution`. The `effectiveRetentionKey` helper is exported so operators don't have to remember the key format.

### Algorithm

1. **Deduplicate input pairs** by key. Operators passing the same (tenant, table) twice get one entry in the output.
2. **Collect unique table names** from the pair list — used for the platform-policy query's IN list.
3. **Run two queries in parallel** via `Promise.all`:
   - Tenant query: `SELECT ... FROM meta.tenant_retention_policies WHERE (tenant_id, table_name) IN (($1, $2), ($3, $4), ...)`
   - Platform query: `SELECT ... FROM meta.retention_policies WHERE table_name IN ($1, $2, ...)`
4. **Build lookup maps** from results (by key for tenant policies, by tableName for platform policies).
5. **Resolve in-memory per pair** using the same precedence as `effectiveRetention`:
   - tenant policy exists + opt_out=true + active (clock-aware) → `tenant_opt_out`
   - tenant policy exists + enabled → `tenant`
   - platform policy exists → `platform`
   - else → `none`

The clock injection used for opt-out expiry semantics matches `effectiveRetention` exactly. Same `this.clock()` source.

### Empty-input handling

Returns an empty Map without issuing any queries. PG doesn't accept empty IN-lists; the early return is the simplest guard.

### Two-query atomicity

`Promise.all` runs the tenant + platform queries in parallel. Single wall-clock round-trip (server-side parallelism plus client-side `await`). Neither query depends on the other — both execute against the same PG snapshot in practice (separate transactions in production, but each consistent on its own).

A more strictly atomic version would wrap both in a transaction. Rejected — see "Alternatives" below.

### Key format: `${tenantId}:${tableName}`

Simple string concatenation with `:` separator. UUID tenant IDs contain hyphens but no colons; table names match `[a-z_]+` per the META schema CHECK constraints. Collision-free.

Exported as `effectiveRetentionKey(tenantId, tableName)` — operators build the lookup key without knowing the implementation detail. Backward-compat: changing the separator later would require a major version bump.

### Why Map vs Array of triplets

Considered returning `Array<{tenantId, tableName, resolution}>`. Map wins for the dashboard use case:

- **O(1) lookup by key** — dashboard rendering iterates DOM rows and needs each row's resolution.
- **Implicit deduplication** — Map enforces unique keys; Array would need a downstream `groupBy`.
- **Smaller wire format** in JSON serialization if operators ever expose this via API.

Array can be derived from Map via `[...result.values()]` cheaply when needed.

### Why ReadonlyMap return type

Prevents accidental mutation. Operators reading values get the same defensive typing as the discriminated union itself.

## Use cases unblocked

**1. Admin dashboard rendering 10K tenants × 3 tables**

```ts
const pairs: EffectiveRetentionBatchPair[] = [];
for (const tenant of tenants) {
  for (const table of ["workflow_traces", "llm_call_traces", "llm_latency_samples"]) {
    pairs.push({ tenantId: tenant.id, tableName: table });
  }
}
const resolutions = await retention.effectiveRetentionBatch({ pairs });

for (const tenant of tenants) {
  for (const table of tables) {
    const key = effectiveRetentionKey(tenant.id, table);
    const r = resolutions.get(key);
    // Render row...
  }
}
```

30K resolutions → 2 PG queries instead of 60K.

**2. Compliance bulk report**

```ts
const compliancePairs = tenantsUnderHIPAA.flatMap(t =>
  hipaaTrackedTables.map(table => ({ tenantId: t.id, tableName: table }))
);
const resolutions = await retention.effectiveRetentionBatch({ pairs: compliancePairs });
const violations = [...resolutions.entries()].filter(([_, r]) =>
  r.source === "platform" && r.retentionDays > 30
);
```

Bulk filter for compliance violations.

**3. Tier-migration validation**

```ts
const migrated = await getMigratedTenants();
const pairs = migrated.flatMap(t => trackedTables.map(table => ({ ... })));
const resolutions = await retention.effectiveRetentionBatch({ pairs });
const unexpected = [...resolutions.entries()].filter(([_, r]) =>
  r.source !== expectedSourceForTier(...)
);
```

Verify every tenant in a migration cohort has the expected resolution source.

**4. Periodic SLO check**

```bash
# Compute % of tenants with platform-default vs custom override
crossengin retention list-policies --format json > policies.json
# Operator builds pair list from policies.json
# Calls adapter directly via Node script (no CLI for batch in v1)
```

The adapter is the substrate; CLI batch interface is deferred (see Open Questions).

## Drawbacks

1. **No CLI surface in v1.** Operators wanting ad-hoc batch lookups must write Node scripts. Defer CLI to a future milestone if requested — substrate is the meaningful win.
2. **Two non-transactional queries.** Tenant + platform queries see independent PG snapshots. In practice, retention policies change rarely (operator-driven via CLI); race window between the two queries is negligible. Atomic transaction would be heavier; deferred.
3. **PG `IN` list size limits.** Very large batches (>10K pairs) may hit PG's parser limits or query-plan inefficiencies. Operators with that scale chunk the input — future Q.
4. **No streaming.** Results are returned as one Map. Operators paging through results render them all at once.
5. **Same clock as `effectiveRetention`.** Opt-out expiry semantics share `this.clock()`; tests cover the same expiry boundary cases.
6. **Key format leakage.** If operators construct keys manually (rather than via `effectiveRetentionKey`), future changes to the separator would silently break code. Exported helper mitigates.

## Alternatives considered

1. **Single query with UNION ALL of tenant + platform.** Rejected — query plan is harder to reason about; PG doesn't optimize the JOIN well; in-memory resolution is faster than SQL-side conditional logic.
2. **Per-pair `effectiveRetention` in `Promise.all`.** Rejected — still 2N queries; the whole point is to reduce to 2.
3. **JOIN tenant + platform in SQL.** Rejected — different column shapes; per-pair resolution logic doesn't translate cleanly to SQL CASE WHEN. Application-side resolution is clearer.
4. **Return Array of `{tenantId, tableName, resolution}` triplets.** Rejected — Map gives O(1) lookup; dashboard use case is the priority.
5. **Wrap both queries in a transaction.** Rejected — overhead not warranted; policy tables change rarely; tenant + platform separate snapshots are fine.
6. **Stream results via async iterator.** Rejected — overkill for bounded result sizes; Map is the right shape.
7. **`effectiveRetentionBatch` accepting tenant-only and table-only filters.** Rejected — operators with that pattern use `listTenantPolicies` + `listPolicies` directly. Batch resolver is for explicit pair lists.
8. **Cache the platform-policy lookup at the adapter level** (since platform policies change rarely). Rejected — operators wanting caching wrap at their layer; substrate stays stateless.
9. **Build the Map key with a separator unlikely to ever collide.** Considered `\x1F` (US, ASCII unit separator) or `::`. Rejected — `:` is simple and UUIDs don't contain colons.
10. **Return the resolution alongside the requested pair shape** (so operators don't have to compute the key). Rejected — Map by key is the canonical pattern; helper exists.

## Open questions

1. **CLI `retention effective-batch --pairs-file <file>`.** Read pairs from CSV/JSON, run batch, render results. Defer.
2. **Chunking for very large inputs.** Internal automatic chunking for >10K pairs. Defer until measured.
3. **Caching the platform-policy table** to avoid the second query on repeated calls. Defer — substrate stateless.
4. **Bulk version of `expiringOptOuts` and other readers.** Same shape if operators want per-tenant pre-fetch. Defer.
5. **Composable batch resolver across all retention reads.** A unified `inspectBatch(pairs)` returning effective + expiring + history-snippets per pair. Defer.
6. **Postgres-side prepared statements** for repeated batch calls with same pair count. Defer.
7. **Adapter-side parallelism control.** A `maxConcurrent` parameter for callers wrapping the batch in higher-level orchestration. Defer.
