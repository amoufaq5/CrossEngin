# ADR-0137: Per-tenant cost ceiling — META_LLM_COST_CEILINGS + PostgresCostCeilingResolver (Phase 2 M6.7.x)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0059 (M6.5 ai-router), ADR-0135 (M6.7 PostgresCostTracker) |

## Context

ADR-0059 / M6.5 ships a `costCeiling: CostCeiling` field on the router that applies a single ceiling to **every tenant**. ADR-0135 / M6.7 makes the per-window cost durable per-tenant via `META_LLM_COST_WINDOWS`. What is still missing: per-tenant *ceiling* configuration.

The deferred questions from ADR-0135:

> Q1: Should there be a per-tenant `META_LLM_COST_CEILINGS` table so operators can adjust ceilings without redeploying?
> _Current direction:_ Yes — a natural next milestone (M6.8?). Schema: `(tenant_id, max_usd_per_request, max_usd_per_window, window_seconds, effective_from)`. Separate ADR.
>
> Q4: Should the per-request gate (`maxUsdPerRequest`) be configurable per-tenant alongside per-window?
> _Current direction:_ Yes, paired with Q1.

Operator pain without per-tenant ceilings:

1. **Restart required to change a ceiling.** Adding a tenant on a paid plan requires redeploy.
2. **No "free tier" vs "enterprise" cost gating.** Every tenant gets the same ceiling.
3. **Trial-customer overspend.** A new tenant being evaluated needs a tight ceiling while paying customers need a loose one.
4. **Compliance — air-gap by ceiling.** Some regulated tenants need explicit per-tenant budget approvals.

M6.7.x closes Q1 + Q4 in one milestone.

## Decision

Three changes:

1. **`META_LLM_COST_CEILINGS` table.** One row per tenant. Columns: `(tenant_id, max_usd_per_request, max_usd_per_window, window_seconds, effective_from, updated_at)`. The three policy columns are NULLABLE — `NULL` means "unbounded" for that dimension. PK on `tenant_id` (same shape as `META_LLM_COST_WINDOWS`).
2. **`getTenantCostCeiling` field on `DefaultLlmRouterOptions`.** Optional `(tenantId: string) => Promise<CostCeiling | undefined>`. When wired, the router calls it per-request and uses the result if it's defined; falls back to the global `costCeiling` otherwise.
3. **`PostgresCostCeilingResolver` in `@crossengin/ai-router-pg`.** Reads from `META_LLM_COST_CEILINGS` and shapes the row into a `CostCeiling`. Drop-in for `getTenantCostCeiling`.

### Table: `meta.llm_cost_ceilings`

```ts
export const META_LLM_COST_CEILINGS: TableDefinition = {
  schema: "meta",
  name: "llm_cost_ceilings",
  columns: [
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "max_usd_per_request",
      type: "NUMERIC(18,8)",
      check: "max_usd_per_request IS NULL OR max_usd_per_request > 0",
    },
    {
      name: "max_usd_per_window",
      type: "NUMERIC(18,8)",
      check: "max_usd_per_window IS NULL OR max_usd_per_window > 0",
    },
    {
      name: "window_seconds",
      type: "INTEGER",
      check: "window_seconds IS NULL OR window_seconds > 0",
    },
    { name: "effective_from", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["tenant_id"],
  rls: { ... },
};
```

- **`tenant_id` PK** — one row per tenant. UPSERT semantics.
- **NULL-policy columns** — NULL means "no limit on this axis." A tenant with `max_usd_per_window = NULL` has no window cap. `max_usd_per_request = NULL` has no per-request cap. Symmetric to the in-memory `CostCeiling`'s optional fields.
- **`NUMERIC(18,8)`** — sub-cent precision, matches `META_LLM_COST_WINDOWS`.
- **`> 0` CHECK on policies** — zero or negative isn't a useful ceiling; reject at write time.
- **`effective_from`** — for the future history-table extension (Q2 below). M6.7.x doesn't read this field; one row per tenant. Captured now so the migration story is additive.
- **`updated_at`** — audit timestamp.

### Router integration

```ts
export interface DefaultLlmRouterOptions extends RouterConfig {
  readonly retry?: RetryPolicy;
  readonly costCeiling?: CostCeiling;
  readonly getTenantCostCeiling?: (tenantId: string) => Promise<CostCeiling | undefined>;
  readonly costTracker?: CostTracker;
  readonly latencyTracker?: LatencyTracker;
  readonly clock?: () => number;
}
```

In `enforceCeilingPreflight`:

```ts
private async resolveCeiling(tenantId: string): Promise<CostCeiling | undefined> {
  if (this.getTenantCostCeiling !== undefined) {
    const tenantCeiling = await this.getTenantCostCeiling(tenantId);
    if (tenantCeiling !== undefined) return tenantCeiling;
  }
  return this.costCeiling;
}

private async enforceCeilingPreflight(tenantId, estimatedCostUsd) {
  const ceiling = await this.resolveCeiling(tenantId);
  if (ceiling === undefined) return;  // no ceiling at any level
  // ... check ...
}
```

