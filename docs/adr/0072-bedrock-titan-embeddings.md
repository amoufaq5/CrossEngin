# ADR-0072: Bedrock Titan + Cohere embeddings (Phase 2 M2.9.5)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-18 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0071 (Bedrock provider M2.9), ADR-0060 (OpenAI provider — first real `embed()`), ADR-0059 (ai-router) |

## Context

M2.9 shipped `@crossengin/ai-providers-bedrock` with chat completion (converse + converse-stream) but punted on embeddings. `embed()` rejected with a typed error pointing callers at OpenAI's `text-embedding-3-small`. ADR-0071 Q4 explicitly called out this gap.

M2.9.5 closes the gap. The Bedrock provider now implements `embed()` against AWS's `InvokeModel` endpoint, supporting two model families:

- **Amazon Titan** (`amazon.titan-embed-text-v2:0` at $0.02/M, `amazon.titan-embed-text-v1` at $0.10/M)
- **Cohere** (`cohere.embed-english-v3` and `cohere.embed-multilingual-v3` at $0.10/M)

Why this matters:

1. **Closes Bedrock's capability gap.** With chat-only support, an operator routing through Bedrock for HIPAA / residency reasons had to break out to a different provider for embeddings (vector search, semantic indexing, similarity). Now all chat + embedding traffic for a tenant can stay inside their AWS account.
2. **Titan v2 is the cheapest embedding option in the workspace.** $0.02/M matches OpenAI's `text-embedding-3-small` exactly. The router can pick either based on residency, latency, or AWS gravity — same price, no cost-driven preference.
3. **Cohere multilingual coverage.** `cohere.embed-multilingual-v3` covers 100+ languages with one model. Useful for tenants serving non-English markets where OpenAI's models underperform.

Three constraints shaped the design:

- **Two wire formats, one Bedrock SDK.** Titan accepts only single-text input (`{inputText: "..."}`); Cohere accepts batches (`{texts: [...], input_type: "..."}`). The provider must dispatch on model family and either loop (Titan) or batch (Cohere). The caller still sees the uniform `EmbeddingRequest.texts: string[]` contract — the Bedrock-specific quirks are hidden.
- **No new endpoint, no new signing logic.** Both families use `POST /model/{modelId}/invoke` — same path shape as the chat endpoints, same sig v4 signing path from M2.9. The signing module doesn't change; the provider just calls a different model and parses a different response shape.
- **Pricing rounds at 6 decimals.** Same convention as M2.7 / M2.8 / M2.9 chat pricing. At $0.02/M for Titan v2, a single 4-character input (~1 token) costs $0.00000002 — well below the 6-decimal floor. Cost is `0` at small scales; this is documented behavior, not a bug.

## Decision

Three module changes + the existing provider class wired to use them.

### `pricing.ts` extensions

```ts
export const BEDROCK_EMBEDDING_MODELS = [
  "amazon.titan-embed-text-v2:0",
  "amazon.titan-embed-text-v1",
  "cohere.embed-english-v3",
  "cohere.embed-multilingual-v3",
] as const;

export const BEDROCK_EMBEDDING_PRICING: Record<BedrockEmbeddingModel, {inputUsdPerMillion: number}> = {
  "amazon.titan-embed-text-v2:0":  { inputUsdPerMillion: 0.02 },
  "amazon.titan-embed-text-v1":    { inputUsdPerMillion: 0.10 },
  "cohere.embed-english-v3":       { inputUsdPerMillion: 0.10 },
  "cohere.embed-multilingual-v3":  { inputUsdPerMillion: 0.10 },
};

export const BEDROCK_DEFAULT_EMBEDDING_MODEL: BedrockEmbeddingModel = "amazon.titan-embed-text-v2:0";

export function computeBedrockEmbeddingCost(model, inputTokens): number;
export function buildBedrockEmbeddingUsage(model, inputTokens): Usage;
export function isBedrockEmbeddingModel(value): value is BedrockEmbeddingModel;
export function isBedrockModel(value): value is BedrockModel;  // union of chat + embedding
```

