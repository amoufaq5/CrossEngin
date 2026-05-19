# ADR-0099: Document format expansion — txt + md + csv (Phase 2 M2.X.5.aa.x)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0097 (M2.X.5.aa DocumentContentBlock — PDF), ADR-0098 (M2.X.5.aa.y DocumentUrlContentBlock) |

## Context

M2.X.5.aa scoped `DOCUMENT_FORMATS` to `["pdf"]` — the universal format across all three real provider document APIs. ADR-0097 Q1 noted that format expansion should happen as cross-provider support stabilizes.

The natural next step is the three TEXT-friendly formats:
- **txt** — plain text
- **md** — Markdown
- **csv** — comma-separated values

These have clean cross-provider stories:
- **Bedrock** Converse API accepts all three natively (alongside its broader format set).
- **Anthropic** supports them via the `source: {type: "text", media_type: "text/plain" | "text/markdown" | "text/csv", data: <decoded text>}` shape.
- **OpenAI Responses API** accepts them via `input_file` with the appropriate MIME type in the data URL.

The provider matrix is now uniform for these 4 formats. Office formats (doc, docx, xls, xlsx, html) are deferred — Bedrock supports them natively but Anthropic + OpenAI Responses don't have a clean path without conversion.

## Decision

Four coordinated changes.

### 1. `DOCUMENT_FORMATS` expansion

```ts
export const DOCUMENT_FORMATS = ["pdf", "txt", "md", "csv"] as const;
```

Singleton tuple becomes a 4-element tuple. Additive change — all M2.X.5.aa code paths using `format: "pdf"` continue to work.

### 2. New helpers in `@crossengin/ai-providers`

```ts
export function documentMediaType(format: DocumentFormat): string {
  if (format === "pdf") return "application/pdf";
  if (format === "txt") return "text/plain";
  if (format === "md") return "text/markdown";
  return "text/csv";
}

export function isTextDocumentFormat(format: DocumentFormat): boolean {
  return format !== "pdf";
}
```

`documentMediaType` is a single source of truth for the MIME type mapping. `isTextDocumentFormat` is the discriminator between PDF (binary base64) and text formats (which Anthropic wants decoded to UTF-8 text).

### 3. Per-provider translation updates

**Bedrock** — no translator changes needed. The `BedrockDocumentContentBlock.format` type already accepts the broader Bedrock format set (`pdf | csv | doc | docx | xls | xlsx | html | txt | md`); the M2.X.5.aa translator passes `block.format` through directly. All four kernel formats flow natively.

**Anthropic** — translator becomes format-aware:
```ts
if (block.format === "pdf") {
  // existing: source: {type: "base64", media_type: "application/pdf", data}
} else {
  // new: source: {type: "text", media_type: "text/<plain|markdown|csv>", data: <decoded utf-8>}
}
```
The kernel `bytes` field is base64-encoded; for text formats the translator decodes via `Buffer.from(bytes, "base64").toString("utf8")` before passing to Anthropic's text-source field. `AnthropicContentBlock` document variant extended with the `text` source.

**OpenAI Responses** — translator uses `documentMediaType` for the data URL MIME prefix:
```ts
file_data: `data:${documentMediaType(block.format)};base64,${block.bytes}`,
```
All four formats flow as `input_file` content; OpenAI infers the file type from the MIME prefix.

**OpenAI Chat** — still throws (no document support; not changed).

### 4. Base64 → UTF-8 decoding for Anthropic text formats

The kernel `DocumentContentBlock.bytes` is always base64-encoded for symmetry with `ImageContentBlock`. Anthropic's text source field, however, expects raw text. The translator handles the conversion:

```ts
function decodeBase64Utf8(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf8");
}
```

