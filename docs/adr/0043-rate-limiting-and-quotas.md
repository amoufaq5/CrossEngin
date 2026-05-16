# ADR-0043: Rate limiting and quotas

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-16 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0011 (integration mesh), ADR-0017 (observability/SLOs), ADR-0021 (billing/metering), ADR-0027 (developer SDK), ADR-0030 (edge), ADR-0033 (cost attribution), ADR-0037 (incident response), ADR-0039 (notifications) |

## Context

Rate limiting and quotas appear in five packages already, each with its own bespoke implementation:

- `@crossengin/edge` has route-level throttling per region.
- `@crossengin/sdk` has client-side idempotency replay windows.
- `@crossengin/integrations` has retry policies and circuit breaking.
- `@crossengin/billing` has metered usage tracking.
- `@crossengin/notifications` has per-recipient rate limits.

Each one is correct for its narrow use case, but the duplication has costs: five definitions of "token bucket", five 429-response shapes, five exemption stories, no shared audit of who-got-throttled-when. When a tenant hits API limits, "why?" requires grepping five packages. When a customer-facing buyer asks "what are your rate limits?" the answer is "depends on which endpoint."

There's also a missing piece: **quotas as a longer-horizon control**. Rate limits answer "how fast can you go right now?" Quotas answer "how much can you do this month?" The two concerns are coupled (a 429 from a per-second token bucket vs a 429 from a monthly api_requests cap should be distinguishable to the client), but currently we don't model either consistently.

This ADR establishes the unified contract for:
- **Rate-limit algorithms** (token bucket, leaky bucket, fixed/sliding window, sliding log, concurrent requests).
- **Scope resolution** (per-tenant, per-principal, per-route, composite).
- **Policies** that compose algorithm + scope + overage handling + RFC-9457 problem-details response.
- **Quotas** for longer-horizon metered targets (api_requests, ai_tokens, storage_bytes, etc).
- **Decisions** as auditable records with retry-after + rate-limit headers.
- **Exceptions** for time-bounded uplifts (burst events, incident response, load tests).
- **Throttle events** for alerting + incident escalation.

It does **not** include the actual limiter runtime, Redis/Postgres state stores, distributed coordination, or the policy hot-reload mechanism — those are Phase 2 build artifacts.

## Decision

Rate-limiting contract has **seven modules** in `@crossengin/rate-limiting`:

1. **`algorithms.ts`.** Six algorithms (token_bucket, leaky_bucket, fixed_window, sliding_window, sliding_window_log, concurrent_request) with `ALGORITHM_SUPPORTS_BURST` and `ALGORITHM_IS_RECOMMENDED_FOR_DISTRIBUTED` partition sets. `AlgorithmParamsSchema` is a discriminated union with per-algorithm config (token_bucket has capacity + refillTokensPerSecond + burstAllowance; sliding_window has windowSeconds + maxRequestsPerWindow + precisionSeconds; etc) — and a cross-cutting refinement enforces `burstAllowance ≤ capacity`. Pure evaluators ship for each algorithm: `evaluateTokenBucket` returns `{ allowed, newState, tokensAfter, waitSecondsForCost }` so the caller knows exactly how long to wait. `evaluateFixedWindow` aligns to the wall-clock boundary via `computeFixedWindowStart`. `evaluateSlidingWindow` sums bucketed samples in the lookback window. `evaluateConcurrentRequest` is the simplest — slots available.

2. **`scopes.ts`.** Ten scope kinds (per_tenant, per_principal, per_api_key, per_ip, per_route, per_oauth_client, per_tenant_route, per_tenant_principal, global, composite) with `SCOPES_REQUIRING_TENANT` / `SCOPES_REQUIRING_PRINCIPAL` / `SCOPES_REQUIRING_ROUTE` partition sets. `ScopeSpec` enforces: composite needs ≥ 2 unique components; composite cannot nest; route-requiring kinds need a `routePattern`. `computeRateLimitKey(spec, inputs)` returns a stable deterministic string (e.g., `tenant:abc|principal:def|salt:experiment-a`) or null when required inputs are missing — the key feeds the state store directly. `requiredInputsFor(spec)` lets callers up-front know which inputs they must collect. `matchesRoutePattern` handles exact match + `*` suffix wildcard + `:param` path-parameter syntax — the common cases without dragging in a path-to-regexp dep.

