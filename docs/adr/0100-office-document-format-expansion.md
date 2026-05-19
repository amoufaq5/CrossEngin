# ADR-0100: Office document format expansion (Phase 2 M2.X.5.aa.x.1)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0099 (M2.X.5.aa.x text format expansion), ADR-0097 (M2.X.5.aa DocumentContentBlock) |

## Context

M2.X.5.aa.x added the three TEXT-friendly formats (`txt`, `md`, `csv`) alongside `pdf` — full cross-provider parity (Bedrock + Anthropic + OpenAI Responses all native). ADR-0099 Q1 noted that office formats (`doc`, `docx`, `xls`, `xlsx`, `html`) were deferred because only Bedrock supports them natively; adding them at the time would create two-provider-throw asymmetry without operator demand.

The asymmetry is real but the operational value is also real: operators using Bedrock for document analysis (legal, financial, healthcare, government workflows) regularly need Word docs, Excel sheets, and HTML pages. The kernel should let them express these inputs cleanly; provider-specific throws document the constraint where it exists.

M2.X.5.aa.x.1 adds the five office formats to `DOCUMENT_FORMATS`. Bedrock supports them natively; Anthropic + OpenAI Responses throw with explicit "convert to PDF" guidance.

## Decision

Five coordinated changes.

### 1. `DOCUMENT_FORMATS` expansion

```ts
export const DOCUMENT_FORMATS = [
  "pdf", "txt", "md", "csv",          // existing (M2.X.5.aa + M2.X.5.aa.x)
  "doc", "docx", "xls", "xlsx", "html", // new (M2.X.5.aa.x.1)
] as const;
```

Nine formats total. Matches Bedrock Converse API's full document-format set.

### 2. New `OFFICE_DOCUMENT_FORMATS` tuple + `isOfficeDocumentFormat` discriminator

```ts
export const OFFICE_DOCUMENT_FORMATS = ["doc", "docx", "xls", "xlsx", "html"] as const;
export type OfficeDocumentFormat = (typeof OFFICE_DOCUMENT_FORMATS)[number];

export function isOfficeDocumentFormat(
  format: DocumentFormat,
): format is OfficeDocumentFormat {
  return (OFFICE_DOCUMENT_FORMATS as readonly string[]).includes(format);
}
```

The discriminator is the throw guard for Anthropic + OpenAI translators. It's the canonical way to ask "does this format need the office-format throw branch?"

### 3. `documentMediaType` MIME map extension

```ts
function documentMediaType(format: DocumentFormat): string {
  if (format === "pdf") return "application/pdf";
  if (format === "txt") return "text/plain";
  if (format === "md") return "text/markdown";
  if (format === "csv") return "text/csv";
  if (format === "doc") return "application/msword";
  if (format === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (format === "xls") return "application/vnd.ms-excel";
  if (format === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return "text/html";
}
```

All 9 formats have explicit MIME-type entries. `isTextDocumentFormat` is unchanged — it still returns true only for `txt`/`md`/`csv` (the formats Anthropic accepts via its text-source variant). Office formats are binary-or-richly-structured; not text-source-eligible.

### 4. Per-provider translation

- **Bedrock** — translator unchanged. `BedrockDocumentContentBlock.format` already accepts all 9 formats; the existing pass-through translator handles office formats natively.
- **Anthropic** — translator gains an explicit throw branch BEFORE the text-format dispatch:
  ```ts
  if (block.format === "doc" || block.format === "docx" ||
      block.format === "xls" || block.format === "xlsx" ||
      block.format === "html") {
    throw new Error(
      `Anthropic provider does not support document format '${block.format}' — convert to PDF (use the 'pdf' format), or use a different provider (Bedrock supports office formats natively)`,
    );
  }
  ```
- **OpenAI Responses** — translator gains an `isOfficeDocumentFormat` check + throw:
  ```ts
  if (isOfficeDocumentFormat(b.format)) {
    throw new Error(
      `OpenAI Responses API does not support document format '${b.format}' — convert to PDF (use the 'pdf' format), or use a different provider (Bedrock supports office formats natively)`,
    );
  }
  ```
- **OpenAI Chat** — still throws on all documents.

### 5. Document URL variant is also expanded

`DocumentUrlContentBlock.format` (optional) now accepts the same 9 formats. The URL path is provider-agnostic in the schema; only Anthropic supports `document_url` regardless of format, and Anthropic's URL document path doesn't carry format hints (server-side Content-Type wins).

## Cross-cutting invariants enforced

