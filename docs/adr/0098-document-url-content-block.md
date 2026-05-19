# ADR-0098: DocumentUrlContentBlock — URL-based document inputs (Phase 2 M2.X.5.aa.y)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0097 (M2.X.5.aa DocumentContentBlock), ADR-0094 (M2.X.5.y ImageUrlContentBlock), ADR-0096 (M2.X.5.z Anthropic URL source) |

## Context

M2.X.5.aa added `DocumentContentBlock` with inline base64 bytes. ADR-0097 Q2 noted that Anthropic supports URL-source documents via `source: {type: "url", url}` — same shape as their URL image variant from M2.X.5.z. The bytes-only kernel surface forced operators with URL-accessible PDFs to fetch + encode themselves.

M2.X.5.aa.y adds `DocumentUrlContentBlock`, completing the bytes + URL parity for documents that M2.X.5.y established for images.

Provider URL support today:
- **Anthropic** — `{type: "document", source: {type: "url", url}, title?}` natively
- **Bedrock** — base64 bytes only; no URL source variant
- **OpenAI Responses** — `input_file` accepts `file_data` (base64) or `file_id` (uploaded), but no direct URL field
- **OpenAI Chat** — no document support of any kind

Same asymmetry as image URLs: only Anthropic supports document URLs natively today.

## Decision

Five coordinated changes (matching the M2.X.5.y image_url pattern).

### 1. New `DocumentUrlContentBlock` type

```ts
export const DocumentUrlContentBlockSchema = z.object({
  type: z.literal("document_url"),
  url: z.string().url(),
  format: DocumentFormatSchema.optional(),
  name: z.string().max(120).optional(),
});
```

Discriminated by `type: "document_url"` (distinct from `type: "document"`). `url` validated as a parseable URL. `format` + `name` both optional — Anthropic infers format from URL response Content-Type.

### 2. Discriminated union extension

```ts
LlmContentBlockSchema = z.discriminatedUnion("type", [
  TextContentBlockSchema,
  ImageContentBlockSchema,
  ImageUrlContentBlockSchema,
  DocumentContentBlockSchema,
  DocumentUrlContentBlockSchema,        // new
  ToolUseContentBlockSchema,
  ToolResultContentBlockSchema,
]);
```

Seven variants total.

### 3. Role validation extends

The existing "document not on tool" rule extends:
```ts
if ((b.type === "document" || b.type === "document_url") && m.role === "tool") {
  ctx.addIssue({...});
}
```

### 4. Per-provider translation

- **Anthropic** — emits `{type: "document", source: {type: "url", url}, title?}`. Native passthrough; same shape as the existing M2.X.5.z URL-source image variant.
- **Bedrock** — throws: `"Bedrock provider does not support document_url content blocks — pre-fetch the URL to base64 bytes and use a document block instead"`. No URL variant in Bedrock's Converse API.
- **OpenAI Responses** — throws: `"OpenAI Responses API does not support document_url content blocks — pre-fetch the URL to base64 bytes and use a document block instead, or upload via the Files API and use a file_id reference"`. `input_file` requires `file_data` or `file_id`; no direct URL.
- **OpenAI Chat** — throws with "use Responses API path" guidance (consistent with the bytes-based document throw).

### 5. Three of four paths throw

Same asymmetry as image_url (M2.X.5.y): only Anthropic supports URL natively. Operators with mixed-provider workflows pre-fetch URLs to bytes when targeting any non-Anthropic provider.

## Cross-cutting invariants enforced

- **`document_url` is additive.** All pre-M2.X.5.aa.y tests pass unchanged.
- **URL validated at parse time.** Operators sending malformed URLs fail fast.
- **`format` and `name` are optional on URL variant.** URL responses' Content-Type provides format hint; filename can default per-provider where supported.
- **Tool-message rule extends to document_url.** Same as bytes-based document blocks.
- **Three providers throw with actionable error messages.** Operators see "pre-fetch the URL to bytes" or "use a different API path" guidance.
- **Anthropic passes URLs through natively.** Verified by test.
- **No changes to existing kernel schema or M2.X.5.aa tests.** Verified by full test suite running at 6,766 unchanged.

## End-to-end semantic

```ts
const msg: LlmMessage = {
  role: "user",
  content: [
    { type: "text", text: "summarize" },
    {
      type: "document_url",
      url: "https://example.com/spec.pdf",
      name: "spec.pdf",
    },
  ],
};

// → Anthropic:  {type: "document", source: {type: "url", url}, title: "spec.pdf"}
// → Bedrock:    THROWS (pre-fetch to bytes)
// → OpenAI Responses: THROWS (pre-fetch to bytes or use Files API)
// → OpenAI Chat: THROWS (use Responses API path)
```

