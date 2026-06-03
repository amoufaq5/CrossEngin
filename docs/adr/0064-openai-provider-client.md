# ADR-0064: OpenAI provider client (Phase 2 M2.8)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0053 (Anthropic provider), ADR-0059 (ai-router), ADR-0006 (LLM provider router) |

## Context

`@crossengin/ai-providers` defines the `LlmProvider` contract; M2.7 (ADR-0053) shipped the first concrete implementation, `@crossengin/ai-providers-anthropic`. The `ai-router` (M6.5, ADR-0059) was built provider-agnostic specifically so a second provider could slot into its fallback chain with no router changes — but until now there was only one provider, so the chain had nothing to fall back *to* and embeddings (`embed()`) had no real backing (Anthropic throws).

M2.8 ships the second real provider: `@crossengin/ai-providers-openai`, binding OpenAI's Chat Completions + Embeddings APIs to the same `LlmProvider` interface. It is the mirror of the Anthropic package — same five-module anatomy, zero runtime deps (pure `fetch` + `ReadableStream`) — adapted to OpenAI's wire format.

The shape differences from Anthropic that drove the implementation:

1. **System messages stay first-class.** OpenAI keeps `role: "system"` in the `messages` array (Anthropic hoists them into a top-level `system` field). No flattening.
2. **Tool calls are stringified JSON.** OpenAI assistant `tool_calls[].function.arguments` is a JSON *string*; tool results are `role: "tool"` messages with a `tool_call_id`. (Anthropic uses `tool_use` / `tool_result` content blocks with structured input.)
3. **Streaming terminates with `data: [DONE]`** and carries usage only when `stream_options.include_usage` is set, in a final chunk with empty `choices`. (Anthropic has named SSE events + `message_delta` usage.)
4. **`prompt_tokens` includes cached tokens.** OpenAI's `prompt_tokens` is the *total*; `prompt_tokens_details.cached_tokens` is the cached subset. (Anthropic's `input_tokens` excludes cache reads.) Cost must subtract cached from prompt before applying the uncached rate.
5. **Embeddings are real.** OpenAI offers `/v1/embeddings`, so this provider's `embed()` works and `capabilities.embedding` is `true` — the first provider that can serve the router's embedding tasks.

## Decision

`@crossengin/ai-providers-openai` exports **5 modules** plus an index, depending only on `@crossengin/ai-providers` + `zod`.

### `pricing.ts`

- `OPENAI_CHAT_MODELS` (gpt-4.1, gpt-4.1-mini, gpt-4o, gpt-4o-mini, o4-mini) + `OPENAI_EMBEDDING_MODELS` (text-embedding-3-small / -large). `OPENAI_PRICING` (input / cachedInput / output USD-per-million; embeddings have output 0). `OPENAI_EMBEDDING_DIMENSIONS` (1536 / 3072).
- `isOpenAiChatModel` / `isOpenAiEmbeddingModel` guards. `computeUsageCost(model, {inputTokens, cachedInputTokens?, outputTokens})` — `inputTokens` is the *total* prompt; the function subtracts cached before applying the uncached rate, charges cached at the discounted rate, rounds to 6 decimals.

### `chat-api.ts`

- `buildOpenAiRequest(req, opts)` → `/v1/chat/completions` body. System messages preserved; user messages pass through (with optional `name`); assistant `toolUses` re-encoded as `tool_calls` with stringified `arguments`; tool messages → `role: "tool"` + `tool_call_id`. `jsonMode` → `response_format: {type: "json_object"}`; streaming → `stream: true` + `stream_options: {include_usage: true}`. Uses `max_completion_tokens` (the current field).
- `normalizeUsage(model, usage)` — `inputTokens = prompt_tokens` (total), splits out `cached_tokens`, computes cost. `extractText` / `extractToolCalls` for non-streaming responses (parses the JSON-string arguments back to objects, falling back to the raw string if unparseable).

### `streaming.ts`

- `parseSseDataPayloads` — OpenAI sends `data: {…}` lines (no `event:` field), terminated by `data: [DONE]`.
- `chunksFromSse(raw, model)` (sync, for tests) + `readSseStream(body, model)` (async, shared `StreamState` across read boundaries). Maps `delta.content` → `text` chunks; assembles `delta.tool_calls[i]` by `index` (the id + name arrive on the first delta, arguments stream after) into `tool_call_start` / `tool_call_arg_delta`; emits `tool_call_end` on `finish_reason` (or at stream end for any still-open call); accumulates usage and emits a final `usage_final`.

### `errors.ts`

- `OpenAiError` with `kind` + `status` + `isRetryable()`. 11 kinds; `RETRYABLE_KINDS` = rate_limit / server_error / service_unavailable / network / timeout. `classifyHttpStatus` (503 → service_unavailable, other 5xx → server_error). `fromHttpResponse` lifts `error.message`; `fromNetworkError` classifies aborts as timeouts.

### `provider.ts` — `OpenAiProvider implements LlmProvider`

- `complete()` streams `/v1/chat/completions`; `embed()` calls `/v1/embeddings` for real (orders vectors by `index`, derives `dim`, computes usage cost); `completeNonStreaming()` returns the parsed response; `chunksFromTextStream()` exposes the SSE parser for tests. `capabilities` = chat + toolUse + streaming + **jsonMode + embedding** (no thinking). `Authorization: Bearer` + optional `OpenAI-Organization` / `OpenAI-Project` headers. `FetchLike` injection for offline tests.