Node-targeted helper (consistent with the rest of the workspace's runtime). Operators pass UTF-8 text encoded as base64; the translator decodes for Anthropic; the round-trip is correct for any UTF-8 content.

## Cross-cutting invariants enforced

- **Format enum expansion is additive.** PDF code paths unchanged; all 6,766 pre-M2.X.5.aa.x tests pass.
- **`documentMediaType` is the single source of truth.** Both Anthropic + OpenAI Responses translators use it for MIME-type mapping (Anthropic via the discriminated branch; OpenAI directly).
- **Anthropic decodes base64 to UTF-8 for text formats.** Verified by tests using `Buffer.from(text, "utf8").toString("base64")` round-trips.
- **OpenAI Responses MIME type matches format.** Verified by test covering all 4 formats.
- **Bedrock passes format through directly.** Verified by test for txt/md/csv (PDF was already covered).
- **PDF still uses Anthropic's `base64` source variant.** Behavior unchanged from M2.X.5.aa.
- **Tool-message rule unchanged.** Documents (all formats) still rejected on tool messages.

## End-to-end semantic

```ts
const text = "Hello, world!";
const bytes = Buffer.from(text, "utf8").toString("base64");
const msg: LlmMessage = {
  role: "user",
  content: [
    { type: "text", text: "summarize" },
    { type: "document", format: "txt", bytes, name: "note.txt" },
  ],
};

// → Bedrock:    {document: {format: "txt", name: "note.txt", source: {bytes}}}
// → Anthropic:  {type: "document", source: {type: "text", media_type: "text/plain", data: "Hello, world!"}, title: "note.txt"}
// → OpenAI Responses: {type: "input_file", filename: "note.txt", file_data: "data:text/plain;base64,SGVsbG8sIHdvcmxkIQ=="}
// → OpenAI Chat: throws (no document support)
```

For PDF, the Anthropic translation still uses the base64 source variant — text decoding only applies to text formats.

## Alternatives considered

- **Add all 9 Bedrock formats (doc/docx/xls/xlsx/html alongside the text formats).**
  - **Considered.** Maximum coverage on Bedrock.
  - **Cons.** Anthropic + OpenAI don't have clean translations for office formats; would need to throw on those providers, creating asymmetry. Adding formats incrementally as cross-provider stories stabilize is cleaner.
  - **Decision.** Defer office formats. Future milestone (e.g. M2.X.5.aa.x.1) can add them with documented Bedrock-only support.

- **Make kernel `bytes` accept either base64 or raw text depending on format.**
  - **Considered.** Skip the decode step for text formats.
  - **Cons.** Inconsistent shape (sometimes base64, sometimes UTF-8) makes downstream code less predictable. Operators have to remember the rule per-format.
  - **Decision.** Always base64. Translator handles the format-specific transformation.

- **Provide a `documentFromText(text, format)` helper that encodes to base64.**
  - **Considered.** Convenience for operators with raw text + format.
  - **Cons.** One-line operation (`Buffer.from(text, "utf8").toString("base64")`). Not worth shipping as a separate helper.
  - **Decision.** Out of scope.

- **Use `atob` instead of `Buffer.from` for cross-platform compatibility.**
  - **Considered.** Browser-compatible base64 decoding.
  - **Cons.** `atob` returns a binary string that needs UTF-8 re-encoding via TextDecoder — more code, harder to read. The rest of the workspace uses Node-targeted patterns; staying consistent.
  - **Decision.** Buffer. Workspace is Node-targeted.

- **Skip the OpenAI Responses MIME-type update — keep `application/pdf` hardcoded.**
  - **Considered.** Simpler.
  - **Cons.** OpenAI infers file type from MIME prefix; sending a txt document with `application/pdf` would confuse the model. Need correct MIME types.
  - **Decision.** Format-aware MIME type via `documentMediaType`.

- **Add csv parsing / md → HTML rendering on the kernel side.**
  - **Considered.** Operators get structured data.
  - **Cons.** Massive scope creep + provider-side rendering already works. The kernel just transports content.
  - **Decision.** Pass through. Operators get the raw bytes; providers handle interpretation.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,786 tests** (+9 from M2.X.5.aa.x: 4 kernel + 1 Bedrock + 4 Anthropic + 1 OpenAI Responses — split / regrouped). All green, zero type errors.
- **ADR-0097 Q1 closed (partially).** Three additional text formats supported with full cross-provider parity. Office formats remain deferred.
- **Document parity now covers 4 formats × 3 supported providers.** Bedrock + Anthropic + OpenAI Responses all accept pdf/txt/md/csv. OpenAI Chat continues to throw.
- **`documentMediaType` is reusable.** Future content variants needing MIME-type mapping can use the same helper.
- **Pattern set for office-format expansion.** When operators ask for docx/xlsx/html, add them to the enum + per-provider throw-or-translate logic.
- **The text-format decoding establishes a base64-to-UTF-8 path in the kernel.** Future variants (e.g., HTML embeddings, structured-text formats) can reuse `decodeBase64Utf8` if exported.

## Open questions

- **Q1:** When should office formats (doc/docx/xls/xlsx/html) be added?
  - _Current direction:_ When at least one non-Bedrock provider gains support. Today only Bedrock handles them natively; throwing on two providers is operationally noisy.
- **Q2:** Should `decodeBase64Utf8` be a kernel-level export?
  - _Current direction:_ Provider-local for now. Lift to kernel if multiple consumers need it.
- **Q3:** What about non-UTF-8 text formats (Windows-1252, Latin-1, etc.)?
  - _Current direction:_ Operators encode their text as UTF-8 before base64. Non-UTF-8 input → garbled Anthropic text source. If a real use case emerges, add an optional `encoding` field on the block.
- **Q4:** Should the kernel auto-detect format from filename when `format` is unspecified on `DocumentUrlContentBlock`?
  - _Current direction:_ No. URL responses provide Content-Type; explicit `format` is a hint for operator bookkeeping only.
- **Q5:** Per-provider format support introspection (`provider.capabilities.documentFormats`)?
  - _Current direction:_ Out of scope. Operators read the ADR matrix or check provider documentation.
- **Q6:** Should Anthropic's `content` source variant (`source: {type: "content", content: [...]}`) be supported for embedding text + image blocks inside documents?
  - _Current direction:_ Out of scope. Recursive content is a much bigger surface change.
- **Q7:** Should we add a `DocumentUrlContentBlock` test that verifies URL-based txt/md/csv also work?
  - _Current direction:_ Anthropic's URL document path doesn't carry format hints (URL Content-Type provides it). The existing M2.X.5.aa.y URL test covers PDF; the URL path is format-agnostic by design.
