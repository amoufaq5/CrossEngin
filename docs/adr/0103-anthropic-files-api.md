# ADR-0103: Anthropic Files API integration (Phase 2 M2.X.5.aa.z.1)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0102 (M2.X.5.aa.z OpenAI Files API), ADR-0097 (M2.X.5.aa DocumentContentBlock) |

## Context

M2.X.5.aa.z shipped the OpenAI Files API integration + `FileReferenceContentBlock`. Anthropic recently launched their own Files API (beta header `files-api-2025-04-14`) — same shape as OpenAI's at the upload layer, with file_id references usable in message content via a `source: {type: "file", file_id}` document variant.

The throw in the Anthropic translator from M2.X.5.aa.z was operational reality at the time the milestone was drafted, but the platform shipped support; the throw became a regression on a usable provider feature.

M2.X.5.aa.z.1 closes the gap: ships an Anthropic Files API client and removes the throw, making `file_id` content blocks work natively on both OpenAI Responses AND Anthropic.

## Decision

Five coordinated changes.

### 1. New `files-api.ts` module in `@crossengin/ai-providers-anthropic`

```ts
export const ANTHROPIC_FILES_BETA_HEADER = "files-api-2025-04-14";

export interface AnthropicFile {
  readonly id: string;            // "file_abc123"
  readonly type: "file";
  readonly filename: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly created_at: string;    // ISO 8601
  readonly downloadable?: boolean;
}

export interface AnthropicFileDeleteResponse {
  readonly id: string;
  readonly type: "file_deleted";
}

export function buildAnthropicMultipartUpload(input: {
  bytes: Uint8Array;
  filename: string;
  contentType?: string;
}): { body: Uint8Array; contentType: string };
```

Key differences from OpenAI's files-api module:
- **No `purpose` field** — Anthropic doesn't ask callers to pre-classify file usage; files are general-purpose.
- **Multipart body has ONE part** (just `file`) vs OpenAI's two (`purpose` + `file`).
- **Different boundary prefix** (`----CrossEnginAnthropicBoundary<rand>`).
- **Beta header is required** for all Files API calls.

Otherwise the encoder is structurally identical: RFC 7578 quote escaping, random per-call boundary, byte-for-byte binary preservation.

### 2. `AnthropicProvider.uploadFile / .retrieveFile / .deleteFile`

```ts
async uploadFile(input: {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly contentType?: string;
}): Promise<AnthropicFile>;

async retrieveFile(fileId: string): Promise<AnthropicFile>;

async deleteFile(fileId: string): Promise<AnthropicFileDeleteResponse>;
```

Same CRUD shape as the OpenAI provider methods. Empty `fileId` rejected at the provider boundary. Network / HTTP / JSON parse errors route through `fromNetworkError` / `fromHttpResponse` / `AnthropicError({kind: "api_error"})`.

### 3. `FetchLike.body` widened to `string | Uint8Array`

Backwards-compatible widening (same change as OpenAI in M2.X.5.aa.z). All pre-M2.X.5.aa.z.1 JSON-body callers continue to work; multipart uploads use Uint8Array.

### 4. `AnthropicContentBlock` document variant extended

```ts
| {
    readonly type: "document";
    readonly source:
      | { type: "base64"; media_type: "application/pdf"; data: string }
      | { type: "url"; url: string }
      | { type: "text"; media_type: ...; data: string }
      | { type: "file"; file_id: string };   // new
    readonly title?: string;
  }
```

Four source variants now: base64 (M2.X.5.aa), url (M2.X.5.z), text (M2.X.5.aa.x), file (M2.X.5.aa.z.1). All flow through Anthropic's documented document API.

### 5. Translator removes the throw

```ts
// Pre-M2.X.5.aa.z.1:
if (block.type === "file_id") {
  throw new Error("Anthropic provider does not support file_id...");
}

// Post-M2.X.5.aa.z.1:
if (block.type === "file_id") {
  return {
    type: "document",
    source: { type: "file", file_id: block.fileId },
  };
}
```

The kernel `FileReferenceContentBlock` now passes through to Anthropic natively. Same `LlmMessage` shape that worked on OpenAI Responses now works on Anthropic too.

