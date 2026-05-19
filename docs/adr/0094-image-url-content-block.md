# ADR-0094: ImageUrlContentBlock — URL-based image inputs (Phase 2 M2.X.5.y)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0093 (M2.8.6 Responses API image inputs), ADR-0088 (M2.X.5 content union), ADR-0078 (M2.X attachments + vision) |

## Context

M2.X.5 introduced `ImageContentBlock` with base64-encoded bytes:

```ts
{ type: "image", format: ImageAttachmentFormat, bytes: string }
```

That works for inline image data — operators reading a local file or receiving an image from an upstream service encode it once and inline it. But for the common case of "the image already lives somewhere accessible" (CDN, S3, application image gallery, public URL), inlining means:

1. **Fetching the bytes ourselves** before constructing the request. Adds latency, bandwidth, and complexity.
2. **Bloating the request payload.** A 5 MB image becomes ~6.7 MB of base64 in the JSON body.
3. **Losing provider-side optimization.** OpenAI + Anthropic both accept URL inputs natively — they can fetch the image their side, often faster + cheaper than client-side.

ADR-0093 Q1 noted this gap. M2.X.5.y adds the URL variant.

## Decision

Three coordinated changes.

### 1. New `ImageUrlContentBlock` type

```ts
export const ImageUrlContentBlockSchema = z.object({
  type: z.literal("image_url"),
  url: z.string().url(),
  format: ImageAttachmentFormatSchema.optional(),
});
export type ImageUrlContentBlock = z.infer<typeof ImageUrlContentBlockSchema>;
```

Discriminated by `type: "image_url"` (distinct from `type: "image"` to keep the discriminated union working without merging variants). `url` is validated as a parseable URL. `format` is optional — providers that need a format hint can use it; URL-based images typically have the format implied by Content-Type / extension.

### 2. `LlmContentBlockSchema` union extension

```ts
export const LlmContentBlockSchema = z.discriminatedUnion("type", [
  TextContentBlockSchema,
  ImageContentBlockSchema,       // existing — bytes-based
  ImageUrlContentBlockSchema,    // new — URL-based
  ToolUseContentBlockSchema,
  ToolResultContentBlockSchema,
]);
```

Five variants total. Existing M2.X.5/M2.X.5.x consumers continue to work — `image` (bytes) blocks remain valid; `image_url` blocks are additive.

### 3. Role validation extends to image_url

The existing `image not on tool` rule extends:

```ts
if ((b.type === "image" || b.type === "image_url") && m.role === "tool") {
  ctx.addIssue({
    path: ["content", i],
    message: "image content blocks are not allowed on tool messages",
  });
}
```

Same rationale: tool messages are text-only by convention.

### 4. Per-provider translation

Each provider's `translateKernelBlock` (or equivalent) handles `image_url` per their native support:

- **OpenAI Chat Completions**: `image_url` → `{type: "image_url", image_url: {url: block.url}}`. The URL passes through unchanged (OpenAI fetches it server-side).
- **OpenAI Responses API**: `image_url` → `{type: "input_image", image_url: block.url}`. Same pass-through pattern; the field is a single string per the Responses API shape.
- **Anthropic**: **throws.** Anthropic's image content blocks require `source: {type: "base64", media_type, data}` — they don't accept URLs in the messages content array (the [vision API](https://docs.anthropic.com/en/docs/build-with-claude/vision) explicitly requires base64). Operators with URL-based images must fetch + encode client-side.
- **Bedrock**: **throws.** Bedrock's image content blocks take `source: {bytes}` (base64) only. Same operator workflow as Anthropic.

The thrown error message tells operators what to do:

```
Bedrock provider does not support image_url content blocks —
pre-fetch the URL to base64 bytes and use an image block instead
```

This is explicit + actionable. Operators routing mixed content to multiple providers know up-front to pre-fetch when targeting Bedrock or Anthropic.

## Cross-cutting invariants enforced

- **`image_url` is additive.** Existing `image` (bytes) blocks continue to work. All pre-M2.X.5.y tests (6,713) pass unchanged.
- **`url` is URL-validated at schema parse time.** Operators sending malformed URLs fail fast.
- **`format` is optional on URL variant.** URL-based images typically have format implied; bytes-based images need it explicit for media-type construction.
- **Tool-message rule extends.** `image_url` blocks are not allowed on tool role — same as `image` blocks.
- **Throw-on-unsupported-provider semantics.** Bedrock + Anthropic throw a clear error pointing operators at the bytes-based variant. No silent dropping; no surprise behavior.
- **OpenAI Chat Completions + Responses API pass URLs through to native fields.** Verified by tests for both API paths.

## End-to-end semantics

```ts
// Inline bytes (pre-M2.X.5.y) — still works:
const bytesMsg: LlmMessage = {
  role: "user",
  content: [
    { type: "text", text: "describe" },
    { type: "image", format: "png", bytes: pngBase64 },
  ],
};

// URL variant (M2.X.5.y) — works on OpenAI providers:
const urlMsg: LlmMessage = {
  role: "user",
  content: [
    { type: "text", text: "describe" },
    { type: "image_url", url: "https://example.com/cat.png" },
  ],
};

// Bedrock + Anthropic with image_url → throws with clear error message
// → Operators pre-fetch the URL to bytes and use { type: "image" } instead
```

## Alternatives considered

- **Merge `image` and `image_url` into one block with a `source` field discriminator.**
  - **Considered.** Anthropic-style: `{ type: "image", source: { type: "base64" | "url", ... } }`.
  - **Cons.** Breaks the existing flat `{type, format, bytes}` shape — 11 production sites + 30+ test fixtures would need restructuring. Backwards-compat hit is too large for the value.
  - **Decision.** Keep `image` flat (bytes); add `image_url` as a separate variant.

- **Auto-fetch URLs at request-build time for providers that don't support URLs.**
  - **Considered.** Operators get URL ergonomics across all providers.
  - **Cons.** Major scope creep — fetching introduces async build steps, fetch-error handling, retry policy, timeout config, host-allowlist (SSRF concerns), Content-Type inference, caching. None of that is a provider's job.
  - **Decision.** Throw with a clear error. Operators handle the fetch in their own layer (which gives them full control over caching, timeouts, security).

- **Silently fall back to text-only content when image_url isn't supported.**
  - **Considered.** Lossy but doesn't break.
  - **Cons.** Operators with vision-dependent prompts would silently get incorrect responses. Throwing makes the misconfiguration visible.
  - **Decision.** Throw.

- **Lazy URL fetching (the provider fetches inline at request time).**
  - **Considered.** Encapsulates the fetch behind the provider boundary.
  - **Cons.** Same scope-creep concerns as eager auto-fetch + adds latency to every Bedrock/Anthropic call with URLs. Operators with cached pre-fetched bytes get worse perf than operators who passed bytes directly.
  - **Decision.** Throw. Pre-fetching is the operator's call.

- **Add a `detail: "low" | "high" | "auto"` field to the URL variant (matches OpenAI's image-input detail level).**
  - **Considered.** Lets operators control vision processing cost.
  - **Cons.** Provider-specific concern. The kernel shape stays generic; per-provider tuning belongs in provider-specific request shaping.
  - **Decision.** Out of scope. Future M2.X.5.z if demand surfaces.

- **Accept `format` as required on URL variant for consistency with bytes variant.**
  - **Considered.** Single shape.
  - **Cons.** URL responses have Content-Type that tells the provider the format. Requiring operators to repeat it is redundant.
  - **Decision.** `format` optional on URL variant; required on bytes variant.

- **Validate URLs against an allowlist (no localhost, no internal IPs)?**
  - **Considered.** Defense against SSRF from operators who don't sanitize.
  - **Cons.** Kernel doesn't know what the operator's deployment looks like. An allowlist is deployment-specific. Operators who care implement it at their boundary.
  - **Decision.** Schema validates URL structure only.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,726 tests** (+13 from M2.X.5.y: 8 kernel + 2 OpenAI chat + 1 OpenAI Responses + 1 Bedrock + 1 Anthropic). All green, zero type errors.
- **ADR-0093 Q1 closed.** URL-based images are first-class on OpenAI providers (both API paths).
- **Provider asymmetry is documented + thrown.** Bedrock + Anthropic operators see an explicit "pre-fetch to bytes" message instead of a silent failure or weird HTTP error.
- **Payload size + latency reduction for OpenAI users.** A 5 MB image URL is 100 bytes in the request vs ~6.7 MB inline.
- **Pattern set for future URL-only variants.** When `audio_url` or `video_url` blocks ship, the same shape applies: new discriminated variant + per-provider translation + throw on unsupported.
- **`LlmContentBlockSchema` discriminated union grew to 5 variants.** Downstream code that exhaustively switches on `type` should compile-error and force handling.
- **No changes required for chat substrate or router.** The kernel-level addition flows transparently; consumers iterating blocks need exhaustive handling but the union shape is the same pattern.

## Open questions

- **Q1:** Should the kernel ship a `pre-fetch URL → bytes` helper to ease the operator burden when targeting Bedrock/Anthropic?
  - _Current direction:_ Out of scope. The fetch involves choices (timeout, retry, caching, allowlist) that belong in operator code. A reference implementation could be a docs-only example.
- **Q2:** What about `detail` level (`low | high | auto` on OpenAI's input_image)?
  - _Current direction:_ Provider-specific knob; would require kernel extension. Defer to M2.X.5.z if operators ask.
- **Q3:** Should Anthropic's URL-source `{type: "url", url}` shape (recently shipped) be supported via this variant?
  - _Current direction:_ Yes, future M2.X.5.z. Anthropic added URL support in their content blocks API; the translator throw should become a passthrough. Tracked as a follow-up.
- **Q4:** Should the OpenAI Moderations API (M2.X.8) accept image URLs via this variant?
  - _Current direction:_ Out of scope. Moderations API currently text-only via the kernel. Multimodal moderation is M2.X.8.x.
- **Q5:** A `url` field on the existing bytes-based `ImageContentBlock` as an alternative source?
  - _Current direction:_ Rejected — see "merge into one block" alternative. Two clean variants are simpler than one with optional fields.
- **Q6:** Validation against a content-type allowlist when format is omitted?
  - _Current direction:_ Out of scope. Providers do their own content-type validation server-side.
- **Q7:** Should we ship a typed builder `imageUrl({url, format?}): ImageUrlContentBlock`?
  - _Current direction:_ Object literals are concise enough. Builders are syntactic sugar; add if call sites get noisy.
