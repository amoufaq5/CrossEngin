# ADR-0077: Bedrock multimodal embeddings + image content blocks (Phase 2 M2.9.7)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-18 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0072 (M2.9.5 Titan + Cohere embeddings), ADR-0076 (M2.9.6 cacheControl + Titan parallelism), ADR-0071 (M2.9 Bedrock provider) |

## Context

ADR-0072 Q6 left multimodal embeddings (`amazon.titan-embed-image-v1`) explicitly out of scope: "The kernel `EmbeddingRequest.texts: string[]` is text-only. Multimodal embeddings need a different schema. M2.9.7 or later." Operators wanting vector search over screenshots, product photos, or scanned documents had to either keep text-only embeddings or wire a separate Bedrock client outside the platform.

Two distinct shapes need to land:

1. **Image embeddings.** `amazon.titan-embed-image-v1` takes EITHER text OR image OR both, returns a 256/384/1024-dim vector. Different billing model than text-only Titan: text at $0.80/M tokens (10x more expensive than `text-v2`'s $0.02/M), plus a flat $0.00006 per image. The two billing tracks compose for combined-input calls.
2. **Image content blocks for chat.** Bedrock `converse` accepts `{image: {format, source: {bytes}}}` content blocks alongside `{text}` / `{toolUse}` / `{toolResult}` / `{cachePoint}`. Claude 3.5+/Opus 4/Llama 3.2 Vision/etc. on Bedrock all consume them. The kernel `LlmMessage.content: string` is currently text-only, so wiring is partial — we land the type definitions + builder/extractor support now so a future M2.X kernel-extension milestone can flip the switch.

Three constraints shaped the scope:

- **No kernel schema changes in M2.9.7.** `EmbeddingRequest.texts: string[]` and `LlmMessage.content: string` stay text-only. Extending them is a cross-provider commitment (OpenAI's vision content blocks differ from Bedrock's differ from Anthropic's first-party API) and belongs in its own ADR.
- **Multimodal is a separate provider method.** `embedMultimodal(input)` is provider-native, NOT part of `LlmProvider.embed()`. Operators call it directly via the `BedrockProvider` instance. The router can't route to it (yet) — the router speaks the LlmProvider contract only.
- **Image content blocks ship as types + helpers + extractor support, NOT as `buildBedrockConverseRequest` wiring.** The translator can't add image blocks today because there's no kernel-side image data to translate from. But the type machinery, `buildBedrockImageBlock` factory, and `extractTextFromConverseResponse` skip-logic are all ready for the kernel extension.

## Decision

Three additive surfaces, all in `@crossengin/ai-providers-bedrock` — zero kernel changes.

### 1. Multimodal embedding model + pricing (`pricing.ts`)

```ts
export const BEDROCK_MULTIMODAL_EMBEDDING_MODELS = [
  "amazon.titan-embed-image-v1",
] as const;
export type BedrockMultimodalEmbeddingModel = ...;

export interface BedrockMultimodalEmbeddingPricing {
  readonly textUsdPerMillion: number;       // $0.80 per M
  readonly imageUsdPerImage: number;        // $0.00006 per image
}

export const BEDROCK_MULTIMODAL_EMBEDDING_PRICING = { /* per-model dual rates */ };

export function computeBedrockMultimodalEmbeddingCost(model, { textInputTokens, imageCount }) {
  return Number(((textInputTokens * textRate / 1_000_000) + (imageCount * imageRate)).toFixed(6));
}
export function buildBedrockMultimodalEmbeddingUsage(model, input): Usage;
export function isBedrockMultimodalEmbeddingModel(value): value is BedrockMultimodalEmbeddingModel;
```

`BedrockModel` union expands to include the multimodal model. `isBedrockModel` accepts all three families (chat / embedding / multimodal-embedding) — so the router (when wired) can classify any Bedrock model string correctly. The `Usage.inputTokens` slot holds the text-token count when text was supplied (0 otherwise); cost includes both tracks.

### 2. Multimodal embedding helpers (`embeddings.ts`)

```ts
export const TITAN_MULTIMODAL_VALID_DIMENSIONS = [256, 384, 1024];
export const TITAN_MULTIMODAL_DEFAULT_DIMENSIONS = 1024;

export function buildTitanMultimodalRequest({ text?, imageBase64?, dimensions? }): TitanMultimodalEmbedRequest;
export function parseTitanMultimodalResponse(raw): TitanMultimodalEmbedResponse;
```

Request validates: at least one of `text` or `imageBase64` must be non-empty; dimensions must be in the documented enum. Both checks throw `BedrockError(invalid_request_error)` at request-build time, before any network call.

Response parser captures the `message` field — non-null when Bedrock rejects the input (e.g., image too large, safety filter, malformed). The provider promotes a non-null message to `BedrockError(model_stream_error)`.

`MultimodalEmbeddingResult` is the public output shape:

```ts
{
  vector: readonly number[],
  dim: number,
  model: string,
  usage: { inputTextTokens, imageCount, cost },
}
```

### 3. `BedrockProvider.embedMultimodal(input)` (`provider.ts`)

```ts
async embedMultimodal(input: {
  model?: BedrockMultimodalEmbeddingModel,  // default: titan-embed-image-v1
  text?: string,
  imageBase64?: string,
  dimensions?: number,                       // 256 | 384 | 1024
}): Promise<MultimodalEmbeddingResult>
```

Flow: model defaults to `amazon.titan-embed-image-v1` (the only documented model in this family today). `buildTitanMultimodalRequest` validates and shapes the body. `invokeModelJson` reuses the M2.9.5 InvokeModel sig-v4 path (the helper's signature widened to accept `BedrockEmbeddingModel | BedrockMultimodalEmbeddingModel`). `parseTitanMultimodalResponse` extracts vector + token count + optional error message. If `message !== null`, throw `model_stream_error`; otherwise build the usage envelope.

`embed()` (the kernel-facing method) now rejects a `model: "amazon.titan-embed-image-v1"` argument with a clear redirect: "model 'X' is a multimodal embedding model — call embedMultimodal() instead". This catches the typo case where someone wires the multimodal model through the text-only router fallback.

### 4. Chat image content block types (`converse-api.ts`)

```ts
export const BEDROCK_IMAGE_FORMATS = ["png", "jpeg", "gif", "webp"] as const;

export interface BedrockImageContentBlock {
  readonly image: {
    readonly format: BedrockImageFormat;
    readonly source: { readonly bytes: string };  // base64-encoded
  };
}

export type BedrockContentBlock =
  | BedrockTextContentBlock
  | BedrockToolUseContentBlock
  | BedrockToolResultContentBlock
  | BedrockImageContentBlock     // NEW
  | BedrockCachePointBlock;

export function buildBedrockImageBlock({format, imageBase64}): BedrockImageContentBlock;
export function isBedrockImageFormat(value): value is BedrockImageFormat;
```

`extractTextFromConverseResponse` and `extractToolCallsFromConverseResponse` already discriminate via `"text" in block` / `"toolUse" in block`, so image blocks fall through their filters identically to cachePoint blocks (regression-tested). `buildBedrockImageBlock` validates `imageBase64.length > 0`; `BEDROCK_IMAGE_FORMATS` is the documented union from Bedrock's converse docs. No `buildBedrockConverseRequest` wiring — that comes when the kernel `LlmMessage` gains an `attachments?` or `content: ContentBlock[]` field.

## Cross-cutting invariants enforced

- **embedMultimodal is opt-in + provider-native.** Existing M2.9.5 callers see no behavior change in `embed()` beyond a new validation case (multimodal-via-text-only-router is rejected with a redirect instead of silently picking the wrong billing track).
- **Dual-billing cost is reported correctly.** Tests pin: 1M text tokens → $0.80; 1 image → $0.00006; combined → $0.80006. All rounded at 6 decimals.
- **Image content blocks are forward-compatible everywhere.** Both extractors (text + toolCalls) skip them via `"text" in block` / `"toolUse" in block` discrimination. cachePoint blocks added in M2.9.6 followed the same forward-compat pattern; same shape now applies to image blocks.
- **Multimodal-via-`embed()` is loud-fail.** Passing `amazon.titan-embed-image-v1` to `embed()` with `texts: string[]` would otherwise pick the wrong cost track ($0.80/M instead of $0.02/M) silently. The redirect error catches this at the kernel boundary.
- **Same `Usage`-shaped cost in MultimodalEmbeddingResult.** `inputTextTokens` slot mirrors `Usage.inputTokens`; `cost` is the same 6-decimal USD figure. Future ML observability tooling can consume both result shapes uniformly.
- **No kernel schema change.** `@crossengin/ai-providers` types untouched. `EmbeddingRequest` stays text-only. `LlmMessage` stays string-content. Cross-provider compat preserved.

## Alternatives considered

- **Extend `EmbeddingRequest` with `images?: ImageInput[]`.**
  - **Pros.** Multimodal becomes part of the LlmProvider contract; router can route image-embedding tasks.
  - **Cons.** OpenAI doesn't have multimodal embeddings (yet); Anthropic doesn't either. Extending the kernel schema for a single-provider capability would force the others to either no-op or reject. Better as a multi-provider commitment when ≥ 2 providers support it (Vertex `multimodalembedding` exists but isn't wired to a `LlmProvider` yet).
  - **Decision.** Defer to a future M2.X. M2.9.7 is provider-native only.

- **Extend `LlmMessage` with `attachments?: Array<{kind: "image", format, bytes}>`.**
  - **Pros.** Vision models on Bedrock + Anthropic + OpenAI could all be supported with one schema.
  - **Cons.** Anthropic uses `{type: "image", source: {type: "base64", media_type, data}}` content blocks; OpenAI uses `{type: "image_url", image_url: {url}}`; Bedrock uses `{image: {format, source: {bytes}}}`. The shapes diverge enough that a unified kernel schema would need to be the LOWEST common denominator (just bytes + format), which loses per-provider features (OpenAI URL refs, Anthropic media-type detection). Bigger design discussion than M2.9.7.
  - **Decision.** Defer. Land types + builder + extractor support now so a future M2.X has a target; don't extend the kernel schema unilaterally.

- **Stuff multimodal into `embed(req)` by adding `req.images?: string[]`.**
  - **Considered.** Routes naturally through the router.
  - **Cons.** Same as above — single-provider schema change at the kernel boundary.
  - **Decision.** Reject. Provider-native method.

- **Always include `imageCount` in `Usage.cachedInputTokens` (overloading that slot).**
  - **Cons.** Wrong semantics; `cachedInputTokens` is for prompt-cache hits, not image counts. Would confuse cost trackers.
  - **Decision.** `MultimodalEmbeddingResult.usage.imageCount` is a separate field on the dedicated result shape.

- **Auto-detect image format from base64 magic bytes.**
  - **Considered.** Operators wouldn't need to specify `format: "png" | "jpeg" | ...`.
  - **Cons.** False positives (operators sending TIFF or BMP would get png detected); silent failure mode.
  - **Decision.** Require explicit `format` parameter. Mirrors AWS's API requirement.

- **Validate base64 strictness in `buildBedrockImageBlock`.**
  - **Considered.** Reject non-base64 input early.
  - **Cons.** AWS rejects malformed images at the API boundary with a clear error. Adding client-side validation duplicates the check + risks false rejections (regex on base64 is non-trivial; padding is optional in some encoders).
  - **Decision.** Just length check (`imageBase64.length > 0`). Let AWS validate the content.

- **Support image URLs (not just inline base64).**
  - **Considered.** AWS does not support URL refs in `converse` — bytes only.
  - **Decision.** Mirror what AWS supports. URL ingestion is a separate concern (downstream tools fetch + base64-encode).

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,396 tests** (+37 from M2.9.7; was 6,359 after M2.9.6). All green, zero type errors.
- **Bedrock image embeddings are real.** A document-search workload can vectorize PDFs + product photos + screenshots via `provider.embedMultimodal({imageBase64})` with the same sig-v4 path and cost accounting as text embeddings. The 1024-dim output matches Titan v2's default — combined catalogs (text + image vectors in one index) work without dimension translation.
- **ADR-0072 Q6 closed.** Multimodal Titan v1 was the explicit open question; it now ships.
- **Chat image content blocks are type-ready for the kernel extension.** `BedrockImageContentBlock` is in the discriminated union; `buildBedrockImageBlock` constructs them; both extractors skip them. When a future M2.X extends `LlmMessage` with structured content, the Bedrock builder can flip on image-block emission with one switch.
- **Cohere image embeddings deferred.** Cohere `embed-multilingual-v3` doesn't support images today on Bedrock; if/when Cohere adds it, the same pattern (separate model in `BEDROCK_MULTIMODAL_EMBEDDING_MODELS`) extends cleanly.
- **The router doesn't know about multimodal yet.** `DefaultLlmRouter.embed()` proxies through the `LlmProvider.embed()` contract; multimodal goes through the provider-native method. A future M6.5.x could add `MultimodalLlmRouter` or extend the router contract.
- **Documented constraint surfaces clearly.** Operators wiring `model: "amazon.titan-embed-image-v1"` through the text-only `embed()` path get a clear redirect instead of mysterious billing.

## Open questions

- **Q1:** When should the kernel `LlmMessage` schema be extended to support image content?
  - _Current direction:_ When ≥ 2 providers support image input via their `LlmProvider.complete()` and we can converge on a kernel shape. The Bedrock types are ready; OpenAI's content-block shape is documented; Anthropic's first-party API uses base64 content blocks. A future M2.X ADR can converge.
- **Q2:** Should `embedMultimodal` accept multiple images per call (batched)?
  - _Current direction:_ No — Titan v1 multimodal is single-image-per-call. Batching would be client-side parallelization (like Titan v2 text). The current `embedMultimodal` takes one input; bulk workloads call it in a loop or wrap with `Promise.all`.
- **Q3:** What about Anthropic Claude vision on Bedrock?
  - _Current direction:_ Same `converse-stream` endpoint; same `BedrockImageContentBlock` shape. Once `LlmMessage` extends, vision works for any chat model that accepts image blocks via Bedrock. No additional ADR needed.
- **Q4:** Should `embedMultimodal` accept a URL + auto-fetch?
  - _Current direction:_ No. The provider is `fetch`-injectable for tests, but mixing arbitrary-URL fetching with sig-v4 AWS calls introduces a different threat surface (SSRF, internal-network exposure). Operators fetch + base64-encode in their own code.
- **Q5:** Should the multimodal model expose dimensions on the kernel surface?
  - _Current direction:_ Not via the kernel — provider-native `embedMultimodal` takes `dimensions` directly. Future kernel extension can add `outputDimensions?: number` to `EmbeddingRequest`.
- **Q6:** Audit log of image-embedding calls (PII/PHI concerns with image content)?
  - _Current direction:_ Out of scope. Image bytes never log; `inputTextTokenCount` + `imageCount` go into the cost report. M8 observability + healthcare-pack hooks can layer richer audit on top.
- **Q7:** Pricing freshness — Titan multimodal rates may change.
  - _Current direction:_ Same as M2.9.5's pricing note. `BEDROCK_MULTIMODAL_EMBEDDING_PRICING` is a const record; operators can monkey-patch or fork. A future M2.9.x ADR can refresh rates with an explicit cutoff date.