3. **`policies.ts`.** Five-state policy lifecycle (draft → active → paused → deprecated → retired) with `POLICY_TRANSITIONS` map. Five overage handling kinds (hard_block, soft_throttle_delay, queue_and_serve, allow_with_overage_billing, allow_with_warning). Four priority overrides (none, critical_only, high_and_above, elevated_principals). `RateLimitPolicy` enforces: algorithm matches algorithmParams.kind; soft_throttle_delay requires non-zero softThrottleDelayMsPerOverage; queue_and_serve requires non-zero queueMaxWaitMs; response code restricted to 429 or 503; active status requires four-eyes (activatedBy ≠ createdBy); routes cannot be in both enabled and excluded lists. Helpers: `isRouteSubjectToPolicy`, `isPrincipalExempt`, `isApiKeyExempt` are pure pre-filters before the algorithm runs.

4. **`quotas.ts`.** Longer-horizon metering. Seven periods (minute, hour, day, week, month, billing_period, lifetime) with `PERIOD_SECONDS` map. Six quota classes (free_tier, starter, pro, enterprise, internal, custom). Ten quota targets (api_requests, ai_tokens, storage_bytes, compute_seconds, notification_dispatches, search_queries, report_runs, ml_training_minutes, webhook_deliveries, rows_exported). `QuotaDefinition` enforces softLimit < hardLimit; overageAllowed requires overageUnitPriceCents; free_tier cannot allow overage; lifetime period only valid for cumulative targets. `QuotaUsage` enforces lifetime needs null periodEndAt (no rollover); non-lifetime requires periodEndAt; hardLimitBreachedAt cannot precede softLimitBreachedAt. `computePeriodStart` aligns to the wall-clock boundary (or honors `billingCycleStartAt` for billing_period). `evaluateQuota` returns one of `within_soft_limit / soft_limit_exceeded / overage_billable / hard_limit_blocked` — the dispatcher routes to billing or 429 based on the outcome.

5. **`decisions.ts`.** Ten outcomes partitioned into `ALLOWED_OUTCOMES` (allowed, allowed_with_warning, throttled_soft_delayed, bypassed_critical_priority, bypassed_exempt_principal) and `DENIED_OUTCOMES` (denied_rate_limit_exceeded, denied_quota_exceeded, denied_concurrent_limit, denied_global_limit, denied_circuit_open). `ProblemDetailsSchema` mirrors RFC 9457 with rate-limit-specific extensions (rateLimitPolicy, rateLimitScope). `RateLimitHeadersSchema` matches IETF draft (X-RateLimit-Limit/Remaining/Reset). `RateLimitDecision` enforces: denied outcomes require retryAfterSeconds + remainingAfter=0 + problemDetails; problemDetails.status restricted to 429/503; throttled_soft_delayed requires non-zero softThrottleDelayMs; bypass outcomes require bypassReason. The integration point is `aggregateDecisions(decisions[])` → `{ totalDecisions, allowedCount, deniedCount, bypassedCount, throttledCount, denialRate, outcomeCounts }` for observability.

