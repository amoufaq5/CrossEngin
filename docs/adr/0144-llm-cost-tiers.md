# ADR-0144: META_LLM_COST_TIERS + per-tenant tier memberships — closes ADR-0137 Q2 (Phase 2 M6.8)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0135 (M6.7 PostgresCostTracker), ADR-0137 (M6.7.x per-tenant cost ceiling) |

## Context

ADR-0137 / M6.7.x shipped per-tenant cost ceilings: one row per tenant in `META_LLM_COST_CEILINGS`, resolved via `PostgresCostCeilingResolver`. Ceilings became data, not code. ADR-0137 Q2 lined up the natural extension:

> Q2: Should there be a `META_LLM_COST_TIERS` table letting operators define tier policies and link tenants to tiers?
> _Current direction:_ Probably yes — a tier table is normalized. Refactoring: add `META_LLM_COST_TIERS(tier_id, max_usd_per_request, max_usd_per_window, window_seconds)`, change `META_LLM_COST_CEILINGS` to either keep per-tenant overrides OR reference a tier. Separate milestone.

M6.8 closes that Q. Operators with many tenants on a shared pricing plan currently have to insert N identical rows into `META_LLM_COST_CEILINGS` (one per tenant). Updating the free-tier policy requires N UPDATEs and is racy. The tier substrate normalizes:

- **Free-tier customers** all share `{maxUsdPerRequest: 0.10, maxUsdPerWindow: 1.00}` via the `free` tier.
- **Pro-tier customers** all share `{maxUsdPerRequest: 5.0, maxUsdPerWindow: 100.0}` via the `pro` tier.
- **One specific tenant** on the Pro tier with a custom raise gets a per-tenant override in `META_LLM_COST_CEILINGS`.

The resolution rule: per-tenant override → tier → global. Each level wins as a whole-object.

## Decision

Two new tables + a resolver extension.

### Table: `meta.llm_cost_tiers`

```ts
export const META_LLM_COST_TIERS: TableDefinition = {
  schema: "meta",
  name: "llm_cost_tiers",
  columns: [
    {
      name: "tier_id",
      type: "TEXT",
      notNull: true,
      check: "tier_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'",
    },
    { name: "display_name", type: "TEXT", notNull: true },
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
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["tier_id"],
};
```

- **`tier_id` TEXT PK** — operator-chosen slug (`free`, `pro`, `enterprise`). Pattern `^[a-z0-9][a-z0-9_-]{0,63}$` enforces URL-safe + log-friendly identifiers.
- **`display_name`** — human-readable label for dashboards.
- **Policy columns NULLABLE** — same semantics as M6.7.x. NULL = unbounded on that axis.
- **Platform-wide, no RLS** — tiers are operator-defined policies, not tenant data.

### Table: `meta.llm_tenant_tier_memberships`

```ts
export const META_LLM_TENANT_TIER_MEMBERSHIPS: TableDefinition = {
  schema: "meta",
  name: "llm_tenant_tier_memberships",
  columns: [
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "tier_id",
      type: "TEXT",
      notNull: true,
      references: { schema: "meta", table: "llm_cost_tiers", column: "tier_id", onDelete: "RESTRICT" },
    },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["tenant_id"],
  rls: {
    enabled: true,
    policies: [
      { name: "llm_tenant_tier_memberships_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};
```

- **`tenant_id` PK** — one tier membership per tenant. Tenants in multiple "logical" tiers would create resolution ambiguity; substrate enforces one tier per tenant.
- **`ON DELETE RESTRICT`** — a tier cannot be deleted while any tenant references it. Operators must migrate tenants first.
- **RLS-enabled** — tenant-scoped data; standard isolation policy.

### Resolver semantic (post-M6.8)

`PostgresCostCeilingResolver.resolve(tenantId)`:

1. **Per-tenant override.** SELECT from `META_LLM_COST_CEILINGS WHERE tenant_id = $1`. If a row exists, return that (M6.7.x whole-object override semantic preserved).
2. **Tier fallback.** SELECT joining `META_LLM_TENANT_TIER_MEMBERSHIPS m INNER JOIN META_LLM_COST_TIERS t ON t.tier_id = m.tier_id WHERE m.tenant_id = $1`. If a row, return the tier's CostCeiling.
3. **Otherwise** undefined → router falls back to global.

Three-level fallback: **per-tenant override → tier → global**. Each level wins as a whole-object (no field-by-field merge). This matches the M6.7.x decision: "tenant ceiling REPLACES global rather than merging."

Two SQL round-trips in the worst case (no per-tenant + no tier = 2 queries). Best case (per-tenant exists) is one query — the second is skipped. PG handles 10K+ PK lookups/sec; 5K+ effective with the worst-case 2-query path is still fine.

### Why whole-object (not field-merge)?

A field-merge resolution would be:
- per-tenant `max_usd_per_request` if set, else tier value, else undefined
- per-tenant `max_usd_per_window` if set, else tier value, else undefined
- etc.

