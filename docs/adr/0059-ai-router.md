# ADR-0059: AI provider router (Phase 2 M6.5)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-17 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0006 (LLM provider router), ADR-0053 (Anthropic provider), ADR-0027 (developer SDK) |

## Context

`@crossengin/ai-providers` defines the `LlmRouter` interface — `complete()` + `completeAggregate()` + `embed()` + `resolveProvider()` — and the `RouterConfig` shape with `providers` (Map), `taskPolicies`, `getTenantResidency`, optional `getTenantOverrides`. M2.7 ships a real `AnthropicProvider`. M5.6 + M5.7 + M5.8 build the architect-cli chat substrate. What's missing is the implementation between the consumer (chat, future apps) and the providers: the router that picks a provider per task, retries on transient failures, falls back to the next provider when one is exhausted, and enforces per-tenant cost ceilings.

Three constraints shaped the design:

1. **Provider-agnostic.** Today only Anthropic ships (M2.7). M2.8 will add OpenAI. The router must accept any `LlmProvider` and route by ID — no Anthropic-specific code paths. The retry-on-`isRetryable()` pattern from `AnthropicError` should generalize to any provider that adds the same shape.

2. **Cost ceilings are enforced at the boundary.** A tenant's `costCeiling` (per-request + per-window) is checked before the provider is called, not after. Once an LLM call starts, the tokens are billed; the router has to prevent the call when the budget says no. Pre-flight estimate is rough (input chars / 4 + maxTokens) but errs on the conservative side.

3. **In-memory by default; pluggable for production.** The router ships an `InMemoryCostTracker` and `InMemoryLatencyTracker` so a developer can use the router without a database. Production deployments inject `PostgresCostTracker` (a future M6.6) that survives process restarts and aggregates across worker processes.

## Decision

`@crossengin/ai-router` exports **6 modules** plus an index:

### `retry.ts` — exponential backoff with isRetryable check

- `RetryPolicy = {maxAttempts, initialDelayMs, maxDelayMs, jitter}`. `DEFAULT_RETRY_POLICY = {3, 1000, 15000, true}`.
- `RetryableError` structural type: any object with `isRetryable(): boolean`. The Anthropic provider's `AnthropicError` already satisfies this. Future providers add the same method.
- `isRetryableError(err)` type guard — checks the shape.
- `computeBackoffMs(attempt, opts)` — exponential (`initialDelayMs * 2^attempt`), capped at `maxDelayMs`. With jitter, multiplies by `0.5 + 0.5 * random()` so two clients don't synchronize.
- `withRetry(fn, opts)` — calls `fn(attempt)` up to `policy.maxAttempts` times. Retries only on errors that pass `isRetryableError`. Throws the original error type (preserves the stack) when retries are exhausted.

### `cost-tracker.ts` — per-tenant cost ceiling

- `CostCeiling = {maxUsdPerRequest?, maxUsdPerWindow?, windowSeconds?}`. Either / both / neither limit can be set.
- `CostTracker` interface: `getWindow(tenantId)`, `recordUsage({tenantId, costUsd})`, `checkCeiling({tenantId, estimatedCostUsd, ceiling})`.
- `InMemoryCostTracker`: per-tenant rolling window (default 86,400 s = 24 h). Records accumulate within a window; first usage past expiry starts a fresh window.
- `CostCeilingExceededError` — non-retryable (`isRetryable()` returns false) so the router doesn't try to retry through a cost block. Carries the `CostCeilingCheck` so callers can format a friendly error.

### `latency-tracker.ts` — rolling-window p50/p95

- `LatencyTracker` interface: `record({providerId, latencyMs, success})`, `stats(providerId)`.
- `InMemoryLatencyTracker` with default window size 100 samples. Maintains a per-provider FIFO buffer. `stats()` returns `{samples, successes, failures, p50Ms, p95Ms}`.
- Used by the router for observability and by future latency-based routing (M6.6). Not yet consulted during provider selection — that's a follow-up.

### `resolve.ts` — pure provider-resolution logic