## Cross-cutting invariants enforced

- **Identical consumer surface.** `OpenAiProvider` and `AnthropicProvider` both implement `LlmProvider`; the router, chat substrate, and any consumer treat them interchangeably. The `CompletionChunk` discriminated union is byte-for-byte the same across both.
- **Cached tokens are billed correctly for the OpenAI convention.** `computeUsageCost` subtracts `cached_tokens` from the total `prompt_tokens` before charging the uncached rate — getting this wrong would double-bill the cache.
- **Streaming state survives read boundaries.** `readSseStream` buffers to the last `\n\n` and carries `StreamState` across `reader.read()` calls, so a mid-event TCP split doesn't drop tokens or tool-call fragments (covered by a split-chunk test).
- **Retryable classification matches the router's contract.** `OpenAiError.isRetryable()` returns true only for transient kinds, so `ai-router`'s `withRetry` / fallback treats OpenAI failures exactly as it treats Anthropic's (`isRetryable()` is the shared structural contract).
- **Zero runtime deps.** Pure `fetch` + `ReadableStream` + `TextDecoder`; no `openai` SDK. Same as the Anthropic package.

## Alternatives considered

- **Use OpenAI's Responses API instead of Chat Completions.**
  - **Considered.** The newer `/v1/responses` endpoint.
  - **Decision.** Chat Completions. It is the stable, universally-supported surface and maps cleanly onto the existing `CompletionChunk` model and the Anthropic implementation's shape. The Responses API can be a later addition (`OpenAiResponsesProvider`) if reasoning-item streaming or server-side tool state is needed.
- **Use the official `openai` npm SDK.**
  - **Decision.** Rejected, same rationale as ADR-0053: zero runtime deps keeps the package edge/browser/worker-portable and avoids version-coupling. The wire format is small enough to bind directly.
- **Fold OpenAI models into the Anthropic package / a shared provider base class.**
  - **Decision.** Separate package, mirroring the contract-vs-impl and one-package-per-provider conventions. The two share the `LlmProvider` contract, not code; the wire formats differ enough that a shared base would be more coupling than reuse.
- **Throw from `embed()` like Anthropic does.**
  - **Decision.** No — OpenAI has a real embeddings endpoint, so `embed()` is implemented and `capabilities.embedding = true`. This is the first provider that can serve the router's `embedding` task kind end-to-end.
- **Emit a `tool_call_end` only at stream end.**
  - **Decision.** Emit on `finish_reason` (with an end-of-stream sweep for safety). OpenAI signals tool completion via `finish_reason: "tool_calls"`, so closing there keeps the chunk sequence tight and matches consumer expectations.

## Consequences

- **54 packages + 1 app, 122 meta-schema tables, 5,992 tests** (was 53 / 122 / 5,943; +1 package, +49 tests, 0 new tables). M2.8 is complete.
- **The router fallback chain is real.** A `TaskPolicy` of `{primary: "anthropic/claude-sonnet-4-6", fallback: ["openai/gpt-4o"]}` now actually fails over to a different vendor when Anthropic is exhausted — the scenario `ai-router` was designed for but couldn't exercise with one provider.
- **Embeddings have a backend.** The router's `embedding` task kind can resolve to `openai/text-embedding-3-small`; `embed()` returns real vectors with real cost accounting. RAG / search-indexing consumers now have a provider.
- **Residency-aware multi-vendor routing.** With two providers carrying `residency` arrays, the resolver's residency filter (`eu-only` / `us-only`) becomes meaningful — a tenant can be pinned to whichever vendor is approved for its region.
- **Pattern proven twice.** The `LlmProvider` abstraction now has two independent implementations with different wire formats, validating that the contract is genuinely provider-neutral. Bedrock / Vertex / Mistral adapters follow the same five-module template.

## Open questions

- **Q1:** Should the provider expose reasoning/thinking tokens for the o-series models?
  - _Current direction:_ `supportsThinking: false` for now. The o-series streams reasoning summaries via the Responses API; Chat Completions reports reasoning tokens only in usage. A `reasoningTokens` field on `Usage` + Responses API support is a follow-up if the Architect agent wants visible reasoning.
- **Q2:** Should `embed()` support the `dimensions` parameter (truncated embeddings)?
  - _Current direction:_ Full native dimension. `text-embedding-3-*` supports a `dimensions` shortening param; expose it on `EmbeddingRequest` when a consumer needs smaller vectors.
- **Q3:** Wire OpenAI into `architect-cli`'s chat command (M2.8.5)?
  - _Current direction:_ Separate step. The provider is ready; swapping the CLI's direct `AnthropicProvider` for a `DefaultLlmRouter` configured with both providers is the M6.5.5 / M2.8.5 follow-up.
- **Q4:** Per-region OpenAI base URLs (Azure OpenAI)?
  - _Current direction:_ `baseUrl` is injectable, so Azure endpoints work with a custom base + headers today. A first-class `AzureOpenAiProvider` (different auth + deployment-name routing) is a later package if demand appears.