Default model: `amazon.titan-embed-text-v2:0` (cheapest, AWS-native, 1024-dim default with 256/512 alternative dimensions). Operators wanting Cohere multilingual coverage opt in via `defaultEmbeddingModel: "cohere.embed-multilingual-v3"`.

### `embeddings.ts` — new module

`bedrockEmbeddingFamily(model)` classifies into `"titan"` or `"cohere"` — drives dispatch.

**Titan request builder:**

```ts
buildTitanEmbedRequest({model, text, dimensions?}) → 
  // v2: { inputText, dimensions: 1024 | 512 | 256, normalize: true }
  // v1: { inputText }  (no dimensions field; fixed 1536-dim)
```

Validates `dimensions ∈ {256, 512, 1024}` for v2 (Titan's enumerated set). Throws `BedrockError(invalid_request_error)` otherwise.

**Cohere request builder:**

```ts
buildCohereEmbedRequest({texts, inputType?}) →
  { texts: string[], input_type: "search_document" | "search_query" | "classification" | "clustering" }
```

Validates `texts.length ∈ [1, 96]` (Cohere's documented batch limit). Default `input_type: "search_document"` — the right choice for indexing-style workloads (RAG over docs); switchable per provider instance via `defaultCohereInputType: "search_query"` for query-side embeddings.

**Response parsers** (`parseTitanEmbedResponse` / `parseCohereEmbedResponse`): defensive on malformed bodies. Throw `BedrockError(api_error)` on missing `embedding` / `embeddings` arrays or non-object payloads. Default `inputTextTokenCount: 0` for Titan when missing.

**Aggregator** (`buildEmbeddingResponse({model, aggregation})`): wraps the collected `{vectors, dim, inputTokens}` into the kernel-level `EmbeddingResponse` with computed cost via `buildBedrockEmbeddingUsage`. Deep-copies vectors so callers can't mutate the response.

### `provider.ts` updates

`BedrockProvider` capabilities flip:

```ts
capabilities = {
  chat: true,
  streaming: true,
  toolUse: true,
  jsonMode: false,
  embedding: true,                  // ← was false
  maxContextTokens: 200_000,
  supportsThinking: false,
};
models = [...BEDROCK_CHAT_MODELS, ...BEDROCK_EMBEDDING_MODELS];  // 12 models total
```

Constructor gains three optional fields:

```ts
new BedrockProvider({
  // ... existing M2.9 options
  defaultEmbeddingModel?: BedrockEmbeddingModel,   // default: titan-embed-text-v2
  defaultEmbeddingDimensions?: number,             // titan v2: 256 | 512 | 1024 (default 1024)
  defaultCohereInputType?: CohereEmbedInputType,   // cohere: search_document (default) | _query | classification | clustering
});
```

`embed(req)` implementation:

1. Resolve model: `req.model ?? defaultEmbeddingModel`. Reject unknown model strings with `invalid_request_error`. Reject chat models passed as embedding models (e.g., `model: "anthropic.claude-..."` → typed error).
2. Reject empty `texts: []`.
3. Dispatch on family:
   - **Titan**: loop over texts; for each, build the request, sign + POST to `/model/{modelId}/invoke`, parse the response, accumulate vectors + `inputTextTokenCount` tokens.
   - **Cohere**: build one batched request, sign + POST, parse, extract `meta.billed_units.input_tokens` from the response (or fall back to `ceil(chars/4)` per text when the API omits it).
4. Aggregate into `EmbeddingResponse` via `buildEmbeddingResponse`.

Same sig v4 path as the chat endpoints — `signedFetch(input)` handles both.

## Cross-cutting invariants enforced

- **Same `LlmProvider.embed()` contract as M2.8.** `EmbeddingRequest.texts: string[]` → `EmbeddingResponse.{vectors, dim, model, usage}`. Callers don't need to know whether Bedrock loops or batches under the hood.
- **Family dispatch is exhaustive.** `bedrockEmbeddingFamily(model)` throws if neither prefix matches — adding a new embedding family (e.g., AI21 Jamba embeddings) requires updating the dispatcher AND adding a model class. Forced cohesion.
- **Token counts are real when the API reports them.** Titan returns `inputTextTokenCount`; Cohere returns `meta.billed_units.input_tokens`. The 4-chars-per-token approximation only runs when both are absent.
- **Cohere batch limit enforced client-side.** `COHERE_MAX_BATCH_SIZE = 96` matches AWS's documented limit. Rejecting at the SDK layer gives a clean `BedrockError` instead of a downstream `ValidationException` from Bedrock.
- **Dimensions validated against the documented Titan v2 enum.** `[256, 512, 1024]`. Reject `768` etc. with a typed error at request-build time.
- **Vectors are deep-copied at response boundary.** `buildEmbeddingResponse` clones each `[...v]` — caller mutations don't poison the internal aggregation.
- **No leaked credentials in error messages.** Same as M2.9 — AWS exception messages truncate to 480 chars; request bodies never appear in errors.

## Alternatives considered

- **Use Cohere's batch endpoint as the universal path, even for Titan (chunked client-side into singletons).**
  - **Pros.** One code path.
  - **Cons.** Titan really is single-input-only at the API level. There's no batch endpoint to hide. The N-call loop is unavoidable; pretending otherwise doesn't simplify the code.
  - **Decision.** Keep the two paths explicit. The dispatcher is 5 lines.

- **Parallelize Titan calls with `Promise.all`.**
  - **Considered.** A 96-text batch would take 96× the latency of a single call sequentially.
  - **Decision.** Sequential for now. Bedrock has per-account TPS limits + the rate limiter (M6.5's `CostTracker` cousin) doesn't yet track per-provider concurrency. Premature optimization. M2.9.6 can add `concurrency: number` to the Titan loop with a default of 4.

- **Skip Cohere entirely; ship only Titan in M2.9.5.**
  - **Considered.** Two model families is double the surface area; Cohere multilingual coverage could be a separate milestone.
  - **Decision.** Both. The batch path (Cohere) is the only meaningful difference from Titan; not implementing it would mean a future M2.9.6 just for batching. Better to land both together.

- **Expose `dimensions` on `EmbeddingRequest` so callers can vary it per request.**
  - **Considered.** The kernel `EmbeddingRequest` schema has only `model + texts + tenantId + sessionId`.
  - **Decision.** Use the provider-level `defaultEmbeddingDimensions` option for now. Per-request dimensions would require a kernel schema change; not worth it for a Bedrock-Titan-specific tunable. Re-evaluate if more providers (Voyage?) expose runtime-tunable dimensions.

- **Always normalize Titan vectors.**
  - **Decision.** Yes, we set `normalize: true` for v2. Most callers want unit vectors for cosine similarity. Operators wanting raw vectors can subclass or fork; not worth a config knob.

- **Aggregate token counts via separate `cacheReadInputTokens`-style breakdown for embeddings.**
  - **Considered.** OpenAI's `text-embedding-3-*` doesn't expose caching; neither does Bedrock.
  - **Decision.** Just `inputTokens + outputTokens: 0 + cost`. Same shape as OpenAI's embedding usage.

- **Refactor M2.9's `signedFetch` to a top-level helper for reuse beyond the provider class.**
  - **Considered.** The embeddings path also needs `signedFetch`.
  - **Decision.** Keep it private to `BedrockProvider`. The embedding methods are `embedViaTitan` + `embedViaCohere` on the same class; same instance, same `signedFetch`. No external consumer.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,259 tests** (+45 from M2.9.5; was 6,214 after M2.9). All green, zero type errors.
- **The router has a third real embedding source.** Today: OpenAI's `text-embedding-3-small/large` (M2.8). Now: Bedrock's `titan-embed-text-v2:0` (same $0.02/M), `titan-embed-text-v1`, `cohere.embed-english-v3`, `cohere.embed-multilingual-v3`. The router (M6.5) can split chat + embedding traffic across providers based on residency, latency, or AWS gravity.
- **AWS-native end-to-end story.** A tenant with strict residency requirements (HIPAA-bound healthcare org in `us-east-1`, EU GDPR-bound retail in `eu-west-1`) can now serve both chat completion AND vector search entirely inside their AWS account. No cross-cloud egress for the Architect's RAG pipeline or any other embedding workload.
- **Cohere multilingual fills a real gap.** OpenAI's embeddings underperform on non-English text. `cohere.embed-multilingual-v3` covers 100+ languages with documented quality. Tenants serving APAC / MENA / LATAM get a much better baseline.
- **Pattern set for embedding-capable providers.** Future providers (Vertex `textembedding-gecko`, Voyage AI, etc.) drop into the same `EmbeddingResponse` shape with no contract changes. Family dispatch (single vs batch wire format) is a per-provider implementation detail.
- **Cost math stays consistent.** Same 6-decimal `Number(value.toFixed(6))` rounding as chat. Same `Usage.outputTokens: 0` convention for embeddings.
- **M2.9 ADR-0071 Q4 resolved.** `embed()` no longer rejects — it actually routes to Titan or Cohere based on the model. The M2.9 docstring directing callers to OpenAI is now obsolete (but harmless — callers can still pass `model: "..."` to override).

## Open questions

- **Q1:** Should the router automatically prefer Titan v2 over OpenAI's small for `task: "embedding"` when both providers are configured?
  - _Current direction:_ No. Same price ($0.02/M), no inherent preference. Operators choose via `TaskPolicyMap.embedding = {primary: "bedrock/titan-embed-text-v2:0", fallback: ["openai/text-embedding-3-small"]}` or the reverse. The router stays mechanism, not policy.
- **Q2:** Should `EmbeddingRequest.dimensions` be added to the kernel schema?
  - _Current direction:_ Not yet. Today only Titan v2 supports runtime-tunable dimensions; OpenAI's models have fixed dimensions per model (`-small` = 1536, `-large` = 3072). Adding a per-request field for one provider's quirk is premature. Re-evaluate when a second provider exposes the knob.
- **Q3:** Cohere batches of > 96 — should we auto-chunk client-side?
  - _Current direction:_ No. Auto-chunking hides the cost of multiple round-trips. Callers wanting bigger batches handle it explicitly (e.g., a M9-notifications-runtime ingestion job iterates chunks of 96). The rejection at 97 is a clean signal.
- **Q4:** Titan parallelism — should the loop run N concurrent calls?
  - _Current direction:_ Sequential for now. Per-provider concurrency control is a future router/cost-tracker concern. M2.9.6 can add `titanConcurrency: number` (default 4) if real workloads hit latency walls.
- **Q5:** Should the family classifier be exposed publicly (`bedrockEmbeddingFamily(model)`)?
  - _Current direction:_ Yes, exported from `embeddings.ts`. Some callers (M9 notifications? observability?) might want to know whether to batch or loop before calling.
- **Q6:** What about Titan multimodal embeddings (`amazon.titan-embed-image-v1`)?
  - _Current direction:_ Out of scope. The kernel `EmbeddingRequest.texts: string[]` is text-only. Multimodal embeddings need a different schema (image bytes or URIs). M2.9.7 or later.
- **Q7:** Should `embed()` retry retryable errors (rate_limit / overloaded / network) like the router does for `complete()`?
  - _Current direction:_ No retries at the provider level. The router (`@crossengin/ai-router`'s `DefaultLlmRouter`) handles retry uniformly across `complete()` calls. `embed()` should get the same treatment — but the router today doesn't wrap `embed()`. That's an M6.5.x gap.
