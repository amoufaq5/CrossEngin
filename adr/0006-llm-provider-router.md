# ADR-0006: LLM Provider Router

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0005, ADR-0009, ADR-0010, ADR-0017, ADR-0025 |

## Context

The AI Architect (ADR-0005) needs a Large Language Model and an embedding model to function. Round 1 decided **Fireworks (hosted OSS — Qwen 3 / DeepSeek)** as the v1 LLM and **self-hosted BGE-large / BGE-M3** as the v1 embedding model. Round 8 deferred the self-hosted LLM transition until ARR + a regulated-tenant in-region inference demand justifies it.

That decision set leaves several engineering questions open:

- The platform must not be locked to one provider. Models, prices, and providers change every few months. The AI Architect should be replaceable down to the model layer without rewriting the agent.
- Different tasks have different cost/quality profiles. Planning (the planner-executor loop) benefits from a strong model; embeddings are produced by a small model; conversation summarization can use a cheap model. Routing decisions should map tasks to models, not lock everything to one model.
- Data residency matters. UAE-resident-data tenants (when they arrive) cannot send their prompts to a US-only inference endpoint. The router must know which providers/models satisfy each tenant's residency requirements.
- Cost telemetry is required for unit economics. Per-tenant, per-session, per-provider, per-model accounting must be a first-class concern.
- Self-hosted inference (Year 3+) needs to slot in without rewriting consumers. The provider abstraction must accommodate both managed APIs and locally-deployed models.
- Failover matters. Fireworks (or any single provider) has outages. The router falls back to alternate providers rather than failing the user-facing agent.

This ADR defines the **provider router**: the abstraction layer between the AI Architect (and any future LLM consumer) and the actual model endpoints.

## Decision

`packages/ai-providers` implements a unified provider interface with per-task routing, cost tracking, failover, and residency-aware selection.

### Provider interface

```typescript
interface LlmProvider {
  readonly id: string;                // e.g., "fireworks", "anthropic", "together", "self-hosted-qwen"
  readonly capabilities: {
    chat: boolean;
    toolUse: boolean;
    streaming: boolean;
    jsonMode: boolean;
    embedding: boolean;
    maxContextTokens: number;
    supportsThinking: boolean;
  };
  readonly residency: Region[];        // Which regions the provider serves inference from
  readonly pricing: {
    inputPerMillionTokens: number;
    outputPerMillionTokens: number;
    cachedInputPerMillionTokens?: number;
  };

  complete(req: CompletionRequest): AsyncIterable<CompletionChunk>;
  embed(req: EmbeddingRequest): Promise<EmbeddingResponse>;
}
```

Five concrete providers ship at v1:

| Provider | Models | Use case |
|---|---|---|
| **fireworks** | Qwen3-72B-instruct, DeepSeek-V3.1, Llama-3.3-70B | Default for planner-executor loop |
| **anthropic** | claude-sonnet-4.6, claude-haiku-4.5 | High-quality fallback; default for complex pharma compliance reasoning |
| **together** | Llama-3.3-70B, DeepSeek-V3.1, Qwen3-72B | Secondary OSS provider; failover for Fireworks |
| **openai** | gpt-5, gpt-5-nano | Tool-use fallback for tenant-opt-in only (data leaves EU) |
| **self-hosted-bge** | bge-large-en, bge-m3 | Embeddings (no chat) |

Self-hosted vLLM (`self-hosted-qwen` or successor) is added when the Year 3+ trigger fires.

### Task-to-model mapping

```typescript
type TaskKind =
  | "planner"          // The planner step of the AI Architect loop
  | "executor"         // Tool call argument generation
  | "summarizer"       // Long-conversation summarization
  | "diff-narrator"    // Resolved via deterministic explainer (no LLM); kept here for completeness
  | "embedding"        // RAG retrieval / similar-manifest search
  | "rerank"           // Reranking RAG candidates
  | "classifier";      // Simple labeling tasks
```

The router has a per-task policy:

```jsonc
{
  "planner":     { "primary": "fireworks:qwen3-72b",     "fallback": ["anthropic:claude-sonnet-4.6", "together:qwen3-72b"] },
  "executor":    { "primary": "fireworks:qwen3-72b",     "fallback": ["together:qwen3-72b"] },
  "summarizer":  { "primary": "fireworks:llama-3.3-70b", "fallback": ["together:llama-3.3-70b"] },
  "embedding":   { "primary": "self-hosted-bge:bge-m3",  "fallback": ["fireworks:embedding-v1"] },
  "rerank":      { "primary": "self-hosted-bge:bge-reranker-v2-m3", "fallback": [] },
  "classifier":  { "primary": "fireworks:qwen3-7b",      "fallback": ["together:llama-3.3-8b"] }
}
```

