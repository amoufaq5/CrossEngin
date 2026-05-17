# ADR-0060: Real OpenAI provider client (Phase 2 M2.8)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-17 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0053 (Anthropic provider), ADR-0055 (LlmMessage.toolUses extension), ADR-0059 (ai-router) |

## Context

M2.7 shipped the Anthropic provider; M6.5 shipped the router. Both are well-tested in isolation, but the router's value — picking between providers, falling back, embeddings — can't be exercised without a second `LlmProvider` in the workspace. M2.8 fills that gap with OpenAI's Chat Completions + Embeddings APIs.

OpenAI's wire format differs from Anthropic's in three ways that drove the design:

1. **Tool calls are indexed, not id'd, in stream deltas.** OpenAI's streaming format identifies a tool call by `tool_calls[i].index` across deltas; the `id` and `function.name` appear once (in the first delta for that index), and `function.arguments` is a streamed JSON string fragment. Anthropic uses an explicit `id` from `content_block_start`. The streaming parser needs different state.

2. **OpenAI ships embeddings.** Anthropic doesn't. M2.8 is the first real `embed()` implementation in the workspace. Vectors come back unsorted (per `data[i].index`), need sorting, and the `dim` must be derived from `vectors[0].length`.

3. **The `LlmMessage` round-trip uses `tool_calls` (not `tool_use` blocks).** OpenAI assistant messages carry tool calls in a `tool_calls: [...]` array; tool-role messages reference them via `tool_call_id`. The M5.6 `LlmMessage.toolUses` extension already accommodates this — `toolUses` maps directly to `tool_calls` for OpenAI, just as it maps to `tool_use` content blocks for Anthropic.

## Decision

`@crossengin/ai-providers-openai` exports **6 modules** plus an index:

### `pricing.ts`

- **`OPENAI_CHAT_MODELS`**: `gpt-4o` / `gpt-4o-mini` / `gpt-4-turbo` / `o1` / `o1-mini`. The current commercial generation; legacy `gpt-3.5-*` excluded.
- **`OPENAI_EMBEDDING_MODELS`**: `text-embedding-3-small` / `text-embedding-3-large`.
- **`OPENAI_CHAT_PRICING`**: per-model `inputUsdPerMillion` / `cachedInputUsdPerMillion` / `outputUsdPerMillion`. Current rates: gpt-4o $2.50/$10, gpt-4o-mini $0.15/$0.60, o1 $15/$60.
- **`OPENAI_EMBEDDING_PRICING`**: text-embedding-3-small $0.02/M, text-embedding-3-large $0.13/M.
- **`computeChatUsageCost(model, {inputTokens, cachedInputTokens?, outputTokens})`** splits fresh-input vs cached-input vs output, rounds to 6 decimals.
- **`computeEmbeddingCost(model, inputTokens)`** identical rounding.
- Type guards: `isOpenAIChatModel` / `isOpenAIEmbeddingModel` / `isOpenAIModel`.
- Defaults: `OPENAI_DEFAULT_CHAT_MODEL = "gpt-4o-mini"`, `OPENAI_DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"`. Both are the cheapest option — the router or app overrides for premium tiers.

### `chat-api.ts`

- **`OpenAIChatRequest`** / **`OpenAIChatMessage`** / **`OpenAIToolCall`** / **`OpenAIToolDeclaration`** / **`OpenAIChatResponse`** / **`OpenAIChatUsage`** types matching the wire format.
- **`buildOpenAIChatRequest(req, opts)`** translates a `CompletionRequest`:
  - `system` / `user` messages → plain `{role, content}`.
  - `assistant` without `toolUses` → `{role: "assistant", content}`.
  - `assistant` with `toolUses` → `{role: "assistant", content: <text or null>, tool_calls: [{id, type:"function", function:{name, arguments: JSON.stringify(input)}}]}`. Content goes to `null` (per OpenAI spec) when there's no text alongside the tool calls.
  - `tool` → `{role: "tool", tool_call_id, content, name?}`.
  - Tools translate to `{type:"function", function:{name, description, parameters: inputSchema}}`.
  - `stream: true` adds `stream_options: {include_usage: true}` so the final SSE chunk carries token counts.
- **`normalizeChatUsage(model, usage)`** maps `prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens` → platform `Usage` with cost.
- **`extractTextFromResponse(response)`** / **`extractToolCallsFromResponse(response)`** for non-streaming consumers.

### `streaming.ts`

- **`parseSseEvents(raw)`** splits on `\n\n`, extracts `data:` lines, handles `\r\n`.
- **`chunksFromSse(raw, model)`** generator yielding `CompletionChunk`:
  - `delta.content` (non-empty) → `{kind:"text", text}`.
  - `delta.tool_calls[*]` accumulated by `index`:
    - First delta with `id` + `function.name` → `{kind:"tool_call_start", id, name}` (once per index, gated by an internal `started` flag).
    - Subsequent deltas with `function.arguments` → `{kind:"tool_call_arg_delta", id, delta}`.
  - `finish_reason: "stop"` or `"tool_calls"` → `{kind:"tool_call_end", id}` for each still-active tool buffer.
  - The final `data:` chunk (which OpenAI sends with `stream_options.include_usage: true`) provides `usage`; saved into state and emitted as `{kind:"usage_final", usage: normalizeChatUsage(...)}` at the end.
  - `[DONE]` markers are skipped (not JSON).
  - Malformed JSON data chunks are skipped silently.
