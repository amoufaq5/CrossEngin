# ADR-0097: DocumentContentBlock — PDF inputs (Phase 2 M2.X.5.aa)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0094 (M2.X.5.y ImageUrlContentBlock), ADR-0096 (M2.X.5.z Anthropic URL source), ADR-0088 (M2.X.5 content union) |

## Context

ADR-0096 Q7 noted that Anthropic supports document content blocks (PDF, text, CSV, Markdown) via a separate `document` type. Operators wanting to send PDFs through the chat API have to encode them base64 + use the right shape per provider; the kernel content union didn't have a native representation.

M2.X.5.aa adds `DocumentContentBlock` as the sixth variant of `LlmContentBlock`. Scoped to PDF only — the most universally supported format across providers — with the format enum left as an extensible literal union for future expansion (CSV, DOCX, etc.).

Provider support today:
- **Anthropic** — `{type: "document", source: {type: "base64", media_type: "application/pdf", data}, title?}` natively
- **Bedrock** — `{document: {format: "pdf" | ..., name, source: {bytes}}}` via Converse API (supports pdf/csv/doc/docx/xls/xlsx/html/txt/md)
- **OpenAI Responses API** — `{type: "input_file", filename, file_data: "data:application/pdf;base64,..."}` natively
- **OpenAI Chat Completions** — does NOT support document blocks in the chat API; requires Files API upload + file_id reference (out of scope)

## Decision

Five coordinated changes.

### 1. New `DocumentContentBlock` type

```ts
export const DOCUMENT_FORMATS = ["pdf"] as const;
export const DocumentFormatSchema = z.enum(DOCUMENT_FORMATS);

export const DocumentContentBlockSchema = z.object({
  type: z.literal("document"),
  format: DocumentFormatSchema,
  bytes: z.string().min(1),
  name: z.string().max(120).optional(),
});
```

Format enum is `["pdf"]` only. Future expansion is purely additive — add `"csv"`, `"docx"`, etc. as providers and translators stabilize. `bytes` is base64-encoded; `name` is optional (defaults applied per-provider at translation time).

### 2. Discriminated union extension

```ts
LlmContentBlockSchema = z.discriminatedUnion("type", [
  TextContentBlockSchema,
  ImageContentBlockSchema,
  ImageUrlContentBlockSchema,
  DocumentContentBlockSchema,        // new
  ToolUseContentBlockSchema,
  ToolResultContentBlockSchema,
]);
```

Six variants total. Existing five-variant consumers continue to work; downstream code that exhaustively switches on `type` should compile-error and force handling.

### 3. Role validation

Same rule as images: documents are not allowed on `role: "tool"` messages (tool messages are text-only by convention). Validated by `superRefine`.

### 4. Per-provider translation

**Bedrock** (`converse-api.ts`):
```ts
{
  document: {
    format: block.format,
    name: block.name ?? "document",
    source: { bytes: block.bytes },
  }
}
```
Adds `BedrockDocumentContentBlock` type to the union. Defaults `name` to `"document"` if not provided.

