# ADR-0157: `ceiling_resolved` RouterInstrumentation event + getTenantCostCeilingDetailed callback (Phase 2 M6.8.x.trace)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0137 (M6.7.x per-tenant cost ceiling), ADR-0141 (M6.7.z RouterInstrumentation), ADR-0144 (M6.8 cost tiers), ADR-0152 (M6.7.z.embed), ADR-0154 (M6.8.x resolveDetailed) |

## Context

ADR-0154 / M6.8.x added `resolveDetailed()` to `PostgresCostCeilingResolver` returning `{ceiling, source, tierId?}`. Operators querying the resolver synchronously now see WHY a ceiling applies (override vs tier vs no-policy). But the router didn't automatically emit a trace event — operators who wanted audit trails of every ceiling resolution had to wrap the resolver themselves.

ADR-0154 Q1:

> Q1: Should `DefaultLlmRouter` emit a `ceiling_resolved` RouterInstrumentation event automatically when it resolves a ceiling?
> _Current direction:_ Yes — additive. Wires `resolver.resolveDetailed` → `onEvent` with `kind="ceiling_resolved"` + tier/override attributes. Future milestone (M6.8.x.trace?).

M6.8.x.trace closes Q1. Operators wanting per-request audit of ceiling resolution can now subscribe to `RouterInstrumentation` and see:

- WHICH policy applied (override / tier / global / none).
- WHICH tier if tier (carries `tierId`).
- The full ceiling object for downstream policy-replication.

This unblocks:
1. **Compliance audit dashboards** answering "did Tenant X get the policy we expected at this exact moment?".
2. **Tier migration verification** in production — confirm pro-tier promotion took effect on the next request.
3. **A/B testing per-tenant overrides** vs platform default.
4. **Forensic reconstruction** of why a particular request was blocked or allowed.

## Decision

Four additive changes:

1. **`ROUTER_INSTRUMENTATION_KINDS` grows 6 → 7** with `ceiling_resolved` at slot 7 (after the six llm/embed event kinds).

2. **New types in `@crossengin/ai-router/cost-tracker.ts`:**
```ts
export type CostCeilingSource = "override" | "tier" | "global" | "none";

export interface CostCeilingResolution {
  readonly ceiling: CostCeiling | undefined;
  readonly source: CostCeilingSource;
  readonly tierId?: string;
}
```

The router-side `CostCeilingSource` is a SUPERSET of the resolver-side enum (which only emits `"override" | "tier" | "none"` — the resolver doesn't know about the router's own `costCeiling` option). The router adds `"global"` when the resolver returns nothing AND the router's own `costCeiling` is set.

3. **New optional callback on `DefaultLlmRouterOptions`:**
```ts
readonly getTenantCostCeilingDetailed?: (
  tenantId: string,
) => Promise<CostCeilingResolution>;
```

Operators wire `PostgresCostCeilingResolver.resolveDetailed` directly here. The router uses it preferentially over the basic `getTenantCostCeiling` callback when both are provided.

4. **`enforceCeilingPreflight` refactored** to call a new private `resolveCeilingDetailed` method, emit `ceiling_resolved` BEFORE the ceiling check, and then enforce the ceiling normally.

### Resolution precedence

The new `resolveCeilingDetailed` private method walks four levels:

```ts
private async resolveCeilingDetailed(tenantId): Promise<CostCeilingResolution> {
  // 1. Detailed callback (highest fidelity): returns "override" | "tier" | "none"
  if (this.getTenantCostCeilingDetailed !== undefined) {
    const detailed = await this.getTenantCostCeilingDetailed(tenantId);
    if (detailed.source !== "none") return detailed;  // override or tier
  } else if (this.getTenantCostCeiling !== undefined) {
    // 2. Basic callback (degraded): collapse to "override"
    const tenantCeiling = await this.getTenantCostCeiling(tenantId);
    if (tenantCeiling !== undefined) {
      return { ceiling: tenantCeiling, source: "override" };
    }
  }
  // 3. Router-level global: from costCeiling option
  if (this.costCeiling !== undefined) {
    return { ceiling: this.costCeiling, source: "global" };
  }
  // 4. Nothing
  return { ceiling: undefined, source: "none" };
}
```