- **`readSseStream(body, model)`** async generator over `ReadableStream<Uint8Array>` — same shared-state pattern as the Anthropic provider (single `StreamState` outside the read loop so cumulative state survives multi-chunk fills).

### `embeddings.ts`

- **`buildEmbeddingsRequest({texts, model})`** → `{model, input, encoding_format: "float"}`.
- **`normalizeEmbeddingResponse(model, raw)`** sorts `data[]` by `index`, extracts `embedding` arrays, derives `dim` from the first vector's length, packs `Usage` with `outputTokens: 0` (embeddings have no output) and cost from `computeEmbeddingCost`.
- **`normalizeEmbeddingUsage(model, usage)`** standalone helper for consumers that handle the response themselves.

### `errors.ts`

Same shape as the Anthropic errors (deliberate — keeps the router's `isRetryable()` check uniform):

- **`OPENAI_ERROR_KINDS`** (11 kinds) + **`RETRYABLE_KINDS`** set covering `rate_limit / overloaded / network / timeout / api_error`.
- **`OpenAIError extends Error`** with `kind` + `status` + `code` + `isRetryable()`.
- **`classifyHttpStatus(status)`** maps 400/401/403/404/408/413/429 to the right kinds; 5xx → `api_error`; else `unknown_error`.
- **`fromHttpResponse({status, body})`** parses OpenAI's `{error: {type, message, code}}` envelope. Maps known types (including `rate_limit_exceeded` → `rate_limit_error` and `service_unavailable` → `overloaded_error`); falls back to status-based classification for unknown types.
- **`fromNetworkError(err)`** returns `timeout_error` for AbortError / messages containing "timeout"; else `network_error`.

### `provider.ts`

- **`OpenAIProvider implements LlmProvider`** with capabilities `{chat:true, streaming:true, toolUse:true, jsonMode:true, embedding:true, maxContextTokens:128_000, supportsThinking:false}`.
- Pricing derived from the configured `defaultChatModel`'s entry (matches the Anthropic provider's pattern).
- `models` array includes both chat + embedding model names.
- **`complete(req)`** POSTs to `${baseUrl}/v1/chat/completions` with `Authorization: Bearer ${apiKey}` + optional `openai-organization` + `openai-project` headers, yields chunks from `readSseStream`.
- **`completeNonStreaming(req)`** returns the parsed `OpenAIChatResponse`.
- **`embed(req)`** POSTs to `/v1/embeddings`, returns `EmbeddingResponse` via `normalizeEmbeddingResponse`.
- Model resolution: `complete()` requires a chat model (rejects embedding model with `invalid_request_error`); `embed()` requires an embedding model (rejects chat model). Unknown models also fail fast with `invalid_request_error`.
- `FetchLike` injection for tests.

## Cross-cutting invariants enforced

- **Same `isRetryable()` shape as Anthropic.** The router's retry policy doesn't need to know which provider it's talking to — both error classes implement the same interface. M6.5's `isRetryableError` type guard works unmodified.
- **Tool round-trips are symmetric with Anthropic.** A `CompletionRequest` carrying `assistant.toolUses` produces a valid OpenAI request OR a valid Anthropic request, depending on the provider. Neither requires `LlmMessage` to change. Verified by the chat-api tests asserting the round-trip structure.
- **Embedding model ≠ chat model.** `complete()` and `embed()` are strictly typed: passing an embedding model to chat (or vice versa) fails locally with `invalid_request_error` before the API call burns a request.
- **Token state survives stream boundaries.** Same `StreamState` outside-the-loop pattern as the Anthropic SSE reader. `chunksFromSse` and `readSseStream` both share the state, so tool deltas and usage tokens accumulate correctly across multi-chunk fills.
- **Cost = 0 is valid.** Very small embedding batches (e.g., 5 tokens × $0.02/M = $1e-7) round to 0.000000 at 6 decimals. The Usage schema requires `cost >= 0`, not `cost > 0`; tests check `>=` accordingly. Real-world embedding workloads batch 1000s of tokens so the rounding artifact only shows in tiny test fixtures.
- **Zero runtime deps.** Like the Anthropic provider, OpenAI's binding uses native `fetch` + `ReadableStream`. No `openai` SDK; the provider runs identically in Node / Bun / Deno / Cloudflare Workers / Vercel Edge.

## Alternatives considered

- **Use the official `openai` npm package.**
  - **Pros.** Less code. Well-maintained. Streaming + tool-use built-in.
  - **Cons.** Adds a runtime dep with its own transitive surface (and version skew risk). The SDK wraps `fetch` under the hood; for our purposes, that wrapper isn't earning its keep.
  - **Decision.** Direct fetch binding, like M2.7's Anthropic provider. ~250 lines of provider + parser + types covers the surface.