### Header management: deduplicating beta tags

The provider already supports a `anthropicBeta?: readonly string[]` constructor option for general beta-feature opt-in. The Files API methods need the `files-api-2025-04-14` header regardless of whether the operator opted in. `filesApiBetaHeader()` returns the merged list:

```ts
private filesApiBetaHeader(): string {
  if (this.anthropicBeta.includes(ANTHROPIC_FILES_BETA_HEADER)) {
    return this.anthropicBeta.join(",");
  }
  return [...this.anthropicBeta, ANTHROPIC_FILES_BETA_HEADER].join(",");
}
```

No duplicates if the operator already passed the beta header; otherwise appended. Verified by test.

## Cross-cutting invariants enforced

- **Anthropic Files API methods require + emit `anthropic-beta: files-api-2025-04-14`.** Always present in the request headers; deduplicated if operator-set.
- **Multipart body has no `purpose` field.** Anthropic's API requirement; verified by test.
- **Binary content preserved byte-for-byte.** Same test pattern as OpenAI.
- **`fileId` opaque in the kernel.** No format validation on the file-id shape (OpenAI uses `file-<hex>`, Anthropic uses `file_<id>`; both pass).
- **Translator passthrough is byte-identical to the Anthropic documented shape.** Verified by test against `{type: "document", source: {type: "file", file_id}}`.
- **Empty `fileId` / empty `bytes` / empty `filename` rejected** at provider / encoder boundary.
- **HTTP errors flow through typed `AnthropicError`.** Same pattern as OpenAI provider.
- **No new kernel changes.** `FileReferenceContentBlock` from M2.X.5.aa.z is reused as-is.

## End-to-end semantic

```ts
// Now works on BOTH OpenAI Responses AND Anthropic:
const openai = new OpenAIProvider({ ..., defaultApiPath: "responses" });
const anthropic = new AnthropicProvider({ ... });

// Step 1: upload to whichever provider you'll route to
const openaiFile = await openai.uploadFile({
  bytes: pdfBuffer,
  filename: "policy.pdf",
  purpose: "user_data",
});
const anthropicFile = await anthropic.uploadFile({
  bytes: pdfBuffer,
  filename: "policy.pdf",
});

// Step 2: reference in chat (same LlmMessage shape works on both)
const msg: LlmMessage = {
  role: "user",
  content: [
    { type: "text", text: "summarize" },
    { type: "file_id", fileId: anthropicFile.id },  // or openaiFile.id, depending on provider
  ],
};

// Anthropic: translates to {type: "document", source: {type: "file", file_id}}
// OpenAI Responses: translates to {type: "input_file", file_id}
```

Cross-provider note: file_ids are NOT portable. An OpenAI file_id won't work on Anthropic and vice versa. Operators routing across providers either upload to both OR fall back to inline document blocks for the non-uploaded provider.

## Alternatives considered

- **Share a multipart encoder between OpenAI + Anthropic providers (extract to a shared package).**
  - **Considered.** ~80% code overlap between the two `buildMultipartUpload` functions.
  - **Cons.** Extraction creates a cross-package dependency for ~30 lines of code. The slight duplication is worth the package-isolation benefit (each provider package is fully self-contained).
  - **Decision.** Duplicate. Re-evaluate if a third provider needs multipart upload.

- **Add a `providerHint` field on `FileReferenceContentBlock` so operators declare which provider's file_id is in the block.**
  - **Considered.** Catch misrouted file_ids early.
  - **Cons.** The kernel content block is provider-agnostic by design; operators routing intentionally pick one provider per chat session. Adding the hint introduces friction without preventing the misroute (the wrong provider would still throw at the API boundary).
  - **Decision.** Keep `fileId` opaque. Operators manage provider-specific file IDs.

- **Auto-detect provider from file_id prefix** (e.g., `file-` → OpenAI, `file_` → Anthropic).
  - **Considered.** Magic dispatch saves operators a lookup.
  - **Cons.** Provider file_id formats aren't a stable contract — they could change. Magic dispatch hides operator intent. The error message at the API boundary already tells operators they used the wrong provider.
  - **Decision.** No auto-detection. Operators pick provider deliberately.

