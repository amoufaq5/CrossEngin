# ADR-0053: Real Anthropic provider client (Phase 2 M2.7)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-17 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0046 (Phase 2 plan), ADR-0048 (crypto), ADR-0027 (AI providers + architect) |

## Context

`@crossengin/ai-providers` defines the provider router and the `LlmProvider` interface (`complete()` streaming + `embed()`) but ships no real client. Every consumer wiring the Architect agent to a real model has to roll their own Anthropic / OpenAI / Bedrock binding. Three reasons that's unsustainable:

1. **The streaming protocol is non-trivial.** Anthropic SSE has 6 event kinds — `message_start`, `content_block_start`, `content_block_delta` (with `text_delta` or `input_json_delta` sub-kinds), `content_block_stop`, `message_delta`, `message_stop`. Token usage trickles in via `message_start.usage.input_tokens` + `message_delta.usage.output_tokens`. Tool calls are interleaved as separate `content_block_*` events with their own indexed JSON-delta stream. Every consumer would re-implement the same buffering + parsing.

2. **Error taxonomy is shared.** Anthropic returns `invalid_request_error` / `authentication_error` / `permission_error` / `not_found_error` / `rate_limit_error` / `overloaded_error` / `api_error` / `request_too_large` / `timeout_error`. Retryable subset is `rate_limit / overloaded / api / network / timeout`. Every consumer would re-derive the classification + retry policy.

3. **Pricing is per-model + cache-aware.** The Architect's cost ceiling (from ADR-0027) needs accurate per-request USD. Anthropic exposes `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` — each priced differently. Every consumer would re-encode the price table.

M2.7 ships that piece. No SDK dependency — pure `fetch` + `ReadableStream`, so the package runs in Node, Bun, Deno, edge runtimes.

## Decision

`@crossengin/ai-providers-anthropic` exports **five modules** plus an index:

1. **`pricing.ts`.** `ANTHROPIC_MODELS` enum (`claude-opus-4-7` / `claude-opus-4-6` / `claude-sonnet-4-6` / `claude-sonnet-4-5` / `claude-haiku-4-5`). `ANTHROPIC_PRICING` table per-model: `inputUsdPerMillion` / `cachedInputUsdPerMillion` / `outputUsdPerMillion` / `cacheWriteUsdPerMillion`. `computeUsageCost(model, usage)` returns USD rounded to 6 decimals — splits regular input vs cached input vs cache-write so callers see the true cache savings. `isAnthropicModel(value)` type guard for runtime model-id validation.