Per-tenant overrides:

- Tenant tier (premium / regulated) may override `planner` to `anthropic:claude-sonnet-4.6` for higher accuracy on compliance-heavy manifests.
- Tenant residency profile (e.g., `eu-only`) may strike providers from the fallback chain if they cannot inference in-region.
- Tenant opt-in flag enables OpenAI for organizations that explicitly accept US data flow.

### Residency-aware selection

Each provider declares which regions it serves inference from. The router compares against the tenant's `residency` setting from ADR-0010:

| Tenant residency | Allowed providers |
|---|---|
| `unrestricted` | All |
| `eu-only` | Fireworks (EU node), Anthropic (EU via dedicated), Together (EU), self-hosted-bge (EU) |
| `me-only` | self-hosted-bge (UAE node when deployed), self-hosted-qwen (UAE node when deployed) |
| `us-only` | Fireworks (US), Anthropic (US), Together (US), OpenAI (US) |

When a tenant's residency profile leaves zero providers for a task, the router fails the request with a clear error: "no provider satisfies residency=`me-only` for task=`planner`. Self-hosted UAE inference required."

### Streaming and tool use

The agent (ADR-0005) consumes streamed completions for the chat narration. Tool calls (which return JSON) are not streamed — they are atomic.

Provider-specific tool-use APIs are normalized:

- **Anthropic:** `tool_use` and `tool_result` content blocks.
- **OpenAI:** `tools` and `tool_calls` arrays.
- **Fireworks / Together (OSS models):** function-calling syntax varies by model; the router translates to a uniform JSON-mode + post-processing.

The normalized contract the agent sees:

```typescript
interface NormalizedCompletion {
  text?: string;                       // Free-form narration
  toolCalls?: Array<{                  // 0+ tool calls
    id: string;
    name: string;
    arguments: JsonValue;
  }>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cost: number;                      // Computed in USD
  };
}
```

### Failover

When a primary provider returns an error (5xx, rate limit, timeout, provider-specific schema-error), the router walks the fallback chain. Failover events are logged with reason; persistent failover from a primary triggers a P2 alert (ADR-0017).

Failover does NOT cross residency boundaries — a tenant with `eu-only` residency cannot fail over to a US-only provider.

### Rate limiting and quotas

Each provider has a per-key rate limit (tokens/min, requests/min). The router maintains a per-provider token-bucket; over-limit requests queue with a 5-second timeout before either succeeding (limit reset) or failing.

Per-tenant quotas are enforced *above* the provider router (in the AI Architect, ADR-0005, via session token budgets).

### Prompt caching

Anthropic and Fireworks support prompt caching (substantial cost savings on repeated context). The router exposes a `cacheControl` field on the completion request:

```typescript
{
  systemPrompt: "...",        // Stable across many calls — cache aggressively
  toolSchemas: "...",         // Stable per agent version — cache aggressively
  retrievedContext: "...",    // Changes per turn — cache for the session
  conversationHistory: "...", // Appends each turn — cache the prefix
  userMessage: "..."          // Always fresh
}
```

The router translates `cacheControl` to provider-specific cache hints. Together / OpenAI fall back to no caching if unsupported.

### Cost telemetry

Every completion records to `meta.ai_provider_calls`:

```jsonc
{
  "tenant_id": "t_...",
  "session_id": "s_...",
  "task_kind": "planner",
  "provider_id": "fireworks",
  "model_id": "qwen3-72b",
  "input_tokens": 4521,
  "output_tokens": 312,
  "cached_input_tokens": 3800,
  "cost_usd": 0.0028,
  "latency_ms": 1832,
  "ok": true,
  "error": null,
  "occurred_at": "2026-05-12T..."
}
```

Aggregations are materialized hourly into ClickHouse (ADR-0013) for cost dashboards, per-tenant cost reports, and anomaly detection. A tenant whose cost suddenly 10x is investigated for either an attack or a bad prompt.

### Embedding pipeline

`self-hosted-bge` runs as a GPU container (host TBD per ADR-0009 open question):

