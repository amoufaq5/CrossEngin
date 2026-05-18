# ADR-0076: Bedrock cacheControl + Titan parallelism (Phase 2 M2.9.6)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-18 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0071 (M2.9 Bedrock provider), ADR-0072 (M2.9.5 Titan + Cohere embeddings), ADR-0055 (M5.6 cacheControl field) |

## Context

M2.9 shipped chat completion against Bedrock; M2.9.5 added Titan + Cohere embeddings. Two follow-up gaps were called out:

- **ADR-0071 Q3:** the kernel-level `CompletionRequest.cacheControl` field (added in M5.6 to thread Anthropic-shaped prompt-caching hints through the request) was being dropped by the Bedrock provider. A planner doing 200k-token RAG via Bedrock-hosted Claude paid full price every turn instead of the 90%-off cached-input rate.
- **ADR-0072 Q4:** Titan embeddings are single-text-only at the API level. M2.9.5 looped over `texts: string[]` sequentially. A 100-document indexing job paid 100× the per-call latency (~50–100ms each) instead of the ~12.5× a 4-concurrent batch would cost.

Both gaps are now actionable because the underlying APIs support what the kernel-level surface promises:

- Bedrock's `converse` request shape accepts `cachePoint` content blocks in `system[]` and per-message `content[]` arrays. Anthropic-on-Bedrock + Claude 3.5+ + Opus 4 charge 10% of input for cached tokens (matching the first-party rate).
- AWS Bedrock has no per-account TPS limit that would prevent moderate (4–10) parallel calls to Titan. The N-call cost stays the same; only wall-clock latency drops.

## Decision

Two additive feature surfaces, both behind opt-in flags so M2.9.5 callers see no behavior change.

### 1. `cacheControl` → Bedrock `cachePoint` blocks

The kernel `CacheControl` field has four optional slots:

```ts
interface CacheControl {
  systemPrompt?: string;
  toolSchemas?: string;
  retrievedContext?: string;
  conversationHistory?: string;
}
```

The Bedrock-side translation in `buildBedrockConverseRequest`:

- **`systemPrompt` OR `toolSchemas`** set + non-empty `system` blocks present → append `{cachePoint: {type: "default"}}` to the end of `system`. (Bedrock caches everything before each cachePoint, including the tool definitions on the request envelope; one breakpoint covers both semantic slots.)
- **`conversationHistory`** set + `messages.length >= 2` → append a cachePoint block to the end of the second-to-last message's `content[]` array. (Marks all messages up to and including the previous turn as cacheable.) No-op for single-turn conversations.
- **`retrievedContext`** set + `messages.length >= 1` → append a cachePoint block to the end of the last message's `content[]` array. (Marks the full prompt — including any inline-injected context — as cacheable through the current turn.)

These three placements are independent — operators can set any combination. All four kernel slots map to at most three Bedrock cachePoint breakpoints (system + history + context).

Type changes:

```ts
export interface BedrockCachePointBlock {
  readonly cachePoint: { readonly type: "default" };
}
export const BEDROCK_CACHE_POINT: BedrockCachePointBlock = { cachePoint: { type: "default" } };

// Added to the discriminated union:
export type BedrockContentBlock =
  | BedrockTextContentBlock
  | BedrockToolUseContentBlock
  | BedrockToolResultContentBlock
  | BedrockCachePointBlock;          // NEW

export type BedrockSystemBlock = { text: string } | BedrockCachePointBlock;  // NEW
```

`extractTextFromConverseResponse` + `extractToolCallsFromConverseResponse` already discriminate on `"text" in block` + `"toolUse" in block`; cachePoint blocks fall through their existing filters. A regression test pins this — `extractTextFromConverseResponse([{text:"hello"}, {cachePoint:...}, {text:"world"}])` returns `"helloworld"`.

The non-streaming `BedrockConverseUsage` already exposes `cacheReadInputTokens` + `cacheWriteInputTokens` (M2.9). `buildBedrockUsage` folds the cached input into the cost calculation at the 10%-of-input rate via `BEDROCK_CHAT_PRICING[model].cachedInputUsdPerMillion`. No additional work needed for cost accounting — the markers just enable the savings; the existing pipeline reports them.

### 2. `titanConcurrency` constructor option

```ts
new BedrockProvider({
  // ...existing options
  titanConcurrency?: number,   // default 4, range [1, 100]
});
```

