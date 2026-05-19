# ADR-0102: OpenAI Files API integration + FileReferenceContentBlock (Phase 2 M2.X.5.aa.z)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0097 (M2.X.5.aa DocumentContentBlock), ADR-0100 (M2.X.5.aa.x.1 office formats), ADR-0093 (M2.8.6 Responses API image inputs) |

## Context

M2.X.5.aa added inline-bytes documents. M2.X.5.aa.x.1 expanded to office formats. ADR-0097 Q3 noted the missing piece: OpenAI's Files API path. OpenAI's `/v1/files` endpoint accepts arbitrary file uploads (returning a `file_id`); the Responses API then accepts `{type: "input_file", file_id}` to reference uploaded files.

This unlocks workflows that the inline-bytes paths don't:

- **Large files** that would bloat every request if inlined.
- **Reused files** across multiple turns or sessions — upload once, reference many times.
- **Async / pre-processed uploads** — upload during user onboarding, reference in real-time chat later.
- **Files API ecosystem** — OpenAI's assistants / batch / fine-tune workflows reference files by ID too.

M2.X.5.aa.z ships the Files API client + a kernel content variant for `file_id` references.

## Decision

Five coordinated changes.

### 1. New `files-api.ts` module in `@crossengin/ai-providers-openai`

Pure types + multipart-encoder helper, no fetch:

```ts
export const OPENAI_FILES_PURPOSES = [
  "assistants", "batch", "fine-tune", "vision", "user_data",
] as const;
export type OpenAIFilesPurpose = (typeof OPENAI_FILES_PURPOSES)[number];

export interface OpenAIFile {
  id: string;            // "file-abc123"
  object: "file";
  bytes: number;
  created_at: number;
  filename: string;
  purpose: OpenAIFilesPurpose;
}

export interface OpenAIFileDeleteResponse {
  id: string;
  object: "file";
  deleted: boolean;
}

export function isOpenAIFilesPurpose(value: string): value is OpenAIFilesPurpose;
export function buildMultipartUpload(input): { body: Uint8Array; contentType: string };
```

`buildMultipartUpload` constructs a `multipart/form-data` request body with two parts (`purpose` + `file`). Boundary is randomized per call (`----CrossEnginFormBoundary<rand>`). Filename quotes are escaped per RFC 7578. Binary content is preserved byte-for-byte (verified by test).

### 2. `OpenAIProvider.uploadFile / .retrieveFile / .deleteFile`

```ts
async uploadFile(input: {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly purpose: OpenAIFilesPurpose;
  readonly contentType?: string;
}): Promise<OpenAIFile>;

async retrieveFile(fileId: string): Promise<OpenAIFile>;

async deleteFile(fileId: string): Promise<OpenAIFileDeleteResponse>;
```

Three methods covering the lifecycle:
- **upload** — POST `/v1/files` with multipart body. ContentType defaults to `application/octet-stream` if not provided.
- **retrieve** — GET `/v1/files/{id}`. Returns the file metadata (size, filename, purpose).
- **delete** — DELETE `/v1/files/{id}`. Returns `{deleted: true}` on success.

Validation: empty `filename` / empty `bytes` / invalid `purpose` / empty `fileId` all throw at the provider boundary before the fetch.

Error handling matches the rest of the provider — network errors via `fromNetworkError`, HTTP errors via `fromHttpResponse`, JSON parse errors via `OpenAIError({kind: "api_error"})`.

### 3. Widened `FetchLike` body type

```ts
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string | Uint8Array;   // was: string
    signal?: AbortSignal;
  },
) => Promise<...>;
```

Backwards-compatible widening — all existing `body: JSON.stringify(...)` calls still work. Required for the multipart upload path which carries binary content.

### 4. New kernel `FileReferenceContentBlock`

```ts
export const FileReferenceContentBlockSchema = z.object({
  type: z.literal("file_id"),
  fileId: z.string().min(1).max(120),
});
```