This makes per-tenant rows feel like "deltas" against the tier. It's more flexible but:

- Breaks M6.7.x semantics. `NULL` in M6.7.x means "explicitly unbounded." Under field-merge, NULL would mean "fall back to tier."
- Operator reasoning gets harder. "What's tenant X's effective ceiling?" requires reading two rows + composing.
- Whole-object override is mechanical. "Tenant X has policy P" means P is the law for that tenant.

Whole-object wins on clarity. Operators wanting field-level tuning create a per-tenant override row with the full intended policy.

## Cross-cutting invariants enforced

- **M6.7.x semantics preserved.** Per-tenant rows still mean "whole-object override." `NULL` still means "explicitly unbounded on that axis."
- **Tier deletion is gated.** `ON DELETE RESTRICT` prevents accidentally orphaning tenants by deleting their tier.
- **One tier per tenant.** `tenant_id` is the PK on memberships; UPSERT semantics.
- **No N×M complexity.** Tier definitions are O(tiers) rows; memberships are O(tenants) rows. Adding a new tier is one INSERT; moving N tenants to a new tier is N UPDATEs (or one bulk UPDATE).
- **Tier-id slug is URL-safe + log-friendly.** Pattern enforces lowercase alphanumeric + `-` + `_` only.
- **No new dependencies.** Resolver still uses only `PgConnection`.
- **Drop-in compatible.** Existing `getTenantCostCeiling: resolver.resolve` wiring continues to work; new tier fallback is transparent.

## End-to-end semantic

```ts
import { createNodePgConnection } from "@crossengin/kernel-pg";
import { DefaultLlmRouter } from "@crossengin/ai-router";
import { PostgresCostCeilingResolver } from "@crossengin/ai-router-pg";

const conn = createNodePgConnection(parsePgEnvConfig());

// Operator sets up tiers once:
await conn.query(
  `INSERT INTO meta.llm_cost_tiers (tier_id, display_name, max_usd_per_request, max_usd_per_window)
   VALUES
     ('free', 'Free tier', 0.10, 1.00),
     ('pro', 'Pro tier', 5.0, 100.0),
     ('enterprise', 'Enterprise tier', NULL, NULL)
   ON CONFLICT (tier_id) DO UPDATE
     SET max_usd_per_request = EXCLUDED.max_usd_per_request,
         max_usd_per_window = EXCLUDED.max_usd_per_window,
         updated_at = now()`,
);

// Tenant onboarding wires the membership:
await conn.query(
  `INSERT INTO meta.llm_tenant_tier_memberships (tenant_id, tier_id)
   VALUES ($1, 'pro')
   ON CONFLICT (tenant_id) DO UPDATE
     SET tier_id = EXCLUDED.tier_id, updated_at = now()`,
  [tenantId],
);

// One specific Pro-tier tenant gets a custom raise:
await conn.query(
  `INSERT INTO meta.llm_cost_ceilings (tenant_id, max_usd_per_request, max_usd_per_window)
   VALUES ($1, 50.0, 5000.0)
   ON CONFLICT (tenant_id) DO UPDATE
     SET max_usd_per_request = EXCLUDED.max_usd_per_request,
         max_usd_per_window = EXCLUDED.max_usd_per_window,
         updated_at = now()`,
  [specialTenantId],
);

// Resolver returns the right ceiling at each level:
const resolver = new PostgresCostCeilingResolver({ conn });
await resolver.resolve(tenantId);          // Pro tier ceiling
await resolver.resolve(specialTenantId);   // Per-tenant override
await resolver.resolve(unknownTenantId);   // undefined → router uses global

// Plug into the router:
const router = new DefaultLlmRouter({
  ...,
  getTenantCostCeiling: resolver.resolve,
});
```

Adjusting the free tier's policy is a single UPDATE that takes effect for every free-tier tenant on the next request:

```sql
UPDATE meta.llm_cost_tiers
SET max_usd_per_window = 0.50, updated_at = now()
WHERE tier_id = 'free';
```

No restart, no per-tenant rewrite.

## Alternatives considered

- **Field-merge resolution (per-tenant field if set, else tier field).**
  - **Considered.** More flexible.
  - **Cons.** Breaks M6.7.x semantics (NULL meant "explicitly unbounded"; under merge it would mean "fall back"). Operator reasoning harder.
  - **Decision.** Whole-object override at each level.

- **Add `tier_id` column directly to `META_LLM_COST_CEILINGS`.**
  - **Considered.** One less table.
  - **Cons.** Muddles the row meaning: is this a per-tenant override OR a tier link OR both? Resolver logic becomes harder. Two distinct concepts deserve two distinct tables.
  - **Decision.** Separate `META_LLM_TENANT_TIER_MEMBERSHIPS`.

- **Add `llm_cost_tier_id` to `META_TENANTS` directly.**
  - **Considered.** One less table.
  - **Cons.** Pollutes the tenant table with ai-router-specific column. Bad coupling — every package wanting per-tenant config would push columns into META_TENANTS.
  - **Decision.** Separate membership table.