Construction-time validation: integer, `1 ≤ n ≤ 100`. Non-integer / out-of-range throws `BedrockProvider: titanConcurrency must be an integer in [1, 100], got X`.

`embedViaTitan` was a sequential `for (const text of texts)` loop in M2.9.5. M2.9.6 refactors it into a chunked-parallel loop:

```ts
for (let start = 0; start < texts.length; start += this.titanConcurrency) {
  const end = Math.min(start + this.titanConcurrency, texts.length);
  const chunk = await Promise.all(
    texts.slice(start, end).map((t) => callOne(t)),
  );
  for (let i = 0; i < chunk.length; i++) {
    results[start + i] = chunk[i]!;
  }
}
```

- `concurrency = 1` → exactly the M2.9.5 sequential behavior (regression-tested).
- `concurrency = 4` (default) → up to 4 in-flight Titan calls at a time; chunks of 4 from a 100-text input give ~25 round-trips instead of 100.
- Output order preserved by indexing into a pre-allocated array, NOT by relying on `Promise.all` completion order.
- Per-text tokens accumulated correctly even when calls complete out of order (each result carries its own token count; sum at end).

Cohere is untouched — its native batching handles up to 96 texts in one call, so client-side parallelism would just confuse the existing rate limits.

## Cross-cutting invariants enforced

- **cacheControl is opt-in.** Callers that don't set the field see byte-identical request bodies to M2.9.5. No silent behavior change.
- **cachePoint blocks are forward-compatible in extractors.** Future content-block kinds (Bedrock may add `image`, `video`, `documentReference` shapes) will fall through `"text" in block` / `"toolUse" in block` filters the same way cachePoint does.
- **Construction-time validation for titanConcurrency.** Out-of-range values throw at `new BedrockProvider(...)`, not at the first embed call. Operators learn immediately.
- **Input order preserved.** Tests assert that the response vector at index `i` corresponds to `texts[i]` even when calls complete out of order (stagger via per-call setTimeout).
- **Same `EmbeddingResponse` shape.** `usage.inputTokens` still sums across all calls; `usage.outputTokens === 0`; `cost` rounds at 6 decimals.
- **No new constructor option is required.** Existing M2.9.5 callers get the 4-way default automatically; opt-down to `concurrency: 1` for predictable single-threaded behavior.
- **Empty / single-message conversation is safe.** `conversationHistory` with `messages.length < 2` is a no-op (no penultimate message to mark).

## Alternatives considered

- **One cachePoint per kernel slot (four breakpoints).**
  - **Considered.** Map `systemPrompt` and `toolSchemas` to two separate cachePoints.
  - **Cons.** Bedrock evaluates cachePoints in order; a second cachePoint inside `system[]` after the first invalidates the first's cache scope. Conflating both kernel slots into one system-level breakpoint is the correct mechanical translation.
  - **Decision.** One breakpoint per Bedrock-side location (system / penultimate / last).

- **Add a `cacheControl.toolSchemas` → toolConfig-level cachePoint.**
  - **Considered.** Bedrock's `toolConfig` object accepts a `tools[]` array but no native cachePoint block at the toolConfig level (per the documented schema). Operators reading the docs might expect it.
  - **Decision.** Defer. The system-level cachePoint already covers tool-schema caching when tools appear before the system content. Moving tool definitions out of toolConfig into system blocks isn't supported by the Bedrock side.

- **Parallelize Cohere too.**
  - **Considered.** Cohere accepts batches up to 96; parallelizing > 96-text inputs into multiple parallel batched calls would help.
  - **Decision.** Defer. The kernel `EmbeddingRequest.texts` schema has no upper bound today; if operators pass > 96 texts, the current M2.9.5 code rejects with a clean `BedrockError(invalid_request_error)`. Auto-chunking + parallelizing into N batches is a separate design discussion (see ADR-0072 Q3).

- **Auto-detect cachable content from message length thresholds.**
  - **Pros.** Operators don't need to set `cacheControl` explicitly; the provider caches anything > 1024 tokens.
  - **Cons.** Implicit caching is a billing surprise. Operators who explicitly opt in via `cacheControl` are signaling acceptance of the 25%-premium cache-write cost on first-token-set.
  - **Decision.** Stay explicit. The kernel `cacheControl` field is opt-in by design.