6. **`exceptions.ts`.** Time-bounded uplifts. Six kinds (principal_overage, tenant_burst_allowance, scheduled_event_uplift, compliance_override, incident_response_bypass, load_test_temporary) with `MAX_EXCEPTION_DURATION_HOURS` cap map (incident_response_bypass=24h, load_test_temporary=8h, vendor_support=72h, compliance_override=90d, etc — the strictest caps gate the most dangerous bypasses). Six statuses (requested → approved → active → expired / revoked_early; rejected terminal). `RateLimitException` enforces: requested duration ≤ kind cap; four-eyes (approvedBy ≠ requestedBy); incident_response_bypass requires relatedIncidentId; multiplier < 1 needs additiveBurst > 0 (otherwise it tightens — meaningless for an "exception"). `applyException(baseLimit, exception)` returns `floor(base × multiplier) + additiveBurst`. `findActiveException` is the pre-decision lookup for the runtime.

7. **`events.ts`.** Ten throttle event kinds (hard_limit_hit, soft_limit_hit, burst_consumed, quota_period_reset, policy_activated/deactivated, exception_approved/expired, circuit_opened/closed) with `ALERT_WORTHY_EVENT_KINDS` set (hard_limit_hit, circuit_opened, exception_approved). `ThrottleEvent` enforces: actor user or system; kind-specific FK columns (exception_approved needs exceptionId, policy_activated needs policyId, etc); incidentDeclared=true requires relatedIncidentId. `aggregateThrottleEvents` returns `{ totalEvents, kindCounts, alertWorthyCount, incidentsDeclared, notificationsDispatched, windowStart/End }` for dashboards. `groupEventsByKind` is the deterministic grouper for paginated views.

Six meta-schema tables wired into kernel:

- **META_RATE_LIMIT_POLICIES** — nullable tenant_id (platform policies) with custom RLS. Response code check restricts to 429/503.
- **META_QUOTA_DEFINITIONS** — nullable tenant_id with custom RLS. Target + period + class enums.
- **META_QUOTA_USAGE** — RLS tenant-scoped. RESTRICT FK to quota_definitions. Unique on (tenant_id, quota_definition_id, period_start_at) — one row per quota per period.
- **META_RATE_LIMIT_DECISIONS** — nullable tenant_id with custom RLS. RESTRICT FK to policies + quota_definitions (preserve audit through definition retirement). INET-style scope_key TEXT (deliberately not parsed at DDL level).
- **META_RATE_LIMIT_EXCEPTIONS** — nullable tenant_id with custom RLS. RESTRICT FK to policies. Multiplier as NUMERIC(8,4) for sub-percent precision. Four-eyes FK indexes (requested_by, approved_by, rejected_by, revoked_early_by).
- **META_THROTTLE_EVENTS** — nullable tenant_id with custom RLS. 10-kind check, INET actor_principal_id FK.

## Alternatives considered

- **Option A:** Embed rate-limiting as a sub-module inside `@crossengin/edge`.
  - **Pros:** Co-locates with HTTP routing.
  - **Cons:** Background workers, the SDK client side, integration retries, and notifications all need rate limits and don't go through edge.
  - **Why not:** Rate limiting is cross-cutting, not edge-specific.

- **Option B:** Single "leaky bucket fits all" algorithm.
  - **Pros:** Simpler.
  - **Cons:** Leaky bucket can't model burst (which token_bucket does naturally). Fixed window has cliff effects at boundaries that sliding_window avoids. Different use cases benefit from different algorithms; the contract should let each policy pick.
  - **Why not:** The six-algorithm menu lets each policy use the right tool.

- **Option C:** Defer quotas to `@crossengin/billing`.
  - **Pros:** Tighter billing integration.
  - **Cons:** Quotas exist for free-tier users too (no billing). Tight coupling would force every quota check through billing's call path.
  - **Why not:** Quotas are a rate-limiting concept (with optional billing handoff for overage), not the inverse.

- **Option D:** Use a generic key-value store interface; let the runtime decide the algorithm.
  - **Pros:** Algorithm-agnostic contract.
  - **Cons:** Loses static checking on algorithm-specific params (capacity, refillRate, etc). zod discriminatedUnion catches mismatches at validation time.
  - **Why not:** Per-algorithm typed params are the whole point of the contract.