- **Use a closed enum for `mime_type` on `AnthropicFile`.**
  - **Considered.** Type-safe MIME types.
  - **Cons.** Anthropic returns whatever MIME type was uploaded; the API doesn't restrict the value. Closed enum would lose information for unexpected MIME types.
  - **Decision.** Open string.

- **Auto-merge Files API beta header into the messages-API requests too** (so messages-API calls with file_id blocks also include the beta header).
  - **Considered.** Required if the Anthropic Messages API needs the beta header to accept file-source documents.
  - **Cons.** Anthropic's documented behavior: only the Files-API endpoints require the beta header; Messages API consumes file_ids without it. Adding the header to messages would be vestigial. If Anthropic later requires it, revisit.
  - **Decision.** Files API endpoints only. Messages API request headers unchanged.

- **Add `listFiles()` method.**
  - **Considered.** Round out the CRUD surface.
  - **Cons.** Same rationale as M2.X.5.aa.z — not required for the upload+ref flow. Operators wanting to enumerate use Anthropic's SDK. Future M2.X.5.aa.z.2 if demand surfaces.
  - **Decision.** Upload + retrieve + delete only.

- **Make the Files API beta header configurable per-call.**
  - **Considered.** Future-proof against beta header version changes.
  - **Cons.** Operators don't typically pin beta versions; they want what works. The constant is updated when Anthropic releases a new beta. Configurability would let operators send wrong values.
  - **Decision.** Constant. Update when Anthropic releases new beta.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,847 tests** (+14 from M2.X.5.aa.z.1: 8 files-api module + 6 provider integration + the M2.X.5.aa.z anthropic-throw test reworked into a passthrough test). All green, zero type errors.
- **`FileReferenceContentBlock` is now operationally meaningful on two of four real provider paths.** OpenAI Responses + Anthropic both accept file_id natively; OpenAI Chat + Bedrock still throw.
- **Anthropic provider has full Files API CRUD.** Operators using Anthropic for document workflows no longer need to inline base64 every request.
- **Pattern set for future provider-specific multipart APIs.** Bedrock's batch / async-invoke endpoints, OpenAI's audio / image-generation endpoints — all could use the same per-provider multipart encoder shape.
- **The cross-provider file_id portability question is documented.** Operators understand file_ids are scoped to the provider that issued them.
- **`AnthropicContentBlock` document variant now has 4 source types.** Same shape as Anthropic's documented API; consumers exhaustively switching on `source.type` should compile-error and force handling.

## Open questions

- **Q1:** Should the kernel ship a `FileReferenceContentBlock.providerHint?: "openai" | "anthropic"` field for explicit provider scoping?
  - _Current direction:_ Out of scope. Operators manage provider-specific IDs in their own layer.
- **Q2:** Should there be a cross-provider file-id translation service (upload to one provider, get an id usable on another)?
  - _Current direction:_ Out of scope. Massive scope expansion; operators with multi-provider needs upload to both.
- **Q3:** Anthropic's `downloadable` field — should the kernel expose it as part of the `AnthropicFile` shape?
  - _Current direction:_ Already exposed (optional field). Operators inspect it directly.
- **Q4:** Files API beta header auto-pinning — should the version be locked to a specific value or read from a config?
  - _Current direction:_ Constant in `files-api.ts`. Manual update on Anthropic version bumps.
- **Q5:** Should `listFiles()` ship as M2.X.5.aa.z.2?
  - _Current direction:_ Wait for operator demand.
- **Q6:** Anthropic's Files API supports HTTP range requests for partial downloads — should we expose a `downloadFile(fileId, range?)` method?
  - _Current direction:_ Out of scope. Read-only use cases are uncommon; operators store originals in their own storage and use Anthropic's file_id as a reference only.
- **Q7:** Multi-tenancy: should the provider track which file_ids were uploaded by which tenant?
  - _Current direction:_ Out of scope. Operators implement tenant scoping in their layer (file_id → tenant_id mapping). Anthropic doesn't expose tenant data on the file resource.