- **Expose `titanConcurrency` as a per-request override on `EmbeddingRequest`.**
  - **Considered.** A bulk-indexing job might want 16-way concurrency while a one-off lookup wants 1-way.
  - **Decision.** Constructor-level only for now. Operators wanting per-call concurrency can construct two `BedrockProvider` instances (cheap — no connection pool, just credentials + region).

- **Add jitter / exponential backoff to Titan parallel calls if any individual call retries.**
  - **Considered.** Retry policy belongs at the router (`@crossengin/ai-router`), not the provider. The router can wrap `embed()` once it's surfaced through the LlmProvider contract.
  - **Decision.** Out of scope. The router doesn't wrap embed() today (cf. M2.9.5 Q7); when it does, retries get unified treatment.

- **Use a worker-pool abstraction (e.g., `p-limit`-style semaphore).**
  - **Considered.** More flexible than chunked Promise.all.
  - **Decision.** No new deps. Chunked Promise.all is 5 lines, has predictable memory characteristics (max `concurrency` Promises in flight), and matches the existing zero-dep pattern of M2.7 / M2.8 / M2.9.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,359 tests** (+15 from M2.9.6; was 6,344 after M4.7.6). All green, zero type errors.
- **Anthropic-on-Bedrock prompt caching is now real.** A planner doing 50k-token RAG via Claude 3.5 Sonnet on Bedrock pays $3/M for the first hit, then $0.30/M for every subsequent hit within the cache TTL. Same 90%-off rate as Anthropic's first-party API. Operators add `cacheControl: { conversationHistory: "...", retrievedContext: "..." }` to existing requests; nothing else changes.
- **Bulk-indexing Titan workloads are ~4× faster by default.** 100 documents through Titan v2 with the default `titanConcurrency = 4` finishes in ~25 round-trip-times instead of 100. Operators can tune higher (up to 100) when their Bedrock account quota allows.
- **Pattern set for future cacheable-content providers.** Vertex `gemini-1.5-pro` supports context caching with a similar API shape; when that provider lands, the kernel `cacheControl` field translates cleanly. Cohere on Bedrock will follow the same pattern when (if) its converse-API equivalent gains cache markers.
- **Cohere unchanged.** Cohere's batched embedding endpoint is unchanged in M2.9.6 — its native batch semantics already match the Titan-with-concurrency pattern.
- **No new META tables, no new packages.** Purely a `@crossengin/ai-providers-bedrock` extension. The Anthropic + OpenAI providers don't need changes (Anthropic already supports cacheControl natively via M2.7; OpenAI doesn't expose prompt caching markers in Chat Completions today).
- **M2.9 Q3 + M2.9.5 Q4 both closed.** Two ADR open questions resolved with a single PR; the bedrock provider now matches the first-party Anthropic provider's caching capabilities (the same Claude models behind a different control plane should behave the same).

## Open questions

- **Q1:** Should `cacheControl.toolSchemas` produce a separate cachePoint distinct from `systemPrompt`?
  - _Current direction:_ No — Bedrock's cachePoint evaluation is sequential and would conflict. One breakpoint per Bedrock-side location.
- **Q2:** Should the provider verify that the model supports cache markers before emitting them?
  - _Current direction:_ Not in M2.9.6. The cachePoint blocks are no-ops on models that don't support caching (Bedrock silently ignores them). Operators get no cost savings but no errors either.
- **Q3:** What about a `titanConcurrency` per-request override via `EmbeddingRequest`?
  - _Current direction:_ Constructor only. Operators wanting per-call control construct multiple providers.
- **Q4:** Should `embedViaCohere` also support client-side batching for > 96 texts?
  - _Current direction:_ Out of scope; see Alternatives. Future M2.9.7 if there's demand.
- **Q5:** Audit log of cache hits / misses?
  - _Current direction:_ Not in M2.9.6. The `usage.cachedInputTokens` field in `Usage` already surfaces the cache-hit token count; consumers can compute hit rate themselves. M8 observability can wrap this in a structured metric.
- **Q6:** Does `cacheControl` need versioning?
  - _Current direction:_ No. The field's optional slot values are opaque strings (treated as cache-key markers, not semantic content). Providers translate them into whatever shape their backend wants.
- **Q7:** Should the provider warn when `cacheControl` is set but the resolved model doesn't support caching?
  - _Current direction:_ Defer. The lifecycle is: model selection (router/CLI) → provider → cache markers. The router knows which models support caching; warning at the provider level requires a new capability flag. Future work.
