# ADR-0154: PostgresCostCeilingResolver.resolveDetailed — source attribution for ceiling resolution (Phase 2 M6.8.x)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0137 (M6.7.x per-tenant cost ceiling), ADR-0141 (M6.7.z RouterInstrumentation), ADR-0144 (M6.8 cost tiers) |

## Context

`PostgresCostCeilingResolver.resolve(tenantId)` (M6.7.x / M6.8) returns the effective `CostCeiling` for a tenant by walking a three-level fallback: per-tenant override → tier → global. The return type is `CostCeiling | undefined`. Operators can see WHAT the ceiling is, but not WHY — which level matched, which tier, what the resolution path was.

Three ADRs deferred the source-attribution question to a follow-up:

> ADR-0144 Q2: Should the resolver report which level the ceiling came from (override / tier / global)?
> _Current direction:_ Yes — operators auditing want this. Either add a `resolveDetailed()` method returning `{ceiling, source: "override"|"tier"|"none", tierIdMatched?: string}`, OR emit a `RouterInstrumentation` event (M6.7.z) carrying the resolution result. Closes ADR-0137 Q3+Q4 properly. Future milestone.
>
> ADR-0137 Q3: Should the resolver emit a structured signal on cache miss / hit (observability)?
> _Current direction:_ A `RouterInstrumentation` interface is the natural home for ceiling-resolution events.
>
> ADR-0137 Q4: Should the router track which ceiling (tenant vs global) was used for which request (audit)?
> _Current direction:_ Out of scope. Full audit needs `RouterInstrumentation`.
>
> ADR-0141 Q3: Should ceiling-resolution events emit traces (which tenant ceiling vs global was used)?
> _Current direction:_ Yes — closes ADR-0137 Q3+Q4 fully. Either extends `llm_call_started` attributes with `effectiveCeiling: {...}` or adds a new event kind `ceiling_resolved`.

M6.8.x picks the simpler of the two paths: add `resolveDetailed()` to the resolver returning a structured `CostCeilingResolution` object. Operators wanting traces in `META_LLM_CALL_TRACES` wrap the result themselves via the existing `RouterInstrumentation` rail.

Operator pain it solves:

1. **Audit clarity.** "Tenant X is being capped at $5/req. Why? Is that their tier policy or a per-tenant override?"
2. **Tier migration verification.** "I just moved Tenant Y from free to pro. Did the resolver pick up the new tier?"
3. **Per-tenant policy debugging.** "Operator says tenant Z should have no cap, but they're being blocked. Is the resolver finding a stale row?"
4. **Dashboard reporting.** "How many tenants are on each tier vs override?"

## Decision

Add `resolveDetailed()` as a new method on `PostgresCostCeilingResolver`. Refactor `resolve()` to delegate to it (no duplication).

```ts
export type CostCeilingSource = "override" | "tier" | "none";

export interface CostCeilingResolution {
  readonly ceiling: CostCeiling | undefined;
  readonly source: CostCeilingSource;
  readonly tierId?: string;  // present only when source === "tier"
}

class PostgresCostCeilingResolver {
  readonly resolve: (tenantId: string) => Promise<CostCeiling | undefined>;
  readonly resolveDetailed: (tenantId: string) => Promise<CostCeilingResolution>;
}
```

### Implementation

`resolveDetailed()` mirrors `resolve()`'s three-level fallback but tracks which path matched and surfaces the tier_id from the tier-membership JOIN:

1. **Per-tenant override.** SELECT from `META_LLM_COST_CEILINGS WHERE tenant_id = $1`. If row exists, return `{ceiling, source: "override"}`. No `tierId`.
2. **Tier fallback.** SELECT joining `META_LLM_TENANT_TIER_MEMBERSHIPS m INNER JOIN META_LLM_COST_TIERS t ON t.tier_id = m.tier_id WHERE m.tenant_id = $1`. Now selects `t.tier_id` alongside the policy columns. If row exists, return `{ceiling, source: "tier", tierId: t.tier_id}`.
3. **No match.** Return `{ceiling: undefined, source: "none"}`. No `tierId`.

The tier query gains one column (`t.tier_id`) — additive, no schema change, no breaking change for downstream consumers.

`resolve()` now delegates to `resolveDetailed()` and projects only the `ceiling` field. Zero duplication; legacy callers see identical behavior.

### Why source enum (not boolean flags)?

Alternatives:
- `{ceiling, hasOverride: boolean, hasTier: boolean}` — two booleans, mutually exclusive except neither = `"none"`.
- `{ceiling, sourceLevel: 1|2|3}` — numeric tier.

`source: "override" | "tier" | "none"` is the clearest discriminated union. Operators reading logs and dashboards see `source: "tier"` and immediately understand. Booleans require operator inference; numeric levels are documentation overhead.

### Why `tierId` only on `"tier"` source?