2. **`messages-api.ts`.** Anthropic Messages API contracts: `AnthropicMessagesRequest`, `AnthropicSystemBlock`, `AnthropicMessage`, `AnthropicContentBlock` (text / image / tool_use / tool_result), `AnthropicTool`, `AnthropicUsage`, `AnthropicResponse`. `buildAnthropicRequest(CompletionRequest, opts)` translates the provider-agnostic `CompletionRequest` from `@crossengin/ai-providers` into the wire format:
   - System messages flatten into the top-level `system` array (with optional `cache_control: {type: "ephemeral"}` when caller opts into prompt caching).
   - Tool-role messages re-attach as `tool_result` content blocks under a `user`-role message (Anthropic doesn't have a `tool` role).
   - `temperature` / `top_p` / `top_k` / `stop_sequences` / `tool_choice` flow through.
   `normalizeUsage(model, usage)` turns `AnthropicUsage` into the platform-standard `Usage` record (with `cost` computed from `pricing.ts`). `extractText` + `extractToolCalls` helpers for non-streaming consumers.

3. **`streaming.ts`.** `parseSseEvents(raw)` splits the SSE wire format on `\n\n`, extracts `event:` + `data:` lines per block. `chunksFromSse(raw, model)` is a generator that yields the discriminated-union `CompletionChunk` kinds from `@crossengin/ai-providers` (`text` / `tool_call_start` / `tool_call_arg_delta` / `tool_call_end` / `usage_final`). `readSseStream(body, model)` is the async generator that wraps a `ReadableStream<Uint8Array>` — reads chunks, accumulates a single shared `StreamState` across multiple SSE buffer fills, and yields one final `usage_final` with cumulative tokens. State is shared via the internal `processSseEvents(raw, state)` helper so token counters survive across `reader.read()` boundaries (a bug present in the first draft, fixed by extracting the state).

4. **`errors.ts`.** `ANTHROPIC_ERROR_KINDS` (11 kinds). `RETRYABLE_KINDS` set for `rate_limit_error / overloaded_error / network_error / timeout_error / api_error`. `AnthropicError extends Error` with `kind` + `status` fields + `isRetryable()` helper. `classifyHttpStatus(status)` maps 400 → `invalid_request_error` / 401 → `authentication_error` / 403 → `permission_error` / 404 → `not_found_error` / 408 → `timeout_error` / 413 → `request_too_large` / 429 → `rate_limit_error` / 529 → `overloaded_error` / 5xx → `api_error`. `fromHttpResponse({status, body})` parses Anthropic's `{error: {type, message}}` envelope and prefers the body's `type` over the status mapping (so a 500 with `overloaded_error` in the body is honored). `fromNetworkError(err)` returns `timeout_error` for `AbortError` / messages containing "timeout", else `network_error`.

5. **`provider.ts`.** `AnthropicProvider implements LlmProvider`:
   - `capabilities: {chat: true, streaming: true, toolUse: true, jsonMode: false, embedding: false, maxContextTokens: 200_000, supportsThinking: true}`.
   - `pricing` derived from the configured `defaultModel`'s entry in `ANTHROPIC_PRICING`.
   - `residency: ["us", "eu"]` (Anthropic offers both regions via API).
   - `complete(req)` builds the request, POSTs to `${baseUrl}/v1/messages` with `x-api-key` + `anthropic-version: 2023-06-01` + `accept: text/event-stream` headers, optional `anthropic-beta` for feature flags (prompt caching, tool streaming, computer use), yields chunks from `readSseStream`.
   - `embed()` throws `invalid_request_error` (Anthropic has no embeddings API).
   - `completeNonStreaming(req)` for callers that want the full `AnthropicResponse` for one-shot evaluation / replay verification.
   - `FetchLike` injection point so tests can stub the transport without touching `globalThis.fetch`.
   - `summarizeResponse(response, model)` packs text + tool calls + stop reason + normalized usage for the Architect's session log.

## Cross-cutting invariants enforced

- **Token state survives stream boundaries.** `readSseStream` constructs one `StreamState` outside its read loop. `processSseEvents` mutates that state in place; the cumulative `usage_final` is yielded once at end-of-stream. Earlier draft created fresh state per buffer fill and lost tokens — the test suite catches the regression (`yields text chunks + usage_final` checks `inputTokens === 15` after a multi-event stream).
- **Model id validation at every entry point.** Constructor validates `defaultModel` via `isAnthropicModel`. Per-request `model` override re-validates via `resolveModel` and throws `invalid_request_error` for unknown ids — Anthropic would 400 anyway, but failing locally is faster + doesn't burn a request.
- **No raw `any`.** SSE event payloads are typed as `Record<string, unknown>` and narrowed with explicit `typeof` / `Array.isArray` checks. JSON.parse results are typed at the call site, not via a sweeping cast.
- **Constant-time api key handling never required.** The api key goes into the `x-api-key` header. It's never compared, hashed, or persisted by this package — that's the caller's concern (e.g., via `@crossengin/crypto`'s `KeyStore`).
- **Errors normalize to `AnthropicError`.** Network failures → `fromNetworkError(err)`. HTTP non-2xx → `fromHttpResponse({status, body})`. JSON parse failures → `AnthropicError({kind: "api_error"})`. Consumers can branch on `kind` + call `isRetryable()` without `instanceof` chains.

## Alternatives considered

- **Use the official `@anthropic-ai/sdk` package.**
  - **Pros.** Less code, well-maintained.
  - **Cons.** Adds 1 runtime dep + its transitive surface (Bun-incompatible deps in some versions; ESM/CJS conflicts on edge runtimes). Wraps `fetch` anyway under the hood.
  - **Why not.** The Anthropic Messages API is small enough to bind directly; one fetch call + one SSE parser is less code than the SDK wrapper. Zero runtime deps lines up with the rest of the workspace (`@crossengin/crypto` uses `node:crypto`, `@crossengin/kernel-pg` uses `pg`).