Resolution order: **tenant-scoped overrides global**. When `getTenantCostCeiling` returns a non-undefined value, that's used verbatim (not merged with the global). Operators wanting "tenant value OR fall back to global" set `getTenantCostCeiling` to return `undefined` when they want the global to apply.

### `PostgresCostCeilingResolver`

```ts
export class PostgresCostCeilingResolver {
  constructor(opts: { conn: PgConnection });
  readonly resolve = async (tenantId: string): Promise<CostCeiling | undefined> => {
    // SELECT max_usd_per_request, max_usd_per_window, window_seconds
    //   FROM meta.llm_cost_ceilings WHERE tenant_id = $1
    // Returns CostCeiling with only the non-NULL fields set.
  };
}
```

`resolve` is a bound arrow property so operators can pass it directly:

```ts
const resolver = new PostgresCostCeilingResolver({ conn });
const router = new DefaultLlmRouter({
  ...,
  getTenantCostCeiling: resolver.resolve,
});
```

`::TEXT` casts on `NUMERIC` preserve sub-cent precision. Each `NULL` column maps to "field omitted on the `CostCeiling` object" so the in-memory ceiling logic (which checks `field !== undefined`) works correctly.

## Cross-cutting invariants enforced

- **Tenant-scoped overrides global.** When the resolver returns a `CostCeiling`, that's the law. Global only applies when the resolver is unwired OR returns `undefined`.
- **Whole-object override.** A tenant-scoped ceiling **replaces** the global, not merges. If a tenant ceiling has `maxUsdPerRequest=1.0` and the global has `maxUsdPerWindow=100`, the effective ceiling is just `{maxUsdPerRequest: 1.0}` — no inherited window cap. This matches how operators reason: "this tenant's policy."
- **NULL = unbounded.** No row → no per-tenant ceiling → fall back to global. Row present but all columns NULL → tenant has an explicit "no limits" policy (overrides any global).
- **No transactions needed on read.** Each `resolve` is a single SELECT. Resolution is per-request — a tight loop won't be a problem (PG handles 10K+ QPS on a PK lookup).
- **Drop-in for the router contract.** `PostgresCostCeilingResolver.resolve` matches `(tenantId: string) => Promise<CostCeiling | undefined>` exactly.
- **No breaking change.** Existing callers with global `costCeiling` only continue to work — `getTenantCostCeiling` is optional. M6.7's PostgresCostTracker is untouched. The in-memory ceiling path is untouched.
- **Tenant isolation via RLS.** Standard `TENANT_ISOLATION_USING` policy on the new table.

## End-to-end semantic

```ts
import { createNodePgConnection } from "@crossengin/kernel-pg";
import { DefaultLlmRouter } from "@crossengin/ai-router";
import {
  PostgresCostCeilingResolver,
  PostgresCostTracker,
} from "@crossengin/ai-router-pg";

const conn = createNodePgConnection(parsePgEnvConfig());
const ceilingResolver = new PostgresCostCeilingResolver({ conn });
const router = new DefaultLlmRouter({
  ...,
  costTracker: new PostgresCostTracker({ conn }),
  costCeiling: { maxUsdPerRequest: 5.0, maxUsdPerWindow: 100.0 },  // global default
  getTenantCostCeiling: ceilingResolver.resolve,
});

// Operator wants to grant a higher ceiling to tenant X:
await conn.query(
  `INSERT INTO meta.llm_cost_ceilings (tenant_id, max_usd_per_request, max_usd_per_window)
   VALUES ($1, 50.0, 5000.0)
   ON CONFLICT (tenant_id) DO UPDATE
     SET max_usd_per_request = EXCLUDED.max_usd_per_request,
         max_usd_per_window = EXCLUDED.max_usd_per_window,
         updated_at = now()`,
  [tenantId],
);

// Next router.complete() for that tenant uses {maxUsdPerRequest: 50, maxUsdPerWindow: 5000}.
// All other tenants still use {maxUsdPerRequest: 5, maxUsdPerWindow: 100}.
// No restart required.
```

## Alternatives considered

- **Merge tenant-scoped + global into a single effective ceiling (field-by-field).**
  - **Considered.** If tenant has `maxUsdPerRequest=1.0` and global has `maxUsdPerWindow=100`, effective = `{maxUsdPerRequest: 1.0, maxUsdPerWindow: 100}`.
  - **Cons.** Surprising. Operator setting "tenant X has policy P" expects P to be the whole story. Merge couples the layers; debugging requires reading both. Whole-object override is mechanical.
  - **Decision.** Whole-object override.

- **Make tenant-scoped take effect only when STRICTER than global (safety guard).**
  - **Considered.** "Tenant ceiling can only tighten, never loosen."
  - **Cons.** Punishes the legitimate use case of "this tenant pays for a higher ceiling." The operator wiring per-tenant is explicit about loosening it; a safety guard would block their intent.
  - **Decision.** No guard. Operator authority.