- **Tier hierarchy / inheritance (e.g., `pro` inherits from `free`).**
  - **Considered.** Some pricing models use tier hierarchies.
  - **Cons.** Significant complexity for a use case operators can handle by configuring tiers explicitly. Defer.
  - **Decision.** Flat tier list.

- **Multiple tiers per tenant (e.g., tenant on both `free-llm` and `pro-search`).**
  - **Considered.** Different cost ceilings per subsystem.
  - **Cons.** This isn't what cost tiers are for — they're a single ceiling per tenant for LLM-router cost. Subsystem-specific ceilings belong to subsystem-specific tables. M6.8 stays scoped to LLM router.
  - **Decision.** One tier per tenant for the LLM cost dimension.

- **`ON DELETE CASCADE` on tier_id (delete tier → delete memberships).**
  - **Considered.** Operator convenience.
  - **Cons.** Footgun — accidental tier deletion silently strips ceiling protection from all members. RESTRICT forces a deliberate migration.
  - **Decision.** RESTRICT.

- **JOIN query for both lookups in one round-trip.**
  - **Considered.** `SELECT COALESCE(c.*, t.*) FROM tenants ... LEFT JOIN cost_ceilings c ... LEFT JOIN memberships m ... LEFT JOIN tiers t ...`.
  - **Cons.** Forces field-merge semantics OR clutters the SELECT with CASE WHEN c.tenant_id IS NOT NULL THEN c.X ELSE t.X END for every column. Two-step is clearer + the second query only fires when needed.
  - **Decision.** Two queries.

- **Cache tier definitions in-memory (operator reads tiers infrequently).**
  - **Considered.** Reduce PG read pressure.
  - **Cons.** Cache invalidation. Operator updating a tier expects effect on the next request. Skipping cache is the obvious-default; operators wanting a cache wrap the resolver.
  - **Decision.** No cache.

## Consequences

- **56 packages + 1 app, 127 meta-schema tables, 7,728 tests** (+8 from M6.8: all in `cost-ceiling-resolver.test.ts`). All green, zero type errors. Note: M6.8 adds TWO meta-schema tables in one milestone (the tier + the membership), bringing 125 → 127.
- **Closes ADR-0137 Q2.**
- **Per-tier pricing is now expressible without N row rewrites.** Free / pro / enterprise tier changes propagate via a single UPDATE on the tier row.
- **Per-tenant overrides remain.** Tenants needing custom ceilings get an entry in `META_LLM_COST_CEILINGS`; that takes precedence over their tier.
- **Tier deletion is safe.** `ON DELETE RESTRICT` prevents orphaning.
- **Resolution: at most 2 PG round-trips per request.** Best case 1 (per-tenant exists). Worst case 2 (no per-tenant + no tier).
- **No breaking change.** Existing callers continue to work without tiers; tier fallback is opt-in via populating the new tables.

## Open questions

- **Q1:** Should there be a `getTenantTier(tenantId): Promise<TierRow | undefined>` helper exposed on the resolver?
  - _Current direction:_ Useful for dashboards. Additive; future enhancement.
- **Q2:** Should the resolver report which level the ceiling came from (override / tier / global)?
  - _Current direction:_ Yes — operators auditing want this. Either add a `resolveDetailed()` method returning `{ceiling, source: "override"|"tier"|"none", tierIdMatched?: string}`, OR emit a `RouterInstrumentation` event (M6.7.z) carrying the resolution result. Closes ADR-0137 Q3+Q4 properly. Future milestone.
- **Q3:** Should tier definitions support effective-from / effective-to (scheduled changes)?
  - _Current direction:_ Same shape as ADR-0137 Q1 (history-aware ceilings). Additive: add `effective_from`/`effective_to` columns; resolver query becomes time-bounded. Defer.
- **Q4:** Should tiers carry non-cost policy too (e.g., `max_concurrent_requests`, `preferred_provider`)?
  - _Current direction:_ Probably yes — tiers as a generic policy bundle. But each extension is additive. Out of scope for M6.8.
- **Q5:** Tier deletion workflow (operator wants to remove the `free` tier but tenants reference it)?
  - _Current direction:_ Bulk-migrate first: `UPDATE memberships SET tier_id = 'basic' WHERE tier_id = 'free'` then `DELETE FROM tiers WHERE tier_id = 'free'`. Operator-side workflow.
- **Q6:** Per-region tiers (different ceilings per AWS/GCP region)?
  - _Current direction:_ Operators run separate router instances per region with separate PG schemas. Out of scope.
- **Q7:** Should there be a `META_LLM_COST_TIERS.description` column?
  - _Current direction:_ Defer. `display_name` is enough for now; operators can add description in a follow-up.
- **Q8:** Tier renames (`free` → `free_tier_v1`)?
  - _Current direction:_ Painful by design — `tier_id` is the PK and FK target. Operators wanting renames create a new tier, bulk-migrate memberships, delete the old. Same workflow as Q5.