- **Make `AnthropicProvider` part of `@crossengin/ai-providers`.**
  - **Considered.** Co-locate router + clients.
  - **Decision.** Separate package keeps `ai-providers` contract-only. Adding a real provider client there would imply the router also needs OpenAI / Bedrock / Vertex / Cohere clients to stay symmetric — each is its own package (M2.8+ ships them on demand).

- **Yield text chunks one character at a time.**
  - **Considered.** UI-friendly typewriter effect.
  - **Decision.** Anthropic's stream already delivers fine-grained `text_delta` events. Splitting further is the UI's concern.

- **Auto-retry inside `complete()`.**
  - **Considered.** Built-in exponential backoff for `rate_limit_error` / `overloaded_error`.
  - **Decision.** Retry policy is the router's concern (`@crossengin/ai-providers` has the `RouterPolicy` types). The provider surfaces `isRetryable()` so the router knows when to retry. Baking retry into the provider would make the same request retry from two layers.

- **Persist requests + responses to a META_ table.**
  - **Considered.** A `META_AI_REQUESTS` row per call for audit.
  - **Decision.** That's a separate concern — `@crossengin/ai-providers` already defines the abstract `LlmRequest` log. The provider stays stateless; persistence is the router's adapter responsibility.

- **Support all Anthropic models (including legacy `claude-2.1` / `claude-instant-1.2`).**
  - **Considered.** A wider model list.
  - **Decision.** Five current models — opus-4-7, opus-4-6, sonnet-4-6, sonnet-4-5, haiku-4-5. The legacy line is out of scope; pricing changes and capability matrices for sunset models add noise. New models go in as Anthropic ships them.

## Consequences

- **47 → 48 packages, +1 ADR (0053), +62 tests (5,490 → 5,552).** No new META_ tables — the provider is stateless client code.
- **Architect agent can now run.** `@crossengin/ai-architect` ships the policy + session contracts; this provider plugs into them. M5.5 (Architect chat command in `architect-cli`) can wire `AnthropicProvider` directly into the CLI's `chat` subcommand.
- **Pattern set for other providers.** OpenAI / Bedrock / Vertex providers (M2.8+) follow the same shape: pricing.ts → request-builder.ts → streaming.ts → errors.ts → provider.ts. Each is its own package, each implements `LlmProvider`, each plugs into the same router policy.
- **No SDK lock-in.** Pure `fetch` means the package runs identically in Node 22 / Bun / Deno / Cloudflare Workers / Vercel Edge. The `FetchLike` interface keeps testing painless — no module mocking, no `vi.mock`.
- **Token accounting is now real.** Previous packages stored `cost_usd` as a contract field; nothing populated it. The Architect's M5.5 + the gateway's `BILLING_USAGE_*` adapters can now write actual costs from `usage_final.usage.cost` — a chain that pays for itself.

## Open questions

- **Q1:** How does the router choose between models when multiple are configured?
  - _Current direction:_ Router policy from ADR-0027 — task affinity, cost ceiling, latency budget. The provider exposes capabilities + pricing; the router does the math.
- **Q2:** Where do per-tenant Anthropic API keys live?
  - _Current direction:_ `@crossengin/crypto.KeyStore` holds them as secret material; the router resolves per-tenant + constructs an `AnthropicProvider` per request (or caches per-tenant providers).
- **Q3:** Should the provider support Anthropic's `messages.batches` API (async high-volume jobs)?
  - _Current direction:_ Out of scope for M2.7. Phase 3 batch package handles async workloads — the synchronous + streaming surface here covers the Architect's interactive path.
- **Q4:** Does the provider need to bind to AWS Bedrock or Google Vertex versions of Claude?
  - _Current direction:_ No — those are different APIs with different auth (SigV4 / OAuth). M2.8 ships them as `@crossengin/ai-providers-bedrock` + `@crossengin/ai-providers-vertex` with their own pricing + auth flows.
- **Q5:** How does the provider report token caching savings?
  - _Current direction:_ `normalizeUsage` already splits `cachedInputTokens` from `inputTokens`, and `computeUsageCost` charges them at the cached rate. Consumers see the savings in the `Usage.cost` field; an optional `cacheBreakdown` field could expose the dollar diff if needed.