```
Inbound (authenticated, mTLS):
  POST /embed?model=bge-m3
  Body: { texts: ["..."] }

Outbound:
  { vectors: [[0.13, -0.42, ...]], dim: 1024, model: "bge-m3" }
```

The container hosts `bge-m3` (multilingual, 1024-dim) and `bge-reranker-v2-m3` (reranking). Cached at startup; cold start <30s. Replicated across two instances for HA.

Embedding requests are batched at the router level — up to 32 texts per request — to amortize GPU overhead.

## Alternatives considered

### Option A — Single-provider lock-in (Fireworks only, no router)

Hard-code Fireworks API calls throughout `packages/ai-architect`.

- **Pros:** Zero abstraction overhead. Simplest possible code.
- **Cons:** Migrating providers (when Fireworks raises prices, has an outage, deprecates a model) requires rewriting every call site. No tenant-specific routing. No residency awareness. No failover.
- **Why not:** The provider landscape changes every 3-6 months. Lock-in is short-term cheap, long-term expensive.

### Option B — LangChain or LlamaIndex provider layer

Use an existing abstraction.

- **Pros:** Pre-built. Active maintenance.
- **Cons:** Generic abstractions optimize for a different shape than our task-routing + residency + cost telemetry needs. Their abstractions add features we don't use and miss features we do (provider-specific caching, residency rules). Vendor risk: framework deprecation is real.
- **Why not:** Our abstraction is small (~1,200 lines) and tailored. Owning it is cheaper than fighting a framework.

### Option C — Provider-side routing via OpenRouter or similar

Use OpenRouter as a single endpoint that routes to any underlying provider.