Operators who wire `getTenantCostCeilingDetailed` get full source fidelity (override vs tier distinction). Operators on the legacy basic callback get a degraded `"override"` (the router can't disambiguate without the detailed shape).

### Event shape

```ts
{
  kind: "ceiling_resolved",
  tenantId, sessionId, task, providerId, modelId,
  occurredAt: ISO 8601,
  durationMs: null,
  attributes: {
    source: "override" | "tier" | "global" | "none",
    hasCeiling: boolean,
    ceiling?: CostCeiling,    // present only when hasCeiling = true
    tierId?: string,           // present only when source = "tier"
  },
}
```

- `source` is always present.
- `hasCeiling` is always present.
- `ceiling` is conditionally present (omitted when `source === "none"`).
- `tierId` is conditionally present (only when `source === "tier"`).

### Wire ordering

`ceiling_resolved` emits BEFORE `llm_call_started`:

```
ceiling_resolved → llm_call_started → llm_call_completed
```

This ordering matches `enforceCeilingPreflight`'s logical position at the start of `complete()`. Operators reading event sequences see the policy decision before the LLM call begins.

### CHECK constraint extension

`META_LLM_CALL_TRACES.kind` CHECK constraint extended additively:

```sql
kind IN (
  'llm_call_started', 'llm_call_completed', 'llm_call_failed',
  'embed_call_started', 'embed_call_completed', 'embed_call_failed',
  'ceiling_resolved'   -- NEW
)
```

No data migration needed for pre-existing rows (still in the 6 prior kinds).

## Cross-cutting invariants enforced

- **Additive: existing 6 kinds preserved.** The new kind is opt-in via instrumentation subscription.
- **Fires ALWAYS, even when source='none'.** Operators auditing "did the router check a ceiling?" want a positive signal for the no-policy case.
- **Fires BEFORE ceiling enforcement.** If the check throws `CostCeilingExceededError`, the `ceiling_resolved` event already emitted — operators see the policy that blocked the request.
- **Detailed callback takes precedence.** When both `getTenantCostCeiling` and `getTenantCostCeilingDetailed` are wired, the detailed one wins.
- **Detailed callback returning source='none' falls back to global.** Operators wiring a detailed resolver that signals "I have nothing" still get the router's own `costCeiling` if set.
- **`tierId` is conditionally present.** Only on `source === "tier"`. TypeScript discriminated union pattern.
- **Same `RouterInstrumentationEvent` shape.** Only the `kind` discriminator + attribute keys are new.
- **`PostgresRouterInstrumentation` handles transparently.** The CHECK constraint extension is the only PG-side change.
- **No breaking change.** Existing callers continue working (no instrumentation, basic resolver-callback, or no resolver-callback).

## End-to-end semantic

```ts
import { DefaultLlmRouter, captureRouterInstrumentation } from "@crossengin/ai-router";
import {
  PostgresCostCeilingResolver,
  PostgresRouterInstrumentation,
} from "@crossengin/ai-router-pg";

const resolver = new PostgresCostCeilingResolver({ conn });
const router = new DefaultLlmRouter({
  ...,
  costCeiling: { maxUsdPerRequest: 5.0 },  // platform-wide fallback
  getTenantCostCeilingDetailed: resolver.resolveDetailed,
  instrumentation: new PostgresRouterInstrumentation({ conn }),
});

// On every request:
for await (const chunk of router.complete(req)) { ... }

// PG side sees a row like:
// {
//   kind: "ceiling_resolved",
//   tenant_id: "tenant-a",
//   provider_id: "anthropic",
//   model_id: "claude-sonnet-4-6",
//   task: "executor",
//   occurred_at: 2026-05-20T14:30:00Z,
//   attributes: { source: "tier", hasCeiling: true, tierId: "pro", ceiling: { maxUsdPerRequest: 5.0 } }
// }

// Audit dashboards now have queries like:
// 1. Source distribution across tenants:
//   SELECT attributes->>'source' AS source, COUNT(*) FROM meta.llm_call_traces
//   WHERE kind = 'ceiling_resolved' AND occurred_at > now() - INTERVAL '1 day'
//   GROUP BY source;
//
// 2. Tier migration verification (did tenant X move to pro this hour?):
//   SELECT attributes->>'tierId' AS tier, COUNT(*) FROM meta.llm_call_traces
//   WHERE kind = 'ceiling_resolved' AND tenant_id = $1
//     AND occurred_at > now() - INTERVAL '1 hour'
//   GROUP BY tier;
//
// 3. "Why was this request blocked?" — last ceiling for failed requests:
//   SELECT t1.attributes AS resolved, t2.attributes AS failed
//   FROM meta.llm_call_traces t1
//   JOIN meta.llm_call_traces t2
//     ON t2.session_id = t1.session_id
//    AND t2.occurred_at > t1.occurred_at
//    AND t2.occurred_at < t1.occurred_at + INTERVAL '1 second'
//   WHERE t1.kind = 'ceiling_resolved'
//     AND t2.kind = 'llm_call_failed'
//     AND t2.attributes->>'errorKind' = 'cost_ceiling_exceeded';
```

## Alternatives considered

- **Carry source attribution as a new field on `llm_call_started`** (not a separate event).
  - **Considered.** Half the events.
  - **Cons.** Couples ceiling resolution to LLM-call start. Future scenarios (e.g., ceiling resolved for a request that's then short-circuited before any LLM call) couldn't surface the resolution. Separate event = clean separation of concerns.
  - **Decision.** Separate `ceiling_resolved` event.

- **Emit only when source !== 'none'** (skip the no-policy case).
  - **Considered.** Less event noise.
  - **Cons.** Operators auditing "was a ceiling check performed?" can't distinguish "no event" from "instrumentation broken". Always emitting gives a positive "checked-and-found-nothing" signal.
  - **Decision.** Always emit.

- **Make `getTenantCostCeilingDetailed` REPLACE `getTenantCostCeiling`** (breaking change).
  - **Considered.** Cleaner API surface.
  - **Cons.** Breaks existing M6.7.x callers. Two coexisting callbacks with documented precedence is non-breaking + lets operators migrate gradually.
  - **Decision.** Both callbacks. Detailed wins when both wired.

- **Emit AFTER the ceiling check (after `checkCeiling` returns).**
  - **Considered.** Operators see the check outcome in the same event.
  - **Cons.** If the check throws `CostCeilingExceededError`, the event never fires. Operators lose the resolution-source signal precisely when they need it most (debugging blocked requests). Emit-before guarantees the audit signal regardless of enforcement outcome.
  - **Decision.** Before.

- **Include the `check` result (allowed / blocked + currentWindowUsd) in the `ceiling_resolved` event.**
  - **Considered.** One-stop audit signal.
  - **Cons.** Mixes resolution with enforcement. If the check throws BEFORE the event would emit, we lose the resolution context. Two separate concerns deserve two separate event timings. Operators wanting both correlate `ceiling_resolved` with downstream `llm_call_failed` via session_id.
  - **Decision.** Resolution only.

- **Track `effectiveAt: number` (clock-snapshot of when resolution happened).**
  - **Considered.** Useful for clock-skew debugging.
  - **Cons.** `occurredAt` already carries this. Operators parse the ISO string to a timestamp.
  - **Decision.** No extra field.

- **Emit `ceiling_resolved` for `embed()` too.**
  - **Considered.** Embed cost matters.
  - **Cons.** `embed()` doesn't currently call `enforceCeilingPreflight`. Adding ceiling enforcement to embed is a separate milestone. M6.8.x.trace stays scoped to complete().
  - **Decision.** Complete-only.

- **Single-method `resolveCeilingWithSource` (no separate `resolveCeiling`).**
  - **Considered.** One private method.
  - **Cons.** The two methods are conceptually distinct: `resolveCeiling` returns just the ceiling; `resolveCeilingDetailed` returns the resolution. Some code paths want just the ceiling without the source overhead. Two methods is clearer.
  - **Decision.** Refactored `enforceCeilingPreflight` to use the detailed version internally; the public/private split could be adjusted later if simplification is warranted.

## Consequences

- **56 packages + 1 app, 128 meta-schema tables, 8,054 tests** (+12 from M6.8.x.trace: all in `router.test.ts`). All green, zero type errors.
- **Closes ADR-0154 Q1.**
- **`ROUTER_INSTRUMENTATION_KINDS` grows 6 → 7.**
- **META_LLM_CALL_TRACES.kind CHECK constraint extended additively.** No migration.
- **Audit dashboards unblocked.** Source distribution, tier migration verification, forensic reconstruction of blocked requests.
- **No breaking change.** Existing callers (no instrumentation, basic callback only, no callback) work identically. New behavior is opt-in via subscription.
- **`PostgresCostCeilingResolver.resolveDetailed` is now first-class operator wiring.** Drop-in for `getTenantCostCeilingDetailed`.
- **Event shape uses TypeScript discriminated union pattern.** `tierId` narrows on `source === "tier"`; `ceiling` narrows on `hasCeiling === true`.

## Open questions

- **Q1:** Should `embed()` also call `enforceCeilingPreflight` (and thereby emit `ceiling_resolved`)?
  - _Current direction:_ Yes eventually — embed has cost too. Separate milestone for the enforcement wiring.
- **Q2:** Should `ceiling_resolved` also fire for `completeAggregate` (which today doesn't go through the preflight twice)?
  - _Current direction:_ `completeAggregate` delegates to `complete()` internally — same preflight runs once. No double-emit.
- **Q3:** Should `getTenantCostCeilingDetailed` be deprecated in favor of an integrated `getTenantCostCeiling` that returns `CostCeilingResolution`?
  - _Current direction:_ Backward-compat (legacy callback continues working) > shape unification. Defer.
- **Q4:** Should `ceiling_resolved` carry the result of `checkCeiling` (allowed + currentWindowUsd) as additional attributes?
  - _Current direction:_ No — separates resolution from enforcement. If operators want both, they correlate via session_id + occurredAt.
- **Q5:** Should there be a `costCeilingExceeded` event kind for forensic clarity?
  - _Current direction:_ `llm_call_failed` already carries `errorKind: "cost_ceiling_exceeded"`. No new kind needed.
- **Q6:** Should `getTenantCostCeilingDetailed` be allowed to return `undefined` (signaling "no opinion, use basic callback")?
  - _Current direction:_ Currently it must return `CostCeilingResolution` always (with `source="none"` for "nothing"). If real-world need arises, additive change.
- **Q7:** Should the router maintain per-tenant cache of resolution results (avoid re-resolving on every request)?
  - _Current direction:_ Operator wrap. Substrate stays stateless.
- **Q8:** Should the resolution emit include the resolution latency (ms)?
  - _Current direction:_ `durationMs: null` today. If PG resolver round-trips become a bottleneck and operators want to monitor, additive enhancement.