- **Format enum expansion is additive.** Pre-M2.X.5.aa.x.1 code paths (pdf/txt/md/csv) unchanged; all 6,786 prior tests pass.
- **Bedrock supports all 9 formats natively** — no translator change needed.
- **Anthropic throws on office formats with conversion guidance** — verified by test loop covering all 5 office formats.
- **OpenAI Responses throws on office formats with conversion guidance** — verified by test loop covering all 5 office formats.
- **`isOfficeDocumentFormat` narrows correctly.** Used by the OpenAI Responses translator + tested explicitly.
- **`documentMediaType` covers all 9 formats** with correct IANA MIME types — verified by test.
- **Office formats are NOT text formats.** `isTextDocumentFormat` returns false for all 5 office formats (HTML is text-based but treated as office for translation purposes — Anthropic doesn't accept it via text source).
- **Tool-message rule unchanged.** Documents (all 9 formats) still rejected on tool messages.

## End-to-end semantic

```ts
// Bedrock-only path (operator chose Bedrock for office documents):
const built = buildBedrockConverseRequest({
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "summarize this report" },
      { type: "document", format: "docx", bytes: docxBase64, name: "report.docx" },
    ],
  }],
  ...
});
// → {document: {format: "docx", name: "report.docx", source: {bytes}}}

// Cross-provider routing (operator might land on Anthropic):
// → Anthropic translator throws with:
//   "Anthropic provider does not support document format 'docx' — convert to PDF..."

// Operator's recovery: convert to PDF client-side, then route either provider works:
const pdfMsg = { type: "document", format: "pdf", bytes: convertedPdfBase64 };
// Works on Bedrock + Anthropic + OpenAI Responses.
```

## Alternatives considered

- **Auto-convert office formats to PDF in the translator (using a server-side conversion library).**
  - **Considered.** Operators get full cross-provider transparency.
  - **Cons.** Massive scope creep — conversion libraries are heavy (LibreOffice, Pandoc), platform-specific, often async, and add a security surface (untrusted document parsing). The kernel stays simple; operators owning conversion handle the policy.
  - **Decision.** Throw with actionable error. Operators convert in their layer.

- **Add only the most common office formats (docx + xlsx) initially.**
  - **Considered.** Smaller surface.
  - **Cons.** Legacy doc/xls + html are all in Bedrock's native set; partial coverage would create surprising "this format works, this one doesn't" inconsistencies within the office category. Better to match Bedrock's full set in one milestone.
  - **Decision.** All 5 office formats.

- **Make Anthropic's HTML throw say "use plain text" instead of "convert to PDF".**
  - **Considered.** Anthropic's text source could potentially accept HTML rendered as text.
  - **Cons.** Anthropic's text-source `media_type` enum explicitly supports `text/plain`/`text/markdown`/`text/csv` — not `text/html`. Adding HTML support there would require either ignoring the API contract or providing a different conversion path. Conservative: throw.
  - **Decision.** Throw on HTML the same as other office formats.

- **Auto-detect when a `format: "pdf"` block's bytes are actually a different format (magic-byte sniffing).**
  - **Considered.** Catch operator typos.
  - **Cons.** Adds Buffer-inspection logic that's brittle and doesn't help — if the operator misclassified, downstream providers will fail anyway. Trust the declared format.
  - **Decision.** No magic-byte detection.

- **Drop the office formats from the kernel; let operators use Bedrock-specific request shapes for office documents.**
  - **Considered.** Keep kernel minimal.
  - **Cons.** Operators using Bedrock-for-office and Anthropic-for-PDF would need different request shapes per provider, defeating the kernel's abstraction. The thrown error preserves the abstraction while documenting the constraint.
  - **Decision.** Keep in kernel; throw on non-Bedrock providers.

- **Add a `ProviderCapabilities.documentFormats: readonly DocumentFormat[]` field for runtime introspection.**
  - **Considered.** Operators query capabilities before sending.
  - **Cons.** Provider capabilities are static per-provider; the ADR documents what's supported. Introspection would be useful for dynamic routing but isn't required for M2.X.5.aa.x.1.
  - **Decision.** Defer. Future M2.X.5.aa.x.2 can add the introspection field if dynamic routing demands it.

- **Bedrock supports DOCX text extraction server-side and emits the extracted text as the model input — should the kernel cache or surface that?**
  - **Considered.** Operators using DOCX through Bedrock get text-equivalent input.
  - **Cons.** Out of scope — that's a server-side transformation. The kernel just transports bytes; what the model receives is provider business.
  - **Decision.** Pass through. No client-side caching of extracted text.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,794 tests** (+8 from M2.X.5.aa.x.1). All green, zero type errors.
- **ADR-0099 Q1 fully closed.** All Bedrock-supported document formats are now in the kernel.
- **Bedrock has full document support** — 9 formats × 1 provider = 9 native paths.
- **Two-provider asymmetry is explicit + tested.** Anthropic + OpenAI Responses throw with consistent "convert to PDF" guidance.
- **`isOfficeDocumentFormat` is a reusable discriminator.** Pattern: typed tuple + predicate. Same shape as M2.X.6.x's moderation kinds.
- **The kernel's `LlmContentBlock` discriminated union is unchanged** — only the format enum and helpers grew. Downstream code reading `document` blocks works without modification (assuming it handles the broader format set).
- **Office document operators have a clear path.** Bedrock-only workflow OR client-side PDF conversion. Both are documented.

## Open questions

- **Q1:** Should `ProviderCapabilities` carry `documentFormats: readonly DocumentFormat[]` for runtime introspection?
  - _Current direction:_ Defer until dynamic routing demands it. ADRs document the matrix.
- **Q2:** Should the kernel ship a `convertDocumentToPdf(bytes, format): Promise<string>` helper?
  - _Current direction:_ Out of scope. Conversion is heavy + platform-specific. Operators use their own conversion stack.
- **Q3:** Add `rtf` (Rich Text Format) since Bedrock supports it on some models?
  - _Current direction:_ Bedrock Converse API doesn't list RTF as a supported format. If they add it, append to the enum.
- **Q4:** Should HTML be supported via Anthropic's text source (text/html media type)?
  - _Current direction:_ Anthropic's text-source enum explicitly excludes text/html. Wait for the API to expand.
- **Q5:** Office document URL variants — same throw pattern for non-Anthropic providers?
  - _Current direction:_ The URL variant already throws on Bedrock + OpenAI Responses regardless of format. Office-format URLs only work on Anthropic, which itself throws on office formats. Net result: office-format URLs throw everywhere. That's the consistent answer.
- **Q6:** Should office format detection from filename extension (e.g., `report.docx`) influence the throw message?
  - _Current direction:_ Format is operator-declared; filename is informational. Throw message already says the format explicitly.
- **Q7:** What about audio/video document formats (subtitles, transcripts)?
  - _Current direction:_ Different content surface — not documents in the chat sense. Future content block variant if a provider ships native support.
