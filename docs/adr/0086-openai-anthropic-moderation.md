# ADR-0086: OpenAI + Anthropic moderation surfaces (Phase 2 M2.X.6)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0084 (M2.9.8 Bedrock Guardrails), ADR-0085 (M2.9.8.x per-request override), ADR-0053 (M2.7 Anthropic), ADR-0060 (M2.8 OpenAI) |

## Context

M2.9.8 wired AWS Bedrock Guardrails into the Bedrock provider as an opt-in safety surface with a typed `BedrockGuardrailViolationError` thrown post-`usage_final`. The other two real LLM providers — OpenAI and Anthropic — also surface server-side content moderation, but with different shapes:

- **OpenAI Chat Completions** sets `finish_reason: "content_filter"` on the choice when the model's output (or the user's input) triggers OpenAI's built-in moderation. There's no per-request opt-in; the filter is always-on server-side. Operators don't configure it via the API — it's policy-bound to the API key + model.
- **Anthropic Messages API** sets `stop_reason: "refusal"` when the model explicitly declines to comply (different from `end_turn` / `max_tokens` / `tool_use` / `stop_sequence`). Same always-on shape; no per-request configuration.

Pre-M2.X.6, both providers silently emitted these signals with no typed error. Consumers had to crack open the raw response shape and check the field manually. For regulated workloads using the router across all three providers, that asymmetry is operationally painful: catch `BedrockGuardrailViolationError` for one provider, manually probe `finish_reason` / `stop_reason` for the other two.

The design constraints:

- **Match M2.9.8's pattern.** Streaming throws after `usage_final`; non-streaming returns the raw response + ships a discriminator helper.
- **No opt-in config.** Neither OpenAI nor Anthropic offers request-level moderation configuration today; the safety detection is always-on. M2.9.8.x's three-state override (config/null/undefined) has no analog here.
- **No new kernel-level types.** Each provider defines its own moderation error class; cross-provider abstraction is deferred (ADR-0084 Q7) and shouldn't drive M2.X.6's design.
- **Extend the existing error class hierarchy.** `OpenAIContentFilteredError extends OpenAIError`; `AnthropicRefusalError extends AnthropicError`. `instanceof <ProviderError>` keeps working; new error kinds discriminate.

## Decision

Six coordinated changes across the two providers + this ADR.

### 1. New `moderation.ts` module per provider

**OpenAI** (`@crossengin/ai-providers-openai/src/moderation.ts`):
```ts
export const OPENAI_CONTENT_FILTER_FINISH_REASON = "content_filter" as const;
export function isContentFilterFinishReason(reason: string | null): boolean;
export function isContentFilteredResponse(response: OpenAIChatResponse): boolean;

export class OpenAIContentFilteredError extends OpenAIError {
  readonly finishReason: "content_filter";
  // kind: "content_filtered"
}
```

**Anthropic** (`@crossengin/ai-providers-anthropic/src/moderation.ts`):
```ts
export const ANTHROPIC_REFUSAL_STOP_REASON = "refusal" as const;
export function isRefusalStopReason(reason: string | null | undefined): boolean;
export function isRefusalResponse(response: AnthropicResponse): boolean;

export class AnthropicRefusalError extends AnthropicError {
  readonly stopReason: "refusal";
  // kind: "refusal"
}
```

Both classes extend the provider's base error class. Both `kind` values are added to the provider's `*_ERROR_KINDS` const tuple. Neither is in `RETRYABLE_KINDS` — moderation outcomes are deterministic; retrying won't help.

### 2. Schema extension: `AnthropicResponse.stop_reason`

Pre-M2.X.6: `"end_turn" | "max_tokens" | "stop_sequence" | "tool_use"`.

Post-M2.X.6: union also includes `"refusal"`.

The OpenAI `OpenAIChatResponse.choices[].finish_reason` already included `"content_filter"` — no schema change needed.

### 3. Streaming detection (both providers)

Both providers' streaming generators (`chunksFromSse` / `readSseStream`) now:

1. Track a `contentFiltered: boolean` / `refused: boolean` in stream state.
2. At the appropriate event (`finish_reason: "content_filter"` for OpenAI / `message_delta.delta.stop_reason: "refusal"` for Anthropic), set the flag but DON'T throw yet.
3. After yielding `usage_final` normally, throw the typed error.

Consumer ordering for both:
1. text/tool chunks (if any)
2. `usage_final` (cost accounting flows)
3. **end of stream**
4. typed moderation error thrown

This is the exact pattern from M2.9.8. Operators using `for await` see partial text + final usage, then the catch handler runs.

### 4. Non-streaming response inspection

