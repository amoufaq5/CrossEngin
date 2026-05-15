# ADR-0030: Edge and latency SLO

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-15 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0010, ADR-0017, ADR-0020, ADR-0031 |

## Context

ADR-0017 defined SLOs in abstract — availability targets, latency budgets, error-budget computation. ADR-0010 defined the multi-region topology. This ADR ties them together at the edge: how traffic gets to the right region, what latency budgets apply per route, how the platform autoscales, what gets cached, what gets throttled, and how affinity is maintained for sessions and writes.

The edge is also a security boundary. Rate limits must be enforceable at the CDN level before requests hit origin. Cache policies must respect PHI/PII handling rules. Region affinity must respect tenant residency profiles.

Five distinct concerns surface:

1. **Routing.** Geo-DNS for EU/US separation; anycast for global static; latency-based for read-only APIs; weighted for canary rollouts; region-pinned for residency-constrained tenants.
2. **Latency budgets per route.** A `/v1/tenants` read may need p99 ≤ 300ms while `/v1/manifests/apply` write may have p99 ≤ 2s. ADR-0017 modeled budgets; this ADR binds them to routes with per-budget alert + paging policy.
3. **Autoscaling.** Per-app, per-region policies that scale on CPU, memory, RPS, p99 latency, queue depth, error rate, concurrent connections. Must prevent flapping (down threshold strictly less than up threshold).
4. **Caching.** Edge CDN, ISR (incremental static regen), API response, image CDN, static asset. Must bypass cached content for authenticated requests by default.
5. **Throttling.** Per-tenant, per-user, per-IP, per-API-key, per-route, global. Multiple algorithms (token bucket, fixed window, sliding window, leaky bucket).

A sixth concern — **region affinity** — covers session stickiness (keep a user pinned to a region for the duration of their session), write-region pinning (writes go to the primary), and round-robin reads across replicas.

## Decision

Edge contract has **six modules** in `@crossengin/edge`:

1. **`routing.ts`.** Five RoutingStrategies (geo_dns, anycast, latency_based, region_pinned, weighted) × 4 RoutingDecisions (primary / failover / blackhole / redirect). Per-rule: source countries + CIDRs, primary regions, failover regions, weights (sum to 100 for weighted strategy), priority. `RoutingTable` enforces no two rules matching the same country at the same priority. `pickRegion()` picks for weighted strategies via deterministic random.

2. **`budgets.ts`.** Per-route latency budgets that bind to `@crossengin/observability`'s `LatencyBudget` + `SloWindow`. p99 >= p95 >= p50 enforced. `pagerOnBreach=true` requires `alertSeverity='critical'`. `evaluateBudget()` returns per-percentile breach results. `BudgetBreachRecord` enforces critical breaches must have alertSent=true; resolvedAt cannot precede observedAt.

3. **`autoscaling.ts`.** Seven ScalingSignals (cpu_pct, memory_pct, rps, p99_latency_ms, queue_depth, error_rate_pct, concurrent_connections) × 4 ScalingDecisions (scale_up / scale_down / hold / throttled) × 6 reasons. `ScalingPolicy` requires scaleDownThreshold strictly less than scaleUpThreshold (flapping prevention) + percentage signals clamped to 0..100. `proposeScalingDecision()` is a deterministic decision tree (cooldown → max-replicas → up → min-replicas → down → hold).

4. **`cache.ts`.** Five CacheKinds (edge_cdn, isr, api_response, image_cdn, static_asset) × 4 key strategies (path_only, path_query, path_query_vary_headers, request_hash) × 3 cache controls (public, private, no_store). Default `bypassAuthenticated=true` to prevent PHI leakage through cache. Edge_cdn requires `cache_control='public'`. `shouldCache()` enforces method (GET/HEAD only) + bypass-header gating.

5. **`throttling.ts`.** Six ThrottleScopes × 4 algorithms × 4 verdicts (allowed / rate_limited / queued / shed). `evaluateThrottle()` decision tree: exempt API key tag → allowed regardless; under limit → allowed; queue has room → queued; queue full + overflowResponse=queue → shed; else → rate_limited. At most one global policy per platform.