`tierId` makes no sense for `"override"` (no tier matched) or `"none"` (nothing matched). Making it `string | undefined` always-present would require operators to check `source === "tier"` AND `tierId !== undefined` — redundant. The conditional shape lets TypeScript narrow:

```ts
const result = await resolver.resolveDetailed(tenantId);
if (result.source === "tier") {
  console.log(`Tenant ${tenantId} on tier ${result.tierId}`);  // tierId is string-narrowed here
}
```

### Why one method (not splitting into resolve + getSource)?

Two methods would require two queries to get both pieces of info. One method = one query path. Operators wanting just the ceiling use `resolve()`; operators wanting attribution use `resolveDetailed()`.

### Why not emit a `ceiling_resolved` instrumentation event instead?

ADR-0144 Q2 / ADR-0141 Q3 floated two paths:
- (A) `resolveDetailed()` method — return source attribution synchronously.
- (B) `ceiling_resolved` RouterInstrumentation event — async audit.

(A) is the foundation. Operators can pipe (A) into the `RouterInstrumentation` rail themselves if they want async traces. Foundation first; observability can build on top.

Future enhancement: emit a `ceiling_resolved` event automatically in `DefaultLlmRouter.enforceCeilingPreflight` carrying the resolution result. Out of scope for M6.8.x.

## Cross-cutting invariants enforced

- **Additive method, no breaking change.** `resolve()` continues to work identically (delegates to `resolveDetailed()`).
- **Same three-level fallback semantics.** Override → tier → global (where "global" maps to `source: "none"` since the resolver doesn't know about the router-level global).
- **Same query shape for `resolve()`.** Tier query gains `t.tier_id` selection but the JOIN + WHERE + scoping is unchanged.
- **`tierId` conditionally present.** Only on `source: "tier"`. Avoids ambiguous undefined / null on other sources.
- **Type-safe discriminated union.** `source` is a string literal type; `tierId` only appears in TypeScript's narrowed `"tier"` branch.
- **No schema change.** `tier_id` was already on `META_LLM_TENANT_TIER_MEMBERSHIPS`; M6.8.x just selects it.
- **PG NUMERIC precision preserved.** Same `::TEXT` cast + `Number()` parse pattern for tier-source ceilings.
- **Same drop-in router compat.** `resolve.resolve` is still the `(tenantId) => Promise<CostCeiling | undefined>` shape that `DefaultLlmRouterOptions.getTenantCostCeiling` expects.

## End-to-end semantic

```ts
import { createNodePgConnection } from "@crossengin/kernel-pg";
import { PostgresCostCeilingResolver } from "@crossengin/ai-router-pg";
import { DefaultLlmRouter } from "@crossengin/ai-router";

const conn = createNodePgConnection(parsePgEnvConfig());
const resolver = new PostgresCostCeilingResolver({ conn });

// Wire the simple form into the router (legacy callers unchanged):
const router = new DefaultLlmRouter({
  ...,
  getTenantCostCeiling: resolver.resolve,
});

// Operator audit endpoint — surface WHY a ceiling applies:
async function explainCeiling(tenantId: string) {
  const result = await resolver.resolveDetailed(tenantId);
  switch (result.source) {
    case "override":
      return `Tenant ${tenantId} has a per-tenant override: ${JSON.stringify(result.ceiling)}`;
    case "tier":
      return `Tenant ${tenantId} is on tier "${result.tierId}": ${JSON.stringify(result.ceiling)}`;
    case "none":
      return `Tenant ${tenantId} has no policy; router will use global ceiling if set`;
  }
}

// Operator dashboard — tier distribution:
async function tierBreakdown(tenantIds: readonly string[]) {
  const summary = { override: 0, tier: { free: 0, pro: 0, enterprise: 0 }, none: 0 };
  for (const id of tenantIds) {
    const r = await resolver.resolveDetailed(id);
    if (r.source === "override") summary.override += 1;
    else if (r.source === "tier") summary.tier[r.tierId as keyof typeof summary.tier] += 1;
    else summary.none += 1;
  }
  return summary;
}

// CI verification — assert a tenant is on the expected tier:
const r = await resolver.resolveDetailed(testTenantId);
assert.strictEqual(r.source, "tier");
assert.strictEqual(r.tierId, "pro");
```

## Alternatives considered

- **Emit `ceiling_resolved` RouterInstrumentation event instead.**
  - **Considered.** Async audit + dashboard-friendly.
  - **Cons.** Builds on top of `resolveDetailed`; the method is the foundation. Synchronous access lets operators query attribution without traces.
  - **Decision.** Method now; instrumentation event later.

- **Add `getSourceFor(tenantId)` as a separate method.**
  - **Considered.** Two methods, separable.
  - **Cons.** Two queries for the same fallback walk. Wasteful.
  - **Decision.** One method returning both.

- **Boolean flags (`{ceiling, hasOverride, hasTier}`).**
  - **Considered.** Simple.
  - **Cons.** Operators infer source from boolean combinations. Discriminated union is clearer.
  - **Decision.** Source enum.

- **Always-present `tierId: string | undefined`.**
  - **Considered.** Uniform shape.
  - **Cons.** Operators must check `source === "tier"` + `tierId !== undefined` — redundant. Conditional shape narrows in TypeScript.
  - **Decision.** Conditional `tierId`.

- **Include the row's `updated_at` timestamp in the result.**
  - **Considered.** "When was this policy last changed?"
  - **Cons.** Operator-side dashboards can query `META_LLM_COST_CEILINGS` / `META_LLM_COST_TIERS` directly for audit timestamps. Polluting the resolver result is scope creep.
  - **Decision.** No timestamp. Operators query the tables for that.

- **Add `effectiveAt: number` (the clock time when resolution happened).**
  - **Considered.** Helps with time-of-resolution debugging.
  - **Cons.** Caller already knows when they called resolveDetailed. Not the resolver's concern.
  - **Decision.** No effectiveAt.

- **Return a stronger source type that includes `"global"` (the router-level fallback).**
  - **Considered.** Symmetric with the three-level fallback documentation.
  - **Cons.** The resolver doesn't know about the router-level global config (that's `DefaultLlmRouterOptions.costCeiling`). Returning `"global"` would be a lie — the resolver returns `"none"` and the router picks the global. The router could wrap the resolver and translate `"none"` → `"global"`.
  - **Decision.** `"none"` from the resolver. Operators interpret based on their router's config.