- **Store ceilings as JSONB instead of typed columns.**
  - **Considered.** `policy JSONB NOT NULL` carrying the whole `CostCeiling`.
  - **Cons.** Loses CHECK constraints (positive cost amounts), loses column-level indexability, harder to read in psql, harder to filter `WHERE max_usd_per_window IS NULL` for dashboards.
  - **Decision.** Typed columns.

- **Use a history-of-changes design (multiple rows per tenant ordered by `effective_from`).**
  - **Considered.** Lets operators schedule ceiling changes ("starting next month, tenant X's window cap becomes $200").
  - **Cons.** More complex resolution (need a `WHERE effective_from <= now() ORDER BY effective_from DESC LIMIT 1` query). Most operators just want "set the ceiling now." Schedule-ahead is a future milestone — the column is already there (`effective_from`), so the migration to history-aware reads is additive.
  - **Decision.** One row per tenant for M6.7.x. History via additive change (Q1 below).

- **Cache the resolver result in-memory for some TTL.**
  - **Considered.** Per-request SELECT is one round-trip; a 1s TTL would reduce DB load.
  - **Cons.** Cache invalidation. Operator changes the ceiling expecting it to take effect immediately. A short TTL is the worst of both worlds (latency on first request, stale data on rest). PG handles PK lookups fast.
  - **Decision.** No cache. Operators wanting a cache wire one above the resolver.

- **Skip the resolver; teach the router to read `META_LLM_COST_CEILINGS` directly.**
  - **Considered.** Less plumbing.
  - **Cons.** Couples `@crossengin/ai-router` to `@crossengin/kernel-pg`. The contract package must remain free of PG. The resolver pattern keeps the contract clean.
  - **Decision.** Resolver via the `@crossengin/ai-router-pg` package.

## Consequences

- **56 packages + 1 app, 122 meta-schema tables, 7,613 tests** (+16 from M6.7.x: 7 in `router.test.ts` covering tenant-scoped resolution, 9 in `cost-ceiling-resolver.test.ts`). All green, zero type errors.
- **Operators can adjust ceilings without redeploying.** Cost policy is now data, not code.
- **ADR-0135 Q1 + Q4 closed.**
- **Per-tier pricing now expressible.** Free tier / pro tier / enterprise tier all live in the same table.
- **Trial overspend is now caught at the request level.** New tenant defaulted to a tight ceiling; pay-to-loosen workflow.
- **No breaking change.** Existing callers continue with global `costCeiling` only.
- **Schema is forward-compatible with history-aware reads.** `effective_from` column already in place.

## Open questions

- **Q1:** Should `META_LLM_COST_CEILINGS` support multiple rows per tenant for scheduled-ahead changes?
  - _Current direction:_ Likely yes — additive migration: drop the `tenant_id` PK, add a `(tenant_id, effective_from)` UNIQUE constraint instead. Resolver query becomes `WHERE tenant_id = $1 AND effective_from <= now() ORDER BY effective_from DESC LIMIT 1`. Separate milestone when the use case lands.
- **Q2:** Should there be a `META_LLM_COST_TIERS` table letting operators define tier policies and link tenants to tiers?
  - _Current direction:_ Probably yes — a tier table is normalized. Refactoring: add `META_LLM_COST_TIERS(tier_id, max_usd_per_request, max_usd_per_window, window_seconds)`, change `META_LLM_COST_CEILINGS` to either keep per-tenant overrides OR reference a tier. Separate milestone.
- **Q3:** Should the resolver emit a structured signal on cache miss / hit (observability)?
  - _Current direction:_ Out of scope. A `RouterInstrumentation` interface (ADR-0135 Q2) is the natural home for ceiling-resolution events.
- **Q4:** Should the router track which ceiling (tenant vs global) was used for which request (audit)?
  - _Current direction:_ Out of scope. `CostCeilingExceededError.check` contains the limit value, which makes the source inferable. Full audit needs `RouterInstrumentation`.
- **Q5:** Should we add a `policy_label` column (e.g., "free-tier", "pro", "enterprise") so dashboards can group tenants by policy?
  - _Current direction:_ Not yet — that's properly addressed by the tier table (Q2).
- **Q6:** Should `window_seconds` per-tenant interact with the `PostgresCostTracker`'s `windowSeconds`?
  - _Current direction:_ The tracker's `windowSeconds` is the IMPLEMENTATION's tumbling-window duration. The ceiling's `window_seconds` is the POLICY's view of "the window." They should match if both are used. Operators wiring different values would get surprising behavior — the tracker truncates / rolls at one boundary, the ceiling logic computes against another. M6.7.x doesn't enforce alignment. Listed as a follow-up validation Q.
- **Q7:** Migration path for tenants existing pre-M6.7.x: do they get an automatic ceiling row?
  - _Current direction:_ No — absence of a row means "no per-tenant ceiling; fall back to global." That's the migration: legacy tenants get global, new tenants opt-in via INSERT. Zero data migration required.
