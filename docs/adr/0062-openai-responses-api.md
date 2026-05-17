# ADR-0062: OpenAI Responses API support (Phase 2 M2.8.5)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-17 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0060 (OpenAI provider), ADR-0053 (Anthropic provider), ADR-0055 (LlmMessage.toolUses) |

## Context

M2.8 shipped OpenAI's `/v1/chat/completions` path. OpenAI's newer `/v1/responses` endpoint covers the same models (gpt-4o family, o1, o3) but with three things the Chat Completions API doesn't:

1. **Server-side conversation state.** A `previous_response_id` field lets a follow-up request reference a prior turn instead of re-sending the full message history. For long agent chains the bandwidth savings matter.
2. **First-class reasoning output.** o1 / o3 / future thinking models emit a `reasoning` item alongside the assistant message — a server-summarized version of the chain-of-thought. The Chat Completions API surfaces those tokens only as opaque `completion_tokens`.
3. **Cleaner agentic shape.** Tool calls and tool results are top-level items in the `input` / `output` arrays instead of nested in message content. The model boundary between "say something" and "call a function" is more explicit.

M2.8.5 ships Responses API support as an **opt-in alternative path** on the existing `OpenAIProvider`, not a new provider class. Two reasons: the model surface is identical (same `gpt-4o-mini`, same pricing, same residency); only the wire format changes. And consumers should be able to switch a single config flag — `defaultApiPath: "responses"` — without changing their provider construction.

## Decision

Three new modules in `@crossengin/ai-providers-openai`, plus two new methods + two constructor options on the existing class:

### `responses-api.ts` — wire-format types + translator

- **`REASONING_EFFORTS`** = `["low", "medium", "high"]`. Used by the optional `reasoning.effort` field.
- **`OpenAIResponsesInputItem`** discriminated union: `message` items (`{role, content: [{type: "input_text", text}]}`), `function_call` items (`{type, call_id, name, arguments}`), `function_call_output` items (`{type, call_id, output}`).
- **`OpenAIResponsesOutputItem`** similar union but assistant messages use `output_text` blocks and add a `reasoning` item kind for thinking models.
- **`buildOpenAIResponsesRequest(req, opts)`** translates `CompletionRequest`:
  - System messages collapse into a single `instructions` field (joined with `\n\n` if multiple). The Responses API doesn't take system messages inline.
  - User messages → `{role: "user", content: [{type: "input_text", text}]}`.
  - Assistant messages with non-empty text → emit a `{role: "assistant", content: [{type: "input_text", text}]}` item.
  - Assistant `toolUses[]` → one `function_call` item per use (top-level, not nested in the assistant message).
  - Tool-role messages → `function_call_output` items keyed by `tool_call_id`.
  - Tools translate to `{type: "function", name, description, parameters: inputSchema}` (similar to Chat Completions but without the `function` wrapper object).
  - Optional `reasoningEffort`, `previousResponseId`, `store` flags.
- **`normalizeResponsesUsage(model, usage)`** — same shape as the Chat Completions normalizer but reads `input_tokens` / `output_tokens` / `input_tokens_details.cached_tokens` instead of `prompt_tokens` / `completion_tokens`.
- **`extractTextFromResponsesResponse(response)`** concatenates `output_text` blocks across all assistant messages.
- **`extractToolCallsFromResponsesResponse(response)`** pulls top-level `function_call` items with parsed JSON arguments.
- **`extractReasoningSummary(response)`** joins `summary_text` items from `reasoning` items. Returns `""` when none.

### `responses-streaming.ts` — named-event SSE parser

The Responses API uses **named events** (`event: response.output_text.delta`, etc.) instead of the unnamed Chat Completions format. The parser dispatches by event name:

- **`response.output_text.delta`** → `{kind: "text", text}` (the `delta` payload field).
- **`response.output_item.added`** with `function_call` item → `{kind: "tool_call_start", id, name}`. The state Map keys by the item's internal `id` so subsequent `function_call_arguments` deltas can find the buffer.
- **`response.function_call_arguments.delta`** → `{kind: "tool_call_arg_delta", id, delta}`.
- **`response.function_call_arguments.done`** / **`response.output_item.done`** → `{kind: "tool_call_end", id}`.
- **`response.completed`** carries the final `response.usage` snapshot, saved into state and emitted as `usage_final` at the end.
- Unclosed tool calls get a synthetic `tool_call_end` at stream end (defensive — Responses normally emits `.done` events explicitly).

`chunksFromResponsesSse(raw, model)` and `readResponsesSseStream(body, model)` mirror the Chat Completions counterparts, with the shared-state-across-buffer-fills pattern from M2.7.

### `provider.ts` — extended class

Two new constructor options:
- **`defaultApiPath: "chat" | "responses"`** — defaults to `"chat"` (preserves M2.8 behavior). When set to `"responses"`, the standard `complete(req)` method routes to the Responses API.
- **`reasoningEffort: "low" | "medium" | "high"`** — threaded into Responses requests when supplied. Ignored on the Chat Completions path.

Two new methods:
- **`completeViaResponses(req)`** — explicit Responses streaming, same signature as `complete`. Use when the provider's default is still `"chat"` but a specific call needs Responses semantics.
- **`respondNonStreaming(req)`** — one-shot Responses request, returns the full `OpenAIResponsesResponse` envelope (including reasoning summaries + per-item metadata).
- **`completeViaChat(req)`** — the existing M2.8 Chat Completions path, now exported as a named alternative method so consumers can be explicit even when the default is `"responses"`.

The class retains its `LlmProvider` shape — `complete()` still returns the discriminated `CompletionChunk` stream that any router or chat engine consumes. The Responses path is invisible to downstream code unless the consumer calls the API-specific methods directly.

**`summarizeResponsesResponse(response, model)`** is the Responses-shaped counterpart to `summarizeChatResponse`, packing `{text, toolCalls, reasoningSummary, status, usage}` for non-streaming consumers.

## Cross-cutting invariants enforced

- **The CompletionChunk discriminated union is unchanged.** No new "thinking" chunk kind. Reasoning summary lives on the non-streaming `OpenAIResponsesResponse` envelope and the `summarizeResponsesResponse` helper. Adding a `thinking` kind to `@crossengin/ai-providers` is a Phase 3 decision affecting every provider; M2.8.5 keeps the chunk surface stable.
- **System messages always collapse.** The Responses API has a single `instructions` field, not a system message role. Multiple system messages join with `\n\n` deterministically. Consumers writing per-turn system messages should expect them to merge.
- **Tool call IDs stay stable.** OpenAI's Responses API distinguishes between the internal item `id` (e.g., `"item_1"`) and the externally-visible `call_id` (e.g., `"call_1"`). The streaming parser keys its state Map by item id but emits `tool_call_start` / `tool_call_arg_delta` / `tool_call_end` with the `call_id` — matching the convention from M2.8's Chat Completions stream and Anthropic's `tool_use_id`.
- **`previous_response_id` is opt-in per request, not provider-level.** Threading conversation state through the server is an agent-pattern choice. The constructor takes no `previousResponseId`; the request-builder's option lets callers set it per call.
- **No router changes.** The router (M6.5) sees an `LlmProvider` with `complete(req)`. Whether `complete` internally routes to Chat Completions or Responses is invisible. Operators configuring `defaultApiPath: "responses"` get the new path automatically across every router call.

## Alternatives considered

- **Add a `thinking` CompletionChunk kind in `@crossengin/ai-providers`.**
  - **Pros.** First-class reasoning surface for all providers (Anthropic also has thinking; Bedrock + Vertex will too).
  - **Cons.** Touches every consumer + every provider. The chat engine, router, transcript, tests, and ADRs all need updates. Schema extension is a multi-package coordinated change.
  - **Decision.** Defer to a dedicated milestone. M2.8.5 keeps reasoning observable only on the non-streaming surface.