- **Option E:** Skip exceptions; require every exception to be a new policy.
  - **Pros:** Smaller surface.
  - **Cons:** Burst events ("Black Friday traffic 2x for 7 days") need a time-bounded uplift, not a permanent policy change. Without exceptions, the audit trail of "who allowed this bypass and why" gets buried in policy version history.
  - **Why not:** Exceptions are explicitly auditable, time-bounded, and four-eyes-gated — that's the value.

- **Option F:** Make problem details optional on denied outcomes.
  - **Pros:** Simpler.
  - **Cons:** Customers ask "what does a 429 from your API look like?" and the answer needs to be RFC 9457-compliant problem details with retry-after — every time. Schema-level enforcement ensures the runtime can't ship inconsistent error shapes.
  - **Why not:** Consistent 429 shape is a buyer-facing contract.

## Consequences

- **One vocabulary across packages.** Notifications, edge, SDK, integrations, and billing all consume the same `RateLimitDecision` / `QuotaUsage` / `ThrottleEvent` types. A single observability dashboard answers "what's getting throttled?" across the platform.
- **Algorithm-specific params get static checking.** Misconfigured policies (capacity 0 on a token bucket, soft_throttle_delay with 0ms delay) fail validation before deployment.
- **Four-eyes on exceptions.** No single person can grant a quota bypass; approvedBy must differ from requestedBy.
- **Incident-response integration.** `incident_response_bypass` exceptions require linked `relatedIncidentId` — the audit chains back to the incident-response package.
- **RFC 9457 + IETF rate-limit headers everywhere.** Every denial includes problem details + retry-after, by schema validation.
- **Quotas + overage routes cleanly to billing.** `overage_billable` outcome from `evaluateQuota` is the explicit handoff point.

## Open questions

- **Q1:** Distributed coordination — is the contract Redis-friendly?
  - _Current direction:_ Algorithm evaluators are pure functions taking state + producing new state. A Phase 2 distributed runtime can replicate state via Redis, Postgres advisory locks, or any CAS primitive. `ALGORITHM_IS_RECOMMENDED_FOR_DISTRIBUTED` flags which kinds are robust under eventual consistency (token_bucket, sliding_window, fixed_window) vs which are not (leaky_bucket needs single-leader, concurrent_request needs strict consensus).
- **Q2:** Per-AI-call cost weighting (1 token-heavy AI call ≠ 1 cheap API call) — model as `costUnits` on decisions?
  - _Current direction:_ Yes; `RateLimitDecision.costUnits` defaults to 1 but the caller can pass higher values for expensive operations. `evaluateTokenBucket(... cost: 10)` reserves 10 tokens. AI providers and ML training services use this for token-bucket policies on AI APIs.
- **Q3:** Multi-window policies (e.g., "10/sec AND 1000/hour AND 10000/day")?
  - _Current direction:_ Out of scope for v1. Each policy is single-window. Multi-window is a stack of three policies evaluated sequentially. If demand justifies, a future ADR can introduce `MultiWindowPolicy` as a composite.
- **Q4:** Sticky throttling (once a principal hits a limit, throttle them for an extra penalty window)?
  - _Current direction:_ Captured via `throttled_soft_delayed` + `softThrottleDelayMs`. The runtime can apply progressive delays per offender via the same outcome.

## References

- **RFC 9457** — Problem Details for HTTP APIs
- **RFC 9110 §15.5.6** — 429 Too Many Requests
- **IETF Rate-Limit Headers Draft** — X-RateLimit-Limit / Remaining / Reset
- **Token Bucket** — Tanenbaum & Wetherall, Computer Networks
- **Leaky Bucket** — Turner (1986)
- **Sliding Window Log** — Kleppmann, Designing Data-Intensive Applications
- ADR-0011, ADR-0017, ADR-0021, ADR-0027, ADR-0030, ADR-0033, ADR-0037, ADR-0039