Cross-provider operators with URL-accessible PDFs pre-fetch the bytes once + construct a `{type: "document", format: "pdf", bytes, name}` block; that flows through all three supported providers (Bedrock, Anthropic, OpenAI Responses).

## Alternatives considered

- **Auto-fetch URLs in the translator for non-Anthropic providers.**
  - **Considered.** Operators get URL ergonomics across providers.
  - **Cons.** Same scope-creep concerns as M2.X.5.y — async build steps, timeout config, retry, SSRF allowlist. None belongs in the provider.
  - **Decision.** Throw. Operators handle the fetch.

- **Merge `document` + `document_url` into one block with a `source` discriminator.**
  - **Considered.** Anthropic-style nested source.
  - **Cons.** Breaks existing `{type: "document", format, bytes}` consumers from M2.X.5.aa. The flat-variants pattern is consistent with image / image_url.
  - **Decision.** Two clean discriminated variants.

- **OpenAI Responses: translate `document_url` to a Files-API upload + file_id reference automatically.**
  - **Considered.** Operators get URL ergonomics on OpenAI.
  - **Cons.** Files API has its own surface (CRUD, expiry, deduplication, quota). Wiring that into the translator is a major scope expansion. Future M2.X.5.aa.z could add a separate Files-API client.
  - **Decision.** Throw with "use Files API" guidance. Files API integration deferred.

- **Allow `document_url` to silently fall back to `contentToText` (skip document on unsupported providers).**
  - **Considered.** Lossy but doesn't break.
  - **Cons.** Same rejection as M2.X.5.y — operators with document-dependent prompts would silently get wrong responses.
  - **Decision.** Throw.

- **Add a `media_type` hint on `document_url` (in case URL response Content-Type is wrong).**
  - **Considered.** Disambiguation field.
  - **Cons.** Anthropic's URL document schema doesn't accept media_type — they trust Content-Type. Adding the field would be vestigial.
  - **Decision.** No media_type. Format is optional for client-side bookkeeping only.

- **Support non-PDF formats now that we have a URL variant** (Anthropic accepts URLs for non-PDF docs too).
  - **Considered.** Expanded coverage.
  - **Cons.** Format-enum expansion belongs in M2.X.5.aa.x (a separate milestone tackling cross-provider format support). Keeping `format` enum at `["pdf"]` for now.
  - **Decision.** PDF-only. Future M2.X.5.aa.x adds formats.

- **Add a `cache_control` field on URL documents** (Anthropic supports per-block caching).
  - **Considered.** URLs may be large.
  - **Cons.** Provider-specific; not in kernel `CacheControl` schema.
  - **Decision.** Out of scope.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,777 tests** (+11 from M2.X.5.aa.y: 7 kernel + 1 Anthropic + 1 Bedrock + 1 OpenAI Responses + 1 OpenAI Chat). All green, zero type errors.
- **ADR-0097 Q2 closed.** URL-based documents have a kernel representation.
- **Document parity is now bytes everywhere + URL on Anthropic.** Same pattern as images post-M2.X.5.y/z.
- **`LlmContentBlockSchema` discriminated union grew to 7 variants.** Downstream code exhaustively switching on the discriminator should compile-error and force handling.
- **Payload + latency win on Anthropic.** Same benefit as M2.X.5.z for images: a 50 MB PDF URL is ~100 bytes vs ~67 MB inline base64.
- **Three "throw with actionable guidance" paths.** Pattern is well-established now — operators routing across providers understand which content variants need pre-fetching for which providers.

## Open questions

- **Q1:** Should the kernel ship a `pre-fetch document URL → bytes` helper to ease the cross-provider burden?
  - _Current direction:_ Out of scope. Same rationale as M2.X.5.y — fetch policy belongs in operator code.
- **Q2:** Should OpenAI Responses + Bedrock get URL support via auto-fetching with explicit timeout/retry config?
  - _Current direction:_ Out of scope. Future M6.7 router-side could add a `prefetchUrls: boolean` policy that resolves URL blocks to bytes before dispatching.
- **Q3:** Files API integration for OpenAI Responses URL documents?
  - _Current direction:_ Future M2.X.5.aa.z. Separate Files-API client + file_id management.
- **Q4:** When document format enum grows (csv, docx, etc.), should `document_url` carry the same expansion?
  - _Current direction:_ Yes; both variants share the format enum. Future M2.X.5.aa.x handles both.
- **Q5:** Signed-URL document inputs (S3 pre-signed URLs)?
  - _Current direction:_ Treated identically — URL field is opaque. Anthropic's server-side fetch handles signed URLs the same as public ones.
- **Q6:** Cache headers on URL documents?
  - _Current direction:_ Anthropic respects the URL response's cache headers server-side.
- **Q7:** Should there be a way to FORCE the bytes path even when document_url is provided?
  - _Current direction:_ Out of scope. Operators wanting bytes use `{type: "document", format, bytes}` directly.