6. **`affinity.ts`.** Five AffinityKinds (session_sticky, write_region_pinned, read_replica_round_robin, latency_based, tenant_residency_pinned). session_sticky requires `cookieName` or `sessionHeader`. write_region_pinned requires exactly one candidate region. round_robin requires ≥2 candidates. SameSite=None requires Secure. `resolveAffinity()` deterministic via hash bucketing for round-robin.

Two meta-schema tables (platform-wide): `META_AUTOSCALING_EVENTS`, `META_BUDGET_BREACHES`.

## Alternatives considered

- **Option A:** Single global region + no edge logic.
  - **Pros:** Simplest.
  - **Cons:** Doesn't satisfy residency (ADR-0010). Latency for non-primary-region users is unacceptable.
  - **Why not:** Multi-region is non-negotiable for the buyer market (EU, ME, regulated industries).

- **Option B:** Push all routing to the CDN; no application-layer routing logic.
  - **Pros:** Offloads complexity to vendor.
  - **Cons:** Vendor-specific lock-in; can't model tenant residency at CDN; can't combine with autoscaling decisions.
  - **Why not:** We still need the application-layer rules for residency and tenant-specific routing; CDN handles the geographic baseline.

- **Option C:** Skip the budget→route binding; use observability's SLOs alone.
  - **Pros:** Fewer types.
  - **Cons:** SLOs are aggregate; we need per-route budgets for ops dashboards and alerting precision.
  - **Why not:** Per-route is a different unit of accountability.

- **Option D:** Predictive autoscaling (ML-driven).
  - **Pros:** Smoother scaling.
  - **Cons:** Operationally complex; opaque failure modes.
  - **Why not:** Phase 1 sticks to threshold-based with explicit cooldowns. Predictive is a Phase 3+ addition.

## Consequences

- **Positive.** Operators can reason about routing without reading code. Latency budgets are first-class records, not implicit. Autoscaling is deterministic. Caching is auth-safe by default. Throttling is composable across scopes.
- **Negative.** More types to maintain than a single-region monolith would need. Operators must keep policies up-to-date as workloads evolve.
- **Neutral.** Vendor independence — types describe the contract, not the implementation. Switching from Vercel + Fly to AWS or Cloudflare changes the runtime, not the contract.
- **Reversibility.** Easy to add new routing strategies, cache kinds, scaling signals. Removing established ones requires deprecation grace.

## Implementation notes

- **Observability dependency.** `budgets.ts` imports `LatencyBudgetSchema` and `SloWindowSchema` from `@crossengin/observability` to avoid duplicating those primitive types.
- **Autoscaling cooldown.** Default 60s; per-policy override possible. `proposeScalingDecision` returns `throttled` (not `hold`) when within cooldown — surfaces the reason to operators.
- **Cache bypass headers.** Default includes `Authorization`. Additional bypass headers (per policy) supplied as a list. Case-insensitive comparison.
- **Throttle overflow.** Three options at limit: 429 (immediate reject), 503 (overload), 504 (gateway timeout), or queue (queue with timeout, then shed). Queue requires `queueDepth >= 1` and `queueTimeoutMs > 0`.
- **Affinity for writes.** `write_region_pinned` is mandatory for tenants under `single-region` residency profiles. The kernel enforces residency separately; affinity is for routing optimization, not the residency boundary itself.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Anycast vs unicast for static content — defer to ops | _pending_ | Phase 2 |
| Cost-aware autoscaling (consider per-region pricing) | _pending_ | Phase 3 |
| Predictive autoscaling for known-cyclical workloads | _pending_ | Phase 3+ |
| Rate-limit fair-share across tenants (per-tenant burst vs aggregate) | _pending_ | Phase 2 |

## References

- ADR-0010 (multi-region and data residency)
- ADR-0017 (observability and SLOs)
- ADR-0020 (build, packaging, deployment) for app + environment + region taxonomy.
- `packages/edge/src/` for the zod schemas and helpers.