- **Implement the Responses API (`/v1/responses`) instead of / in addition to Chat Completions.**
  - **Pros.** Newer, agent-oriented surface that's converging on Anthropic-style tool blocks.
  - **Cons.** Less universally supported (some deployments still use Chat Completions), slightly different event format, and tools/agentic features are still evolving.
  - **Decision.** Ship Chat Completions for M2.8 (broadest compatibility). M2.8.5 adds the Responses API if the agentic features become essential. The Chat Completions path is sufficient for everything the router + chat substrate need today.

- **Make `default_model` a single field for both chat + embedding.**
  - **Considered.** Simpler config.
  - **Decision.** Two separate defaults (`defaultChatModel` + `defaultEmbeddingModel`) since the two APIs have non-overlapping model lists. A single field would require runtime dispatch + error-prone validation.

- **Buffer tool-call argument fragments into JSON and emit one `tool_call_arg_delta`.**
  - **Considered.** Cleaner consumer experience.
  - **Decision.** Emit per-fragment deltas, matching the Anthropic streaming surface. Consumers (chat engine) already assemble fragments into the full input via the existing `tool_call_arg_delta` accumulation logic.

- **Set `temperature` defaults at the provider layer.**
  - **Considered.** OpenAI's o1 / o1-mini reject `temperature` (must be 1.0 or omitted). Providers could enforce.
  - **Decision.** Pass through `req.temperature` as-is. If a consumer asks for `temperature: 0.7` on o1, the API will reject with `invalid_request_error` and our error normalization carries the message. Defaults are the consumer's call.

- **Support OpenAI-Compatible alternative endpoints (Azure OpenAI, Together AI, Groq).**
  - **Considered.** Same wire format with a custom `baseUrl`.
  - **Decision.** The `baseUrl` option already lets consumers point at Azure / compatible endpoints. Not a Decision for M2.8 — it's an emergent capability since the request shape is identical. Azure's auth header differs (`api-key` instead of `Authorization: Bearer`); a future `@crossengin/ai-providers-azure-openai` package can specialize that.

## Consequences

- **52 packages + 1 app, 119 meta-schema tables, 5,842 tests** (was 51 / 119 / 5,768; +1 package, +74 tests, 0 new META_ tables).
- **The router is now testable on multi-provider scenarios.** `DefaultLlmRouter` configured with both `AnthropicProvider` and `OpenAIProvider` can be exercised against real provider behavior — chained fallback, cross-provider retry, embedding requests routed to OpenAI even when chat goes to Anthropic.
- **Embeddings work end-to-end.** The router's `embed()` path now has a real provider. Any future consumer that needs vectors (search reindex, RAG, similarity) can use `provider.embed()` or `router.embed()` interchangeably.
- **Architect agent gets cheaper fast-path.** With both providers configured, the router can route `--task=summarizer` to `gpt-4o-mini` ($0.15/M) instead of `claude-sonnet-4-6` ($3/M) — a 20× cost reduction for high-volume small tasks. The chat REPL stays on Claude for authoring; routine summarization batches go to OpenAI.
- **The `toolUses` extension is validated cross-provider.** M5.6 added `LlmMessage.toolUses` so Anthropic could round-trip tool blocks. M2.8 confirms it generalizes — OpenAI's `tool_calls` array maps trivially. Future providers (Bedrock, Vertex, local Llama) follow the same pattern.
- **Capability matrix is now meaningful.** Anthropic: `embedding: false, supportsThinking: true`. OpenAI: `embedding: true, jsonMode: true, supportsThinking: false`. The router's task-policy mapping can route based on these flags — e.g., `task: embedding` automatically targets OpenAI.

## Open questions

- **Q1:** Does the router need to know about provider capabilities, not just model names, when picking a chain?
  - _Current direction:_ Yes eventually. M6.6 can add `capabilityRequirements` to the task policy (e.g., `executor` requires `toolUse: true`). For M2.8, the operator manually configures the chain per task; capability filtering is a future refinement.
- **Q2:** Should `Azure OpenAI` get its own package or extend this one?
  - _Current direction:_ Separate package. Azure uses `api-key` header (not `Authorization`), deployment names instead of model names, and a different URL structure. A subclass or config-flag approach would muddy this provider's surface.
- **Q3:** What's the right strategy for o1's `reasoning_tokens`?
  - _Current direction:_ OpenAI counts reasoning tokens against `completion_tokens` in the public usage. The provider treats them as output tokens (priced at the higher output rate). A future `usage.reasoningTokens` extension could surface the breakdown if cost auditing demands it.
- **Q4:** Should `embed()` accept `dimensions` (text-embedding-3 supports custom output dimensions)?
  - _Current direction:_ Not in M2.8. The `EmbeddingRequest` schema doesn't expose `dimensions`; passing it would require extending the platform contract. Phase 3 RAG package can add it via an OpenAI-specific extension if needed.
- **Q5:** Does the provider need built-in retry like the SDK does?
  - _Current direction:_ No. The M6.5 router owns retry policy. Layering provider-level retry on top would compound (3 × 3 = 9 attempts). The provider stays a thin wire-format adapter.