Both providers' `completeNonStreaming` continues to return the raw response. Consumers call `isContentFilteredResponse(res)` / `isRefusalResponse(res)` to detect. No exception is thrown — same asymmetry M2.9.8 documented: streaming has no final structured envelope to inspect, so throwing is the signal; non-streaming hands the envelope back and lets the caller decide.

### 5. Index exports

Both packages' `index.ts` re-exports the new `moderation.js` module. `OpenAIContentFilteredError`, `AnthropicRefusalError`, the helpers, and the constants are public.

### 6. Cross-provider error landscape

Before M2.X.6:
- Bedrock: `BedrockGuardrailViolationError` (kind: `guardrail_intervened` | `content_filtered`)
- OpenAI: (no typed moderation error)
- Anthropic: (no typed moderation error)

After M2.X.6:
- Bedrock: `BedrockGuardrailViolationError` (kind: `guardrail_intervened` | `content_filtered`)
- OpenAI: `OpenAIContentFilteredError` (kind: `content_filtered`)
- Anthropic: `AnthropicRefusalError` (kind: `refusal`)

All three providers throw non-retryable typed errors on moderation events in streaming mode. The router's `isRetryable()` check correctly stops retrying. The shared `content_filtered` kind name across Bedrock + OpenAI is intentional — operators classifying logs by `error.kind === "content_filtered"` get matching coverage across two providers.

## Cross-cutting invariants enforced

- **Streaming throws after `usage_final`.** Verified by test for both providers: chunks include the text emitted before moderation + the final usage chunk; then the typed error is thrown.
- **Non-streaming returns raw response.** No throw; callers use `isContentFilteredResponse` / `isRefusalResponse` to discriminate.
- **Both new errors are non-retryable.** Verified by test: `isRetryable()` returns `false`.
- **`instanceof <ProviderError>` works for the moderation subclasses.** Existing catch-all handlers keep working without changes.
- **Existing tests unchanged.** The pre-M2.X.6 behavior for non-moderation paths is byte-identical. Verified by both providers' existing test suites (`chunksFromSse — text streaming` continues to pass without modification).
- **No kernel changes.** `CompletionRequest`, `CompletionChunk`, `LlmProvider` interface — all untouched.

## End-to-end semantics

**OpenAI streaming:**
```ts
try {
  for await (const chunk of openaiProvider.complete(req)) {
    if (chunk.kind === "text") emit(chunk.text);
    if (chunk.kind === "usage_final") logCost(chunk.usage.cost);
  }
} catch (err) {
  if (err instanceof OpenAIContentFilteredError) {
    auditViolation("openai", err.finishReason);
  } else {
    throw err;
  }
}
```

**OpenAI non-streaming:**
```ts
const res = await openaiProvider.completeNonStreaming(req);
if (isContentFilteredResponse(res)) {
  auditViolation("openai", "content_filter");
}
```

**Anthropic streaming:**
```ts
try {
  for await (const chunk of anthropicProvider.complete(req)) {
    if (chunk.kind === "text") emit(chunk.text);
    if (chunk.kind === "usage_final") logCost(chunk.usage.cost);
  }
} catch (err) {
  if (err instanceof AnthropicRefusalError) {
    auditViolation("anthropic", err.stopReason);
  } else {
    throw err;
  }
}
```

**Anthropic non-streaming:**
```ts
const res = await anthropicProvider.completeNonStreaming(req);
if (isRefusalResponse(res)) {
  auditViolation("anthropic", "refusal");
}
```

## Alternatives considered

- **Add a kernel-level `ContentModerationError` that wraps all three providers' moderation errors.**
  - **Considered.** ADR-0084 Q7 — operators catching one error type across all three providers.
  - **Cons.** Premature abstraction. Each provider's surface has different fidelity (Bedrock has trace details + guardrailIdentifier; OpenAI just has a finish_reason; Anthropic just has a stop_reason). A kernel abstraction would lose information. Three concrete error classes + shared `kind` naming convention is enough today.
  - **Decision.** Provider-specific classes. Cross-provider abstraction stays deferred.

- **Implement OpenAI Moderations API (`POST /v1/moderations`) as a separate `provider.moderate(input)` method.**
  - **Considered.** Lets operators pre-check user input before paying for a chat completion.
  - **Cons.** Scope creep. The Moderations API is a separate billed endpoint with its own response shape (categories, scores per item). Adding it to M2.X.6 would double the surface. Defer to M2.X.6.x.
  - **Decision.** In-band detection only (finish_reason / stop_reason). Standalone moderation endpoint is future M2.X.6.x.