- `parseProviderRef(ref)` — splits `"anthropic/claude-sonnet-4-6"` into `{providerId, modelId}`. Bare `"anthropic"` returns `modelId: null` (provider's default model).
- `residencyAllowsProvider(residency, provider)` — `unrestricted` always allows; `eu-only` / `us-only` / `me-only` require the provider's `residency` array to contain the matching region.
- `effectivePolicy(input)` — overrides win over base policies.
- `chainFromPolicy(policy)` — `[primary, ...fallback]`.
- `resolveProviders(input)` — walks the chain, skips unknown providers and residency-blocked providers, yields a sorted list of `ResolvedProviderChoice` (with `providerId`, `provider`, `modelId`, `reason`). Throws `ProviderResolutionError` (non-retryable) if nothing matches.

### `router.ts` — `DefaultLlmRouter implements LlmRouter`

Constructor takes `RouterConfig` + `retry?`, `costCeiling?`, `costTracker?`, `latencyTracker?`, `clock?`.

- **`resolveProvider(task, tenantId)`** — calls `resolveProviders` and returns the first choice as a `ResolvedProvider` envelope (matches the `@crossengin/ai-providers` interface).

- **`complete(req)`** — the orchestration heart:
  1. Resolve the chain (residency + overrides applied).
  2. Pre-flight cost-ceiling check against `costTracker` using a rough cost estimate (`(input chars / 4 * inputPrice + maxTokens * outputPrice) / 1M`). Throws `CostCeilingExceededError` if blocked.
  3. For each choice: call `provider.complete()` inside `withRetry`. Buffer chunks into an array so we can replay them only if the *whole* attempt succeeds (no half-streamed responses leaking when retries fire mid-stream).
  4. Track latency on every attempt; record usage cost on success.
  5. On retryable failure: try the next choice. On non-retryable failure: propagate immediately. On all-exhausted: throw `AllProvidersExhaustedError` with the per-attempt history.

- **`completeAggregate(req)`** — consumes the stream, packs `text` (joined) + `toolCalls` (with assembled JSON inputs) + `usage` into a `NormalizedCompletion`. Throws if the stream ends without a `usage_final` chunk.

- **`embed(req)`** — same fallback chain, but no retry / latency tracking (embedding requests are typically small + idempotent; producers retry at the call site). The first non-`isRetryable` failure terminates.

### `index.ts` — re-exports

## Cross-cutting invariants enforced

- **Cost ceilings are checked once, before the call.** A pre-flight estimate runs before any provider work. Once the stream begins, the actual cost is what it is. The ceiling is a guardrail, not a hard cap on already-spent dollars.
- **Stream buffering on retry.** Chunks accumulate in an array; only on the FIRST successful attempt for a choice are they yielded to the caller. If the stream fails mid-way and retries succeed, the caller sees one clean stream, not interleaved partials.
- **Retries respect `isRetryable()`.** The router never retries through a `CostCeilingExceededError`, `ProviderResolutionError`, or `AllProvidersExhaustedError` — all three explicitly return `false` from `isRetryable()`. Only provider-domain errors (rate limit, network, timeout, overloaded) trigger backoff.
- **Latency is recorded on every attempt, success or failure.** The tracker sees `success: false` rows too, so a provider's failure rate is visible in the window stats. M6.6's latency-based routing will weight by these stats.
- **Cost is recorded only on success.** Failed attempts that returned tokens (extremely unusual; would be a provider bug) don't count. The `usage_final.cost` field is the canonical figure — the pre-flight estimate is replaced by the real number when the stream completes.
- **Provider chain is deterministic.** Same `(task, tenantId, residency, overrides)` always yields the same chain in the same order. Tests use `clock: () => 0` and `jitter: false` for reproducibility.

## Alternatives considered

- **Use the router class from `@crossengin/ai-providers` directly.**
  - **Pros.** One package.
  - **Cons.** That package is contract-only (zod schemas + interfaces). Adding orchestration there breaks the "contracts vs runtime" separation the rest of the codebase follows (kernel + kernel-pg, workflow-runtime + workflow-runtime-pg, ai-architect + ai-architect-pg).
  - **Decision.** Separate package. `@crossengin/ai-providers` keeps its contract role; `@crossengin/ai-router` is the runtime adapter.

- **Use a real concurrency-limited circuit breaker (e.g., opossum).**
  - **Considered.** Half-open state, error-rate threshold, timed reset.
  - **Decision.** Out of scope for M6.5. The retry-with-isRetryable model covers the common case. Circuit-breaker semantics can layer on top in M6.7 (provider health gate) if persistent failures become a problem.

- **Make `costCeiling` a per-tenant setting fetched at request time.**
  - **Considered.** `getTenantCostCeiling(tenantId)` callback.
  - **Decision.** Router-level ceiling for the MVP. Per-tenant ceilings are a deployment-time concern (the router config is constructed per-tenant or per-tier). M6.7 can add `getTenantCostCeiling` once tenant settings live in a real database.

- **Pre-flight cost estimate using actual tokenization.**
  - **Considered.** Run BPE or tiktoken on the message content.
  - **Decision.** Out of scope. The 4-chars-per-token heuristic is conservative for English; under-estimating means a request that *should* be blocked still goes through. Phase 3 ships a per-provider tokenizer for accurate estimates.

- **Buffer chunks per *attempt*, replay on success per provider.**
  - **Considered.** Replays whatever streamed before the failure.
  - **Decision.** Buffer per *attempt* and replay only on full success. Partial streams from a failed attempt are discarded. The caller sees one clean stream end-to-end.

- **Use AbortController to cancel in-flight streams when a retryable failure happens.**
  - **Considered.** Cleaner resource lifecycle.
  - **Decision.** Out of scope for M6.5. The fetch-based `AnthropicProvider` already terminates when the iterator is dropped. M2.7.5 can add explicit AbortController plumbing.

- **Allow a provider in the chain to be specified as `"anthropic/*"` for "any model".**
  - **Considered.** Wildcards.
  - **Decision.** `parseProviderRef` returns `modelId: null` for bare provider names, which the resolver maps to `provider.models[0]` (the default). That covers the "any" case without wildcards.

- **Compute the cost ceiling check inside `withRetry`, so each retry re-checks.**
  - **Considered.** Catches edge cases where a concurrent request burned the budget while the first attempt was in flight.
  - **Decision.** Single check at the top of `complete()`. The window is fine-grained enough (per-request usage records) that concurrent burn is unlikely to slip through; if it does, the next call blocks. Re-checking per attempt would make a 3-retry call require 3 cost lookups, which is wasteful.

## Consequences

- **51 packages + 1 app, 119 meta-schema tables, 5,768 tests** (was 50 / 119 / 5,717; +1 package, +51 tests, 0 new META_ tables).
- **The chat substrate gets a real router.** `architect-cli` can swap its direct `AnthropicProvider` construction for a `DefaultLlmRouter` once M2.8 (OpenAI) lands — the consumer-facing surface is identical (`LlmProvider`-shaped). For M6.5 alone, the router shines when configured with multiple Claude models (haiku-4-5 for cheap tasks, opus-4-7 for hard ones) via task policies.
- **Cost guardrails are now usable.** Operators set `costCeiling: {maxUsdPerWindow: 10, windowSeconds: 86400}` to cap a tenant at $10/day. The router refuses calls past the cap with a typed error a UI layer can render.
- **Pattern set for future trackers.** `PostgresCostTracker` (M6.6) implements the same `CostTracker` interface against `meta.architect_sessions` rolled-up usage. Same for `PostgresLatencyTracker` if needed.
- **No regression risk to existing chat.** `architect-cli` doesn't depend on `@crossengin/ai-router` yet — chat keeps constructing `AnthropicProvider` directly. Adoption is a future milestone (M6.5.5 — "wire router into architect-cli").
- **Two minor `@crossengin/ai-providers` improvements surfaced.** The contract package's `LlmRouter` interface doesn't include the cost-ceiling / retry / latency contracts the implementation needs — those got added in `ai-router` instead. M6.6 may want to lift these back into the contract package once the OpenAI provider is in place and the second router consumer arrives.

## Open questions

- **Q1:** Should the router record per-attempt history into a META_ table (similar to `META_ARCHITECT_PROPOSALS`)?
  - _Current direction:_ Defer to M6.6. `RouterAttempt` records exist in-process; they show up in `AllProvidersExhaustedError`. Operators who want long-term metrics wire a `PostgresLatencyTracker` that materializes attempts.
- **Q2:** How does the router handle tools? Today it forwards `req.tools` to the provider transparently — but if a provider's tool format differs, the router doesn't know to translate.
  - _Current direction:_ Translation is a per-provider concern. The Anthropic provider already maps `LlmTool` to its native format. OpenAI's provider will do the same. The router stays format-agnostic.
- **Q3:** What's the right pre-flight estimate when `maxTokens` is unset?
  - _Current direction:_ Defaults to 1,024 in `estimatePreflightCost`. Conservative for typical chat (most responses are <1K tokens); under-estimates for long-form generation. M6.6 can use per-task heuristics.
- **Q4:** Should the router auto-downgrade to a cheaper model when the cost ceiling is close?
  - _Current direction:_ Out of scope. The router enforces; it doesn't reroute. Phase 3 dynamic policy (cost-aware fallback chain reordering) is a Phase 3 concern.
- **Q5:** Embeddings have no retry today — should they?
  - _Current direction:_ Embedding calls are typically small + idempotent + already retried at the caller (jobs framework). Adding router-level retry would compound; leave it to the consumer.