- **Split into `resolveCeiling()` + `resolveSource()` for caller flexibility.**
  - **Considered.** Operators wanting only the source skip the ceiling.
  - **Cons.** Two queries. Operators rarely want just the source.
  - **Decision.** One method, both fields. Cheap and clear.

## Consequences

- **56 packages + 1 app, 127 meta-schema tables, 8,026 tests** (+10 from M6.8.x: all in `cost-ceiling-resolver.test.ts`). All green, zero type errors.
- **Closes ADR-0144 Q2 + ADR-0137 Q3+Q4 + ADR-0141 Q3.** Four deferred questions resolved in one milestone.
- **`resolve()` continues working unchanged.** Existing router wiring (`getTenantCostCeiling: resolver.resolve`) needs no migration.
- **`resolveDetailed()` is the new primary method.** `resolve()` is a convenience projection.
- **Source attribution unblocks audit dashboards.** Tier distribution, override usage, no-policy tenants all visible.
- **TypeScript discriminated union pattern set.** Future resolvers (e.g., latency thresholds, quota limits) can adopt the same `{source, ...}` shape.
- **No schema change.** Pure code addition + query column addition.
- **No new dependencies.** Same `PgConnection` interface.

## Open questions

- **Q1:** Should `DefaultLlmRouter` emit a `ceiling_resolved` RouterInstrumentation event automatically when it resolves a ceiling?
  - _Current direction:_ Yes — additive. Wires resolver.resolveDetailed → onEvent with kind="ceiling_resolved" + tier/override attributes. Future milestone (M6.8.x.trace?).
- **Q2:** Should `CostCeilingResolution` carry the timestamp when the policy row was last updated?
  - _Current direction:_ Operator queries the tables for audit timestamps. Out of scope.
- **Q3:** Should there be a `resolveDetailedForAll(tenantIds[])` batch helper?
  - _Current direction:_ Operator-side iteration. Future helper if dashboards demand it.
- **Q4:** Should `resolve()` be DEPRECATED in favor of `resolveDetailed()`?
  - _Current direction:_ No — `resolve()` is the right shape for the common case (router-level wiring). Two-method coexistence is fine.
- **Q5:** Should the resolver expose `listTiers()` for tier inventory dashboards?
  - _Current direction:_ Operator queries `META_LLM_COST_TIERS` directly. Substrate is the resolver, not a full CRUD surface.
- **Q6:** Should `tierId` validation enforce the tier_id pattern (slug regex)?
  - _Current direction:_ The DB CHECK constraint on `META_LLM_COST_TIERS.tier_id` validates inserts. The resolver trusts the stored value.
- **Q7:** Should there be a `"router_global"` source value when the router falls back from `resolveDetailed → none` to its own global config?
  - _Current direction:_ Router-level concern. The resolver returns `"none"`; the router decides what to do.
- **Q8:** Should the in-memory `InMemoryCostCeilingResolver` (if one exists) mirror this API?
  - _Current direction:_ No in-memory resolver exists in the substrate today. The router's `costCeiling` option IS the in-memory equivalent. If demand exists for unit-testable resolvers, add a `StaticCostCeilingResolver` test double in `@crossengin/ai-router` itself.