Eighth variant in the `LlmContentBlock` discriminated union. `fileId` is opaque text (typically `file-<24hex>` format from OpenAI but the kernel doesn't enforce shape). Role validation: rejected on tool messages (same rule as documents).

### 5. Per-provider translation

- **OpenAI Responses API** — `file_id` block → `{type: "input_file", file_id: block.fileId}`. The `OpenAIResponsesContentFileInput` union extends with a `OpenAIResponsesContentFileIdInput` variant.
- **OpenAI Chat Completions** — throws with `"use the Responses API path (defaultApiPath: 'responses') to reference uploaded files"` guidance.
- **Anthropic** — throws with `"OpenAI Files API is OpenAI-specific. Use a document block with inline bytes, or document_url with a publicly-accessible URL instead."`.
- **Bedrock** — throws with similar guidance.

The kernel exposes `file_id` as a generic content variant; only OpenAI Responses consumes it today. If Anthropic / Bedrock ship their own file-id systems later, their translators can add native handling.

## Cross-cutting invariants enforced

- **`fileId` validated at parse time.** Empty / > 120 char IDs fail at kernel parse.
- **`OpenAIFilesPurpose` is a closed enum.** Five documented purposes; invalid purposes throw at `uploadFile` boundary.
- **Multipart body preserves binary content.** Verified by test using a Uint8Array with `0x00`, `0xff` bytes.
- **Filename quotes are escaped.** RFC 7578 compliance — verified by test with `file"name".pdf`.
- **Boundary is unique per call.** Random suffix prevents body-collision in the unlikely case operators construct messages with the boundary literal.
- **Role validation for file_id matches document/image rules.** Rejected on tool messages.
- **HTTP errors surface as typed `OpenAIError`.** Verified by test (404 → `kind: "not_found_error"`).
- **Backwards compat for FetchLike.** All pre-M2.X.5.aa.z fetch callers pass `string` body unchanged.

## End-to-end semantic

```ts
const provider = new OpenAIProvider({
  apiKey: "sk-...",
  defaultApiPath: "responses",  // file_id references require Responses API
});

// Step 1: Upload the PDF once.
const file = await provider.uploadFile({
  bytes: pdfBuffer,
  filename: "policy.pdf",
  purpose: "user_data",
  contentType: "application/pdf",
});
// file.id = "file-abc123"

// Step 2: Reference it in chat (any number of turns, any number of sessions).
for await (const chunk of provider.complete({
  task: "executor",
  tenantId: "...",
  sessionId: "...",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Find the data retention clause" },
        { type: "file_id", fileId: file.id },
      ],
    },
  ],
})) {
  // ...
}

// Step 3 (later): retrieve metadata or delete the file.
const meta = await provider.retrieveFile(file.id);  // { bytes, filename, ... }
await provider.deleteFile(file.id);                  // { deleted: true }
```

Cross-provider operators routing to Anthropic / Bedrock will get a throw when the message contains a `file_id` block — same "use a different content variant" pattern as M2.X.5.aa.y / M2.X.5.aa.x.1.

## Alternatives considered

- **Auto-upload documents on `complete()` calls** (operator passes `document` block; provider uploads + uses file_id internally).
  - **Considered.** Operators get "magic" file-id semantics without explicit upload.
  - **Cons.** Hides cost (uploads are billed separately on Files API), removes lifecycle control, conflates content + storage. Operators wanting file_id should be explicit.
  - **Decision.** Explicit upload + reference. Operators manage the lifecycle.

- **Throw on file_id when targeting OpenAI Chat (instead of guidance pointing to Responses).**
  - **Considered.** Operators just see "this doesn't work" without next steps.
  - **Cons.** The Responses API path is the documented OpenAI solution. Pointing operators at it via the error message saves a doc lookup.
  - **Decision.** Throw with actionable guidance.

- **Add `listFiles()` method too.**
  - **Considered.** Round out the CRUD surface.
  - **Cons.** List endpoints are paginated + the M2.X.5.aa.z scope is "upload + reference + lifecycle for known file_ids." Operators wanting to enumerate files use OpenAI's official SDK. Future M2.X.5.aa.z.1 if demand surfaces.
  - **Decision.** Upload + retrieve + delete only.

- **Auto-set `Content-Type` from filename extension.**
  - **Considered.** Operators don't have to specify contentType for common files.
  - **Cons.** Adds magic. The `application/octet-stream` default works for OpenAI server-side detection. Operators who care provide it explicitly.
  - **Decision.** Default to `application/octet-stream`; explicit override only.

- **Use Node's `node:fetch` `FormData` API directly instead of manually building multipart.**
  - **Considered.** Less code; more robust.
  - **Cons.** `FormData` body isn't compatible with the current `FetchLike` type without further widening (FormData is a different object type). Manually-constructed Uint8Array bodies fit the existing pattern + are testable without mocking FormData.
  - **Decision.** Manual multipart encoder. Predictable + portable.

- **Make `OpenAIFilesPurpose` an open string union with documented values.**
  - **Considered.** Future OpenAI purpose additions don't require kernel updates.
  - **Cons.** Loses type safety + the four other current purposes are well-documented. Closed enum + future expansion as a tuple grow is the pattern in the rest of the workspace (e.g. `RETRYABLE_ERROR_KINDS`).
  - **Decision.** Closed enum.

- **Add the file_id type to OpenAI Chat Completions content too** (OpenAI added experimental support).
  - **Considered.** Chat Completions has experimental file_id support in some preview models.
  - **Cons.** Not stable / not GA. The Responses API is the canonical path. If/when Chat Completions stabilizes file_id, update the translator.
  - **Decision.** Throw on Chat. Operators use Responses path.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,833 tests** (+26 from M2.X.5.aa.z: 12 files-api module + 6 provider integration + 5 kernel + 1 Responses + 1 Bedrock throw + 1 Anthropic throw). All green, zero type errors.
- **ADR-0097 Q3 closed.** OpenAI Files API integration complete.
- **`LlmContentBlockSchema` now has 8 variants:** text, image, image_url, document, document_url, file_id, tool_use, tool_result. The kernel content surface covers the major multimodal + reference patterns across the three real providers.
- **OpenAI provider has full Files API CRUD.** Upload, retrieve, delete — operators manage file lifecycle without an external SDK.
- **Cross-provider asymmetry preserved + documented.** Anthropic + Bedrock + OpenAI Chat throw with consistent "use a different variant / Responses path" guidance.
- **`FetchLike.body` is widened.** Future binary-payload features (e.g. audio uploads, batch jobs) have a path.
- **Multipart encoder is reusable.** If a future provider needs multipart uploads, the same pattern applies.

## Open questions

- **Q1:** Should `listFiles()` ship in a follow-up M2.X.5.aa.z.1?
  - _Current direction:_ Wait for operator demand. The upload + retrieve + delete trio covers the common case.
- **Q2:** What about Anthropic's Files API (recently shipped)?
  - _Current direction:_ Anthropic added a Files API too. Future M2.X.5.aa.z.2 could add Anthropic-native file_id support — throw becomes passthrough. Currently still throws.
- **Q3:** Should the kernel `FileReferenceContentBlock` carry a `providerHint` field (e.g., `providerHint: "openai" | "anthropic"`)?
  - _Current direction:_ Out of scope. The kernel `fileId` is opaque text; provider semantics differ. If multi-provider file_id support ships, revisit.
- **Q4:** Should `uploadFile` accept a stream/ReadableStream instead of just `Uint8Array`?
  - _Current direction:_ Out of scope. Memory-resident bytes are sufficient for the M2.X.5.aa.z scope. Streaming uploads are a much bigger change.
- **Q5:** TTL / expiry handling — operators want to know when uploaded files expire?
  - _Current direction:_ `OpenAIFile.created_at` gives the timestamp; expiry depends on OpenAI's policy (currently 30 days for `user_data`). Operators handle this in their layer; the kernel just transports.
- **Q6:** Should the provider auto-detect content-type from filename extension when not provided?
  - _Current direction:_ `application/octet-stream` default is conservative. Operators provide explicit contentType for accurate detection.
- **Q7:** Integrate Files API into the chat substrate (auto-upload large documents before sending)?
  - _Current direction:_ Out of scope. Chat substrate work is M5.x. Operators manually upload + reference today.