- **Anthropic: detect refusal via heuristic on the text content (e.g. "I cannot...").**
  - **Considered.** Pre-`stop_reason: "refusal"` Anthropic versions returned refusals as normal text. Heuristic-based detection would catch those.
  - **Cons.** Heuristics are brittle and locale-specific. Anthropic now ships `stop_reason: "refusal"` as the authoritative signal; relying on that is correct + future-proof.
  - **Decision.** Use `stop_reason` only. If older models lack the field, they pre-date M2.X.6's scope.

- **OpenAI: scan ALL choices, not just `choices[0]`.**
  - **Implemented.** `isContentFilteredResponse` uses `.some()` across all choices. Non-streaming API rarely returns multiple choices today, but the helper is correct if `n > 1` is ever used.

- **Bedrock-style opt-in `moderationConfig` constructor option.**
  - **Considered.** Symmetry with M2.9.8.
  - **Cons.** Neither OpenAI nor Anthropic exposes request-level moderation configuration via their primary chat endpoints. The opt-in shape would be vestigial — there's nothing to configure today.
  - **Decision.** No constructor option. If OpenAI / Anthropic ship configurable moderation later, this can be revisited.

- **Wrap the SSE stream's iterator in a try/catch and convert any thrown moderation error into a chunk kind.**
  - **Considered.** Avoids the post-`usage_final` throw — moderation becomes a streaming event.
  - **Cons.** Requires extending `CompletionChunk` (kernel surface) with a moderation chunk kind. M2.9.8 explicitly rejected this; M2.X.6 should match.
  - **Decision.** Throw. Same pattern as Bedrock.

- **Throw at the moderation event time, BEFORE `usage_final`.**
  - **Considered.** Simpler — the error reaches the consumer immediately.
  - **Cons.** Loses cost accounting. Tokens were processed (and billed) up to the moderation event; the operator needs the usage signal to track that.
  - **Decision.** Throw after `usage_final`.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,567 tests** (+23 from M2.X.6: 9 OpenAI moderation + 8 Anthropic moderation + 2 streaming detection + 2 error retryable + 2 stream non-throw). All green, zero type errors.
- **Production-grade safety story closed across all three real providers.** Bedrock had it from M2.9.8; OpenAI + Anthropic now match.
- **Consistent error shape.** All three providers throw a typed error extending their respective base error class, with `kind` distinguishing the moderation event from other failures.
- **ADR-0084 Q7 is now answerable with real data.** With three providers having distinct moderation error classes that share the `kind` discriminator pattern, a kernel-level `ContentModerationError` (or a `MODERATION_ERROR_KINDS` cross-provider tuple) is a viable future M2.X.6.x.
- **Router is unchanged.** Existing retryable-vs-permanent classification flows correctly — both new kinds are in the non-retryable set; the router stops on first attempt.
- **Pattern set for future Bedrock-like opt-in if Anthropic / OpenAI ship configurable moderation.** Each provider's `moderation.ts` already has a focal module; adding a `<Provider>ModerationConfig` would slot in cleanly.

## Open questions

- **Q1:** Should OpenAI's Moderations API (`POST /v1/moderations`) be exposed as `provider.moderate(input)`?
  - _Current direction:_ Deferred to M2.X.6.x. The standalone endpoint has a different response shape (categories + scores) and different billing; warrants its own milestone.
- **Q2:** Should Anthropic refusals carry the refusal explanation text in the error?
  - _Current direction:_ The text is already in the chunks the consumer received (text chunks emitted before refusal). Duplicating it on the error would be redundant.
- **Q3:** Cross-provider `ContentModerationError` abstraction (closes ADR-0084 Q7)?
  - _Current direction:_ Future M2.X.6.x. Could ship as a kernel-level marker interface (`HasModerationKind`) or as a typed union. Want to see whether the third party of "kind shape" stabilizes before standardizing.
- **Q4:** Should the chat substrate auto-log moderation events to a future audit table?
  - _Current direction:_ Out of scope. The chat substrate has the typed error in catch handlers; downstream audit is the consumer's call. Future M5.x could add an audit hook.
- **Q5:** Should the router prefer non-moderating providers on retry?
  - _Current direction:_ No. Moderation events are deterministic per-input, not random; switching providers won't help if the input is genuinely policy-violating. Operators wanting workarounds use per-request overrides (Bedrock) or content rewriting (out of scope).
- **Q6:** Per-tenant policy: route to stricter moderation for specific tenants?
  - _Current direction:_ Bedrock has this via M2.9.8.x. OpenAI / Anthropic don't expose configurable moderation today; if they do later, this would slot in alongside.
- **Q7:** Should `OpenAIContentFilteredError` carry the index of the filtered choice (`choices[i]`)?
  - _Current direction:_ The current model returns `choices[0]` typically. If multi-choice (`n > 1`) becomes common, surface the index then.