- **Create a separate `ResponsesOpenAIProvider` class.**
  - **Pros.** Clear separation; new class can deviate (e.g., reject embedding requests since Responses doesn't do embeddings).
  - **Cons.** Two classes with 90% overlap. Operators choosing Responses lose the existing class's embedding support.
  - **Decision.** One class, two paths. The same provider does Chat Completions OR Responses for chat plus Embeddings for vectors.

- **Default `defaultApiPath` to `"responses"`.**
  - **Considered.** Responses is the newer surface.
  - **Decision.** Default to `"chat"` for M2.8.5 — backward compatibility for existing operators using M2.8. The flag is one-line opt-in for those who want Responses.

- **Auto-route to Responses for `o1` / `o3` models.**
  - **Considered.** Thinking models benefit from Responses' reasoning summary.
  - **Decision.** Pass-through. The model is what the operator asked for; the API path is a separate decision. Future M2.8.6 could add a `routeByModel` heuristic if patterns emerge.

- **Surface reasoning summary as interleaved text chunks (prefixed `[reasoning] ...`).**
  - **Considered.** Lets the chat UI render reasoning inline.
  - **Decision.** Confusing — operators would see prefixed text mixed with the assistant's actual response. Reasoning belongs on a separate channel. For M2.8.5, it's only available via the non-streaming `summarizeResponsesResponse`.

- **Persist `previous_response_id` on the provider instance.**
  - **Considered.** Auto-chain conversations.
  - **Decision.** No — the chat engine already maintains the conversation in `LlmMessage[]`. Mixing server-side state with client-side state would confuse consumers. The request-builder's option lets advanced callers opt in.

- **Implement `respondNonStreaming` for embedding requests too.**
  - **Considered.** A uniform "non-streaming" API.
  - **Decision.** Embeddings already have a non-streaming `embed()` method. Adding a separate non-streaming chat method specifically for Responses is enough.

## Consequences

- **52 packages + 1 app, 119 meta-schema tables, 5,896 tests** (was 5,856; +40 tests, 0 new packages, 0 new META_ tables).
- **`@crossengin/ai-providers-openai` is the first multi-API-path provider.** The pattern can extend: future Anthropic `/v1/messages` vs `/v1/responses-style` (if Anthropic ships one); future Bedrock streaming vs streaming-converse.
- **o1 / o3 models become more useful.** Operators routing planner tasks to o3 via `taskPolicies.planner` can now opt their OpenAI provider into Responses for those calls and surface the reasoning summary in chat-trace dumps via the non-streaming helper.
- **The router doesn't need to know.** A `DefaultLlmRouter` configured with this provider gets Responses semantics automatically when the operator sets `defaultApiPath: "responses"`. Same chain, same cost ceilings, same retry behavior.
- **`previous_response_id` is exposed but unused by the chat substrate.** The architect-cli's chat engine still sends full history every turn. A future M6.7 or web-app milestone can opt in to server-side state for long sessions.

## Open questions

- **Q1:** Should `CompletionChunk` gain a `thinking` kind for cross-provider reasoning?
  - _Current direction:_ Defer. Phase 3 task. When it lands, the Responses streaming parser starts emitting `{kind: "thinking", text}` chunks from `response.reasoning_summary_text.delta` events (today they're ignored).
- **Q2:** How should `previous_response_id` integrate with the chat-engine?
  - _Current direction:_ Not in M2.8.5. The engine threads full conversations as `LlmMessage[]`. A future agent-runtime milestone could maintain a per-session `lastResponseId` and pass it as a provider option, dropping history sends for compatible providers.
- **Q3:** Should `defaultApiPath` accept `"auto"` (chooses based on model)?
  - _Current direction:_ Out of scope. Explicit beats implicit; operators picking Responses know why.
- **Q4:** Does the Responses path need its own pricing entry?
  - _Current direction:_ No. Same models, same per-token rates. The cost computation reuses `computeChatUsageCost`.
- **Q5:** How does this interact with the router's cost ceiling?
  - _Current direction:_ Transparently. The cost ceiling pre-flights against estimated tokens; the actual usage comes from the stream's final chunk. The Responses path emits `usage_final` the same way Chat Completions does — the router records cost identically.