- **Pros:** One API. One billing relationship. Provider-side handles failover.
- **Cons:** OpenRouter takes a margin (typically 5-10%). Less control over residency (we'd need to verify which underlying provider serves each tenant). Latency overhead (extra hop). Tool-use normalization may not match what each provider's native API offers.
- **Why not:** For compliance-bound deployments, provider-side routing is a black box auditors don't like. Direct integrations give us audit trails and residency guarantees.

### Option D — Always-self-hosted (vLLM from day one)

Skip managed providers; deploy our own vLLM cluster from v1.

- **Pros:** Maximum cost control at scale. No data leaves CrossEngin infrastructure. Strong compliance story.
- **Cons:** Operational complexity (GPU provisioning, model management, latency tuning, autoscaling) before any product code. Quality of self-hosted OSS models in 2026 lags Anthropic/OpenAI in tool-use reliability. Costs are high until utilization is high.
- **Why not:** Round 8 decision: defer self-hosted until ARR + regulated-tenant demand justifies. The router architecture accommodates the transition without rewrites.

### Option E — Multi-provider always-on consensus (route to 2-3 providers per call, pick best)

Send each call to multiple providers and pick the best response.

- **Pros:** Higher quality through voting / best-of-N.
- **Cons:** 2-3x cost per call. Latency = max of all calls. Picking "best" requires another model. Overkill for v1.
- **Why not:** Possibly useful for the highest-stakes calls (regulated tenant compliance reasoning) at Phase 6+. Defer.

## Consequences

### Positive

- **Provider lock-in avoided.** Adding, swapping, or removing a provider is a single config change in `packages/ai-providers`.
- **Task-level routing.** Cheap models for cheap tasks; expensive models where accuracy matters. Healthier unit economics than a uniform model choice.
- **Residency-aware by construction.** Tenants get correct provider selection without per-call logic in the agent.
- **Failover keeps the agent online** when a single provider has an outage.
- **Cost telemetry feeds pricing.** Per-tenant cost is measurable, attributable, and surfaceable in the billing UI.

### Negative

- **Provider abstraction surface to maintain.** Five providers + per-provider quirks (tool-use shape, streaming chunk format, cache directives) is ~1,200 lines of code + tests. Mitigation: a strong test suite around the normalization layer.
- **Tool-use normalization is the riskiest piece.** OSS models' function-calling reliability varies by model and prompt; the router must validate and retry. Mitigation: eval suite (ADR-0005) catches regressions; per-model prompt templates as needed.
- **Self-hosted BGE container is a real ops burden.** Mitigation: containerize tightly (distroless, read-only FS); two replicas for HA; alarms on inference latency and error rate.
- **Cost telemetry storage adds load.** ClickHouse handles it; cost is acceptable.

### Neutral

- **Anthropic and OpenAI integrations exist** as fallbacks even if rarely used at v1. Maintaining their adapters is part of the abstraction layer.
- **Self-hosted vLLM** is a placeholder slot in the abstraction; not implemented at v1.

### Reversibility

**High flexibility within the router.** Adding/removing providers, changing per-task routing, adjusting residency rules — all are config-level changes.

**Moderate cost to swap the abstraction itself.** If we replace `packages/ai-providers` with LangChain or OpenRouter later, that's a few weeks of work but feasible because the agent only sees the normalized contract.

**High cost to remove the abstraction.** Going back to hard-coded calls means rewriting every caller. We don't plan to.

## Implementation notes

- **Package location:** `packages/ai-providers`. Sub-modules per provider: `providers/fireworks`, `providers/anthropic`, `providers/together`, `providers/openai`, `providers/self-hosted-bge`.
- **Provider configuration:** `meta.ai_provider_configs` stores per-provider API keys (vault references per ADR-0004), rate limits, regional endpoints. Hot-reloadable at the router; no code deploy needed to add a region.
- **Per-task policy:** stored in `meta.ai_task_policies`. Default policy at boot; per-tenant overrides layered on top.
- **Streaming protocol:** Server-Sent Events from the router to the agent's loop. Each chunk has `kind: text | tool_call_start | tool_call_arg_delta | tool_call_end | usage_final`.
- **Retries:** transient errors (5xx, timeout) retry once with 100 ms backoff before failover. Permanent errors (4xx) failover immediately.
- **Circuit breaker:** per-provider circuit. Opens after 5 consecutive failures in 30 s; half-open after 60 s; closes on first success.
- **Embedding batching:** in-process batch within 50 ms windows. Up to 32 texts per batch. Cold-start guard: first request after 5 min idle warms the container with a dummy batch.
- **Cost computation:** at request completion, the router computes `cost = input_tokens * provider.pricing.inputPerMillionTokens / 1e6 + output_tokens * outputPerMillionTokens / 1e6`. Cached input tokens use `cachedInputPerMillionTokens` when applicable.
- **Audit cross-link:** every provider call records the AI Architect session ID and the kernel-issued tool-call ID, so the audit log (ADR-0008) can trace any manifest change to specific LLM calls.
- **Eval integration:** `tools/architect-eval` (ADR-0005) runs the eval suite once per provider/model variant. Regression vs. baseline blocks deploys.
- **Testing strategy:** integration tests use recorded fixtures (`packages/ai-providers/__fixtures__/`) for deterministic eval runs. A separate "live" test suite hits real providers nightly.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| BGE inference host: Fly Machines / RunPod / Lambda Labs / AWS GPU spot. Aligns with ADR-0009 open question. | amoufaq5 | Phase 2 |
| Per-task model defaults at v1 — exact model SKUs (qwen3-72b vs. deepseek-v3.1 vs. llama-3.3-70b) chosen by eval-suite performance. Decide after first eval run. | amoufaq5 | Phase 3 |
| Anthropic enterprise contract for higher rate limits + zero-retention policy — when does v1 traffic justify the contract minimum (typically USD 10K/mo)? | amoufaq5 | Phase 5 |
| Prompt caching opt-in/out per tenant — some regulated tenants may forbid even within-session prompt caching. Compliance-pack-driven default? | _pending compliance hire_ | Phase 4 |
| OpenAI for tool-use fallback — at what eval-accuracy gap from Fireworks does it become a default rather than opt-in? | amoufaq5 | Phase 4 |
| Self-hosted LLM trigger conditions — exact ARR threshold and regulated-tenant volume that triggers vLLM deployment. Round 8 named the trigger conceptually; this is the operational threshold. | amoufaq5 | Year 2 |
| Reranking necessity at v1 — bge-reranker-v2-m3 adds latency and cost; only justified if RAG quality without it is materially worse. Empirical question. | amoufaq5 | Phase 3 |

## References

- ADR-0005 (AI Architect contract) — defines the agent that consumes the router.
- ADR-0009 (Security model) — defines secret management for API keys.
- ADR-0010 (Multi-region and data residency) — defines per-tenant residency profiles.
- ADR-0013 (Reporting and analytics) — defines ClickHouse aggregations for cost telemetry.
- ADR-0017 (Observability and SLOs) — defines per-provider latency and error-rate alerts.
- ADR-0025 (AI Architect safety and governance) — defines tenant opt-in for OpenAI / US-routed providers.
- Fireworks API documentation; Anthropic API documentation; OpenAI tool-use docs; OPA `opa-wasm`; BGE model card.
