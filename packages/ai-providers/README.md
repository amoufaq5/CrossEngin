# @crossengin/ai-providers

LLM provider router contract per **ADR-0006**.

V1 of this package is the **pure contract layer** — interfaces, zod
schemas, deterministic helpers, and a mock provider for tests. Real
provider integrations (Fireworks, Anthropic, Together, OpenAI,
self-hosted BGE) and the runtime router (failover, circuit breakers,
rate limiting, streaming over SSE) all land in Phase 2.

## What's here (v1)

- **`LlmProvider` interface** — `id`, `models`, `capabilities`,
  `residency`, `pricing`, `complete()`, `embed()`. The contract every
  provider adapter must satisfy.
- **`LlmRouter` interface** — `complete()`, `completeAggregate()`,
  `embed()`, `resolveProvider()`. The agent's view of the provider
  layer.
- **`RouterConfig`** — `providers` map + `taskPolicies` + tenant
  residency + overrides callbacks.
- **Zod schemas + types** — `CompletionRequest`, `CompletionChunk`
  (5-variant discriminated union), `NormalizedCompletion`,
  `EmbeddingRequest`/`Response`, `Usage`, `ToolCall`, `LlmMessage`,
  `LlmTool`, `CacheControl`, `CostTelemetryRecord`, `FailoverEvent`,
  `CircuitBreakerState`, `TaskKind` (7 kinds), `Region` (5),
  `TenantResidency` (4 profiles), `ProviderCapabilities`,
  `ProviderPricing`, `TaskPolicy`, `TaskPolicyMap`.
- **Pure helpers:**
  - `aggregateChunks(stream)` — consumes `AsyncIterable<CompletionChunk>`
    into a `NormalizedCompletion`. Handles text concatenation +
    parallel tool-call assembly.
  - `computeCost(pricing, in, out, cached?)` — USD cost from token
    counts; subtracts cached tokens from regular when both are priced.
  - `providerSatisfiesResidency(provider, residency)` — boolean check
    against the residency profile.
  - `makeTelemetryRecord(req, result, at?)` — constructs a
    `CostTelemetryRecord` matching the `meta.ai_provider_calls`
    schema (per ADR-0006 § Cost telemetry).
- **`MockLlmProvider`** — configurable test/dev provider implementing
  the `LlmProvider` interface. Default behavior yields a text chunk +
  usage; embed returns zero vectors of dim 16. Override per-call
  behavior or simulate errors via constructor flags.

## API

```ts
import {
  // Interfaces
  type LlmProvider,
  type LlmRouter,
  type RouterConfig,
  type ResolvedProvider,

  // Types
  type CompletionRequest,
  type CompletionChunk,
  type NormalizedCompletion,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type CostTelemetryRecord,
  type TaskKind,
  type TaskPolicy,
  type TaskPolicyMap,
  type Region,
  type TenantResidency,
  type ProviderCapabilities,
  type ProviderPricing,
  type Usage,
  type ToolCall,
  type LlmMessage,
  type LlmTool,
  type CacheControl,
  type FailoverEvent,
  type CircuitBreakerState,

  // Helpers
  aggregateChunks,
  computeCost,
  providerSatisfiesResidency,
  makeTelemetryRecord,

  // Mock
  MockLlmProvider,
  type MockLlmProviderConfig,
} from "@crossengin/ai-providers";
```

## Five v1 providers (Phase 2 implementations)

Per ADR-0006:

| Provider | Models | Use case |
|---|---|---|
| `fireworks` | Qwen3-72B, DeepSeek-V3.1, Llama-3.3-70B | Default planner-executor |
| `anthropic` | claude-sonnet-4.6, claude-haiku-4.5 | Higher-accuracy fallback |
| `together` | Llama-3.3-70B, DeepSeek-V3.1, Qwen3-72B | Secondary OSS failover |
| `openai` | gpt-5, gpt-5-nano | Tool-use fallback (tenant opt-in) |
| `self-hosted-bge` | bge-large-en, bge-m3 | Embeddings + reranking |

## Seven task kinds

`planner` / `executor` / `summarizer` / `diff-narrator` / `embedding`
/ `rerank` / `classifier`. The router maps each task to a primary +
fallback chain via `TaskPolicyMap`.

`diff-narrator` is handled by the deterministic explainer in
`@crossengin/ai-architect` (`diffSummaryFromManifestDiff`); the task
kind is here for completeness.

## Residency profiles

| Profile | Providers allowed (per ADR-0006 §Residency) |
|---|---|
| `unrestricted` | All |
| `eu-only` | Providers serving from `eu` |
| `us-only` | Providers serving from `us` |
| `me-only` | Providers serving from `me` |

`providerSatisfiesResidency(provider, residency)` enforces this. The
router fails with a clear error when no provider satisfies a tenant's
profile for a given task.

## Failover never crosses residency

Per ADR-0006: "Failover does NOT cross residency boundaries — a
tenant with `eu-only` residency cannot fail over to a US-only
provider." The v1 contract documents this; the Phase 2 runtime
enforces it.

## Deferred to Phase 2

- Real provider adapters (Fireworks, Anthropic, Together, OpenAI,
  self-hosted BGE) — each ~200-400 lines + provider-specific tests
- Streaming protocol implementation (SSE)
- Token-bucket rate limiting per provider
- Circuit breaker runtime (5 failures in 30s → open; half-open at
  60s; close on first success)
- Prompt-cache wire formats per provider (`cacheControl` → provider
  hints)
- Tool-use normalization (Anthropic blocks ↔ OpenAI tool_calls ↔
  OSS function-calling)
- BGE GPU inference container + mTLS protocol
- ClickHouse aggregation pipeline for cost telemetry
- Eval-suite integration (`tools/architect-eval` per ADR-0005)
- Per-tenant policy overrides + premium-tier defaults
- Self-hosted vLLM slot (Year 3+ trigger)
- "Always-on consensus" routing (Phase 6+)
- Recorded fixtures for deterministic tests (`__fixtures__/`)
- Nightly live tests against real providers

## Run tests

```bash
pnpm --filter @crossengin/ai-providers test
```