**Anthropic** (`messages-api.ts`):
```ts
{
  type: "document",
  source: {
    type: "base64",
    media_type: "application/pdf",
    data: block.bytes,
  },
  ...(block.name !== undefined ? { title: block.name } : {}),
}
```
Adds the `document` variant to `AnthropicContentBlock` (with both base64 + url source variants per Anthropic's API). Maps kernel `name` to Anthropic's `title` field.

**OpenAI Responses API** (`responses-api.ts`):
```ts
{
  type: "input_file",
  filename: block.name ?? `document.${block.format}`,
  file_data: `data:application/pdf;base64,${block.bytes}`,
}
```
Adds `OpenAIResponsesContentFileInput` to the union. Defaults filename to `"document.pdf"` if `name` not provided. Wraps bytes in a data URL with the appropriate MIME type.

**OpenAI Chat Completions** (`chat-api.ts`):
```ts
throw new Error("OpenAI Chat Completions does not support document content blocks — use the Responses API path (defaultApiPath: 'responses') or upload via the Files API");
```
The Chat Completions API requires Files API upload + file_id reference for documents; that flow is out of scope. Operators using documents must opt into the Responses API path.

### 5. Asymmetric provider support

The third "throw on this path" provider scenario (alongside `image_url` on Bedrock from M2.X.5.y and the previously-thrown Anthropic URL path from M2.X.5.z). Operators wanting documents through OpenAI must set `defaultApiPath: "responses"` on their provider; operators wanting them through Bedrock + Anthropic get full support.

## Cross-cutting invariants enforced

- **`DocumentContentBlock` is additive.** Existing 5-variant union consumers continue to work.
- **Format enum is `["pdf"]` today.** Singleton — future expansion is purely additive.
- **Documents not allowed on tool messages.** Verified by test (same rule as images).
- **Empty bytes rejected.** Schema `.min(1)`.
- **Name length capped at 120 chars.** Reasonable filename limit.
- **Bedrock + Anthropic + OpenAI Responses translate natively.** Verified by tests for each provider.
- **OpenAI Chat Completions throws with actionable error message.** Verified by test.
- **Anthropic `title` field maps from kernel `name`.** Per Anthropic's API shape.

## End-to-end semantics

```ts
const msg: LlmMessage = {
  role: "user",
  content: [
    { type: "text", text: "summarize this PDF" },
    {
      type: "document",
      format: "pdf",
      bytes: pdfBase64,
      name: "spec.pdf",
    },
  ],
};

// → Bedrock:    {document: {format: "pdf", name: "spec.pdf", source: {bytes}}}
// → Anthropic:  {type: "document", source: {type: "base64", media_type: "application/pdf", data}, title: "spec.pdf"}
// → OpenAI Responses: {type: "input_file", filename: "spec.pdf", file_data: "data:application/pdf;base64,..."}
// → OpenAI Chat: THROWS (operator must use Responses path or Files API)
```

## Alternatives considered

- **Support all Bedrock formats (csv/doc/docx/xls/xlsx/html/txt/md) in the kernel from day one.**
  - **Considered.** Maximum coverage on Bedrock.
  - **Cons.** Anthropic + OpenAI support different subsets natively. Adding formats the kernel doesn't have translation paths for everywhere creates asymmetric throws across providers. Starting with PDF (the universal case) is cleaner.
  - **Decision.** PDF only. Future M2.X.5.aa.x adds formats as their cross-provider story stabilizes.

- **Use a URL variant `DocumentUrlContentBlock` alongside the bytes variant** (matching M2.X.5.y's image_url pattern).
  - **Considered.** Anthropic accepts `source: {type: "url", url}` for documents; would match the image_url shape.
  - **Cons.** Bedrock + OpenAI Responses don't accept document URLs natively. Two providers would need to throw, mirroring M2.X.5.y's asymmetry but for a less-common use case.
  - **Decision.** Bytes-only today. Future M2.X.5.aa.y can add `DocumentUrlContentBlock` when URL support across providers stabilizes.

- **Have the kernel auto-translate `txt`/`md`/`csv` documents to text content blocks** (decode bytes, append as `TextContentBlock`).
  - **Considered.** Hides the format complexity from operators.
  - **Cons.** Lossy abstraction — Anthropic's `source: {type: "text", media_type}` shape is structurally different from a generic text block (it carries the document semantic). And the kernel would have to base64-decode + re-encode, which is wasteful.
  - **Decision.** No auto-translation. Operators using text-format documents wait for the format-enum expansion in a future milestone.

- **Add a `cache_control` field on documents** (Anthropic supports per-block cache breakpoints).
  - **Considered.** Documents are LARGE; caching them is valuable.
  - **Cons.** The kernel `CacheControl` field handles request-level cache breakpoints. Per-block caching is provider-specific. Future M2.X.5.aa.z when per-block cache shape stabilizes.
  - **Decision.** Out of scope.

- **Throw on Bedrock + Anthropic too, requiring operators to convert PDFs to images.**
  - **Considered.** Forces a uniform path (image content blocks).
  - **Cons.** Lossy (text in PDFs becomes images), expensive (more tokens), and Bedrock + Anthropic both have native document support. Throwing here would be operationally wrong.
  - **Decision.** Translate natively where supported.

- **Make `name` required.**
  - **Considered.** Bedrock + OpenAI both want filenames; making it required forces operators to think.
  - **Cons.** Operators with inline-only PDFs (no source filename) shouldn't be forced to make up a name. Defaulting per-provider is more ergonomic.
  - **Decision.** Optional with per-provider defaults.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,766 tests** (+15 from M2.X.5.aa: 7 kernel + 2 Bedrock + 2 Anthropic + 2 OpenAI Responses + 1 OpenAI Chat + 1 other backwards-compat). All green, zero type errors.
- **ADR-0096 Q7 closed.** Documents have a kernel-level representation.
- **PDF-input parity across three of four real provider paths.** Bedrock + Anthropic + OpenAI Responses all accept PDFs natively from `LlmMessage`. OpenAI Chat Completions throws with a clear "use Responses API" message.
- **`LlmContentBlockSchema` discriminated union grew to 6 variants.** Future content blocks (audio, video, document URL variant) extend the same pattern.
- **Provider-specific shape mismatches surface at type level.** Each provider's content block union grew; downstream consumers exhaustively switching on the discriminator should compile-error and force handling.
- **The "throw with actionable error" pattern is now established as standard.** Three milestones (M2.X.5.y, M2.X.5.aa, and M2.X.5.z which removed one) use it. Operators see clear "use X instead" guidance when a provider doesn't support a content variant.

## Open questions

- **Q1:** When should the format enum grow beyond PDF?
  - _Current direction:_ When a clear cross-provider story exists for additional formats. Bedrock supports the most (9 formats); Anthropic + OpenAI support fewer. Add formats as their universal-or-translatable status stabilizes.
- **Q2:** Should there be a `DocumentUrlContentBlock` variant analogous to `ImageUrlContentBlock`?
  - _Current direction:_ Future M2.X.5.aa.y. Anthropic supports URL sources; Bedrock + OpenAI Responses don't. Same asymmetry as image_url.
- **Q3:** OpenAI Chat Completions documents via Files API upload — should we wire that?
  - _Current direction:_ Out of scope. Requires a separate Files-API client + file_id management. Future M2.X.5.aa.z.
- **Q4:** Per-block `cache_control` for large documents?
  - _Current direction:_ Provider-specific concern; not in the kernel cache-control schema today.
- **Q5:** Streaming chunked uploads for very large PDFs?
  - _Current direction:_ Out of scope. Operators handle large-file uploads via the Files API path (or pre-upload to S3/CDN + URL variant when that ships).
- **Q6:** Should the kernel ship a `documentFromBuffer(buffer, name?)` helper?
  - _Current direction:_ The block construction is straightforward (base64-encode + literal); a helper adds little value.
- **Q7:** What about extracted-text content blocks for documents (some providers extract text server-side and return it)?
  - _Current direction:_ Out of scope. That's an output-side concern; input shape stays inline-bytes-only.
