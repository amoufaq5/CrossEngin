# CLAUDE.md

Project state snapshot for AI assistants resuming work on this
codebase. Concise on purpose. Read top to bottom once, then keep
nearby.

## What this is

CrossEngin: AI-native multi-tenant platform. Three layers — a
kernel (multi-tenancy + meta-schema + DDL emit), declarative
manifests, and an AI Architect agent that authors them. ERP and
healthcare verticals ride on top.

## Where we are

Phase 2 M1 + M2 + M2.5 + M2.6 + M2.7 + M2.8 + M2.8.5 + M2.8.6 +
M2.9 + M2.9.5 + M2.9.6 + M2.9.7 + M2.9.8 + M2.9.8.x + M2.X +
M2.X.5 + M2.X.5.x + M2.X.5.y + M2.X.5.z + M2.X.5.aa +
M2.X.5.aa.x + M2.X.5.aa.x.1 + M2.X.5.aa.y + M2.X.5.aa.z +
M2.X.5.aa.z.1 + M2.X.5.aa.z.2 + M2.X.5.aa.z.3 + M2.X.6 +
M2.X.6.x + M2.X.7 + M2.X.8 + M2.X.9 + M2.X.10 + M3 +
M3.5 +
M3.6 + M3.7 + M4 + M4.5 + M4.6 + M4.7 + M4.7.5 + M4.7.6 + M4.8 +
M4.8.x + M4.8.y + M4.10 + M4.10.x + M5 + M5.5 + M5.6 + M5.7 +
M5.8 + M5.9 + M6 + M6.5 + M6.5.5 + M6.5.6 + M6.6 + M7 + M7-wire
+ M7.5 + M7.6.5 + M7.7 + M7.8 + M7.9 landed:
**55 packages + 1 app, 119 meta-schema tables, 6,891 tests**,
all green, no type errors. M2.X.5.aa.z.3 ships
`BedrockProvider.listBatches(options?)` against AWS Bedrock's
`ListModelInvocationJobs` control-plane endpoint. AWS does
not ship a Files API; batch inference is the closest
operational surface, and the same three workflows that
motivated `listFiles()` (tenant offboarding, storage audits,
reference reconciliation) all apply here. New `batch-api.ts`
module in `@crossengin/ai-providers-bedrock` exports
`BEDROCK_BATCH_JOB_STATUSES` (10-value const tuple matching
AWS's documented states: Submitted / InProgress / Completed /
Failed / Stopping / Stopped / PartiallyCompleted / Expired /
Validating / Scheduled), `BedrockBatchJobStatus` type +
`isBedrockBatchJobStatus` discriminator,
`BEDROCK_BATCH_SORT_BY_VALUES = ["CreationTime"]` +
`BEDROCK_BATCH_SORT_ORDER_VALUES = ["Ascending",
"Descending"]`, `BedrockBatchJobSummary` type mirroring AWS's
`InvocationJobSummary` (jobArn / jobName / modelId / roleArn
/ status / submitTime + s3InputDataConfig / s3OutputDataConfig
+ optional clientRequestToken / message / lastModifiedTime /
endTime / timeoutDurationInHours / jobExpirationTime /
vpcConfig), `BedrockBatchJobListResponse` ({invocationJob
Summaries, nextToken?} — nextToken omitted when absent/empty),
`buildBatchListQuery(options)` pure validator-builder
(statusEquals against tuple, maxResults int in [1, 1000],
nameContains length [1, 63], submitTimeAfter/Before parseable
via Date.parse, nextToken non-empty, sortBy/sortOrder against
tuples), and `parseBatchListResponse(raw)` strict parser.
`BedrockProvider.listBatches(options?)` GETs `/model-
invocation-jobs/` on the control-plane host with sig v4 +
sorted query string. Two-host model surfaced explicitly:
`controlPlaneBaseUrl` defaults to `https://bedrock.{region}.
amazonaws.com` (distinct from the existing `baseUrl` which
remains `https://bedrock-runtime.{region}.amazonaws.com`);
both use the same sig v4 service name (`bedrock`). New
private `signedControlPlaneGet({path, query})` helper threads
GET + empty body + URI-encoded query string through
`signRequest` (the `query` parameter on `signRequest` was
already supported since M2.9). Validation fast-fails BEFORE
the fetch — out-of-range maxResults / unknown statusEquals /
unparseable dates throw `BedrockError` with
`invalid_request_error` kind without burning a request. Errors
route through existing `fromHttpResponse` / `fromNetworkError`
helpers (AccessDeniedException → permission_error,
ThrottlingException → rate_limit_error, etc.). Bedrock now
has a read-only operational surface: pre-M2.X.5.aa.z.3 only
inference + embed methods existed. Three-provider enumeration
parity achieved (OpenAI listFiles, Anthropic listFiles,
Bedrock listBatches). Pattern set for future Bedrock control-
plane methods (getBatch, listGuardrails, listImportedModels,
listInferenceProfiles, listCustomModels) — same
signedControlPlaneGet rail. M2.X.5.aa.z.2 added `listFiles()`
to both OpenAI and Anthropic Files API surfaces, completing
the CRUD+list pattern. Closes ADR-0102 Q1 + ADR-0103 Q5.
Response types `OpenAIFileListResponse` and `AnthropicFile
ListResponse` were already defined in M2.X.5.aa.z /
M2.X.5.aa.z.1 — only the methods + tests are new.
`OpenAIProvider.listFiles({purpose?, limit?, order?, after?})`
GETs `/v1/files` with optional query params; limit validated
to [1, 10000]; purpose validated against
OPENAI_FILES_PURPOSES. `AnthropicProvider.listFiles({limit?,
beforeId?, afterId?, order?})` GETs `/v1/files` with the beta
header; limit validated to [1, 1000] (Anthropic's documented
max); camelCase kernel params translated to snake_case HTTP
params (`before_id`, `after_id`). Provider-native response
shapes preserved (OpenAI: just `{object, data}`; Anthropic:
`{data, has_more, first_id, last_id}`) — the kernel doesn't
try to unify pagination semantics. Use cases unblocked:
tenant offboarding (find + bulk-delete by tenant), storage
audits (total bytes by purpose), reference reconciliation
(diff operator records against provider state). M2.X.5.aa.z.1 ships Anthropic Files
API + makes the kernel `FileReferenceContentBlock` work
natively on Anthropic. Closes the throw from M2.X.5.aa.z. New
`files-api.ts` module in `@crossengin/ai-providers-anthropic`
exports `ANTHROPIC_FILES_BETA_HEADER = "files-api-2025-04-14"`
const, `AnthropicFile` / `AnthropicFileDeleteResponse` /
`AnthropicFileListResponse` types, and
`buildAnthropicMultipartUpload({bytes, filename, contentType?})`
encoder. Differs from OpenAI's encoder in two ways: NO purpose
field (Anthropic doesn't classify uploads), multipart body has
ONE part (just `file`). Same RFC 7578 quote escaping, random
per-call boundary, byte-for-byte binary preservation.
`AnthropicProvider` gains `uploadFile / retrieveFile /
deleteFile` methods POSTing/GETting/DELETEing `/v1/files` with
the beta header always present. `filesApiBetaHeader()` helper
merges + deduplicates against any operator-set `anthropicBeta`
constructor option. `FetchLike.body` widened from `string` to
`string | Uint8Array` (backwards-compatible). `AnthropicContent
Block` document variant gained a 4th source variant
`{type: "file", file_id}` alongside base64/url/text. Translator
removes the throw and emits `{type: "document", source:
{type: "file", file_id}, ...}` for kernel `file_id` blocks.
Cross-provider matrix updated: file_id now works natively on
OpenAI Responses + Anthropic; OpenAI Chat + Bedrock still throw
with actionable guidance. file_ids are NOT portable across
providers (operators upload to each provider they target). M2.X.5.aa.z adds full OpenAI Files
API integration: kernel `FileReferenceContentBlock` (8th
variant in LlmContentBlock discriminated union) +
`OpenAIProvider.uploadFile / .retrieveFile / .deleteFile`
methods. Closes ADR-0097 Q3. New types: `FileReferenceContent
BlockSchema = {type: "file_id", fileId: string.min(1).max(120)}`
(opaque text — kernel doesn't enforce the file-<24hex> shape).
Role validation: file_id rejected on tool messages (same rule
as documents/images). New OpenAI module `files-api.ts`
exports `OPENAI_FILES_PURPOSES = ["assistants", "batch",
"fine-tune", "vision", "user_data"]`, `OpenAIFile` /
`OpenAIFileDeleteResponse` types, `isOpenAIFilesPurpose`
discriminator, and `buildMultipartUpload(input)` —
manually-constructed multipart/form-data encoder producing
Uint8Array body + boundary-aware Content-Type. Random
per-call boundary (`----CrossEnginFormBoundary<rand>`); RFC
7578 quote escaping in filenames; binary content preserved
byte-for-byte. `OpenAIProvider` gained 3 methods:
`uploadFile({bytes, filename, purpose, contentType?})` POSTs
to `/v1/files` with multipart body; `retrieveFile(fileId)`
GETs `/v1/files/{id}`; `deleteFile(fileId)` DELETEs same
path. `FetchLike.body` widened from `string` to `string |
Uint8Array` (backwards-compatible). Per-provider translation:
OpenAI Responses API natively passes through to `{type:
"input_file", file_id}` (`OpenAIResponsesContentFileInput`
becomes a union of file_data + file_id variants); OpenAI Chat
Completions + Anthropic + Bedrock all THROW with actionable
"use Responses API path" / "use document block with inline
bytes" guidance. M2.X.10 enforces OpenAI's name
regex at the kernel layer + threads `LlmMessage.name` through
OpenAI Chat Completions on all four message roles (system,
user, assistant, tool). Pre-M2.X.10 only the tool-role
translator carried `name`; other roles silently dropped it.
New kernel exports `LLM_MESSAGE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/`
+ `LlmMessageNameSchema` (OpenAI's documented rules: 1-64
chars, alphanumeric + underscore + hyphen). Bad names fail at
zod parse time instead of as HTTP 400 from OpenAI. Anthropic +
Bedrock + OpenAI Responses silently DROP `name` at translation
(those APIs have no name field). Operators with multi-agent
orchestration on OpenAI Chat get first-class participant
attribution; cross-provider workflows aren't blocked because
of the silent-drop policy. Pre-M2.X.10 tool-role threading
preserved (regression-tested). M2.X.5.aa.x.1 expands the document
format enum from 4 to 9 formats by adding the office set
(doc, docx, xls, xlsx, html). Matches Bedrock Converse API's
full document-format set. Closes ADR-0099 Q1. New helpers
`OFFICE_DOCUMENT_FORMATS = ["doc", "docx", "xls", "xlsx",
"html"]` const tuple + `isOfficeDocumentFormat(format)`
discriminator. `documentMediaType` MIME map extended with the
5 office formats (application/msword,
application/vnd.openxmlformats-officedocument.wordprocessingml.
document, application/vnd.ms-excel,
application/vnd.openxmlformats-officedocument.spreadsheetml.
sheet, text/html). Per-provider: Bedrock translator
unchanged — already accepted all 9 formats; office formats
pass through natively. Anthropic gains an explicit throw
branch (BEFORE the text-format dispatch) for office formats
with conversion guidance: "convert to PDF, or use a different
provider (Bedrock supports office formats natively)". OpenAI
Responses gains an `isOfficeDocumentFormat` check + throw with
same conversion guidance. OpenAI Chat unchanged (still throws
on all documents). Operators using Bedrock get full 9-format
support; cross-provider workflows convert office documents to
PDF client-side. M2.X.5.aa.x expands the document
format enum from `["pdf"]` to `["pdf", "txt", "md", "csv"]`,
closing ADR-0097 Q1 (partially — office formats deferred).
New kernel helpers: `documentMediaType(format)` (single source
of truth for MIME-type mapping: application/pdf, text/plain,
text/markdown, text/csv); `isTextDocumentFormat(format)`
(discriminator between PDF and text formats). Per-provider:
Bedrock translator unchanged — the BedrockDocumentContentBlock.
format type already accepted the broader Bedrock format set;
all 4 kernel formats pass through natively. Anthropic
translator becomes format-aware — PDF uses the existing
`source: {type: "base64", media_type: "application/pdf"}`
shape; txt/md/csv use the new `source: {type: "text",
media_type, data}` shape with bytes decoded from base64 to
UTF-8 via Node's Buffer. AnthropicContentBlock document
variant extended with the text source. OpenAI Responses
translator uses `documentMediaType` for the data URL MIME
prefix — all 4 formats flow as input_file with correct MIME.
OpenAI Chat still throws (no document support). Office formats
(doc/docx/xls/xlsx/html) deferred to future milestone — only
Bedrock supports them natively; adding now would create
two-provider throw asymmetry. Document parity post-M2.X.5.aa.x:
4 formats × 3 providers (Bedrock + Anthropic + OpenAI
Responses) all native. M2.X.5.aa.y adds a URL-based document
variant alongside the M2.X.5.aa bytes variant, closing ADR-0097
Q2. New `DocumentUrlContentBlock` type `{type: "document_url",
url: string, format?: DocumentFormat, name?: string<120}` added
to the LlmContentBlock discriminated union (grows from 6 to 7
variants). URL validated via `z.string().url()` at parse time;
format + name both optional (URL Content-Type provides format
hint; provider-side defaults apply where needed). Same role rule
as document (rejected on tool messages). Per-provider
translation: Anthropic passes URL through to `{type: "document",
source: {type: "url", url}, title?}` (native support, same shape
as the M2.X.5.z URL image variant); Bedrock + OpenAI Responses +
OpenAI Chat all THROW with actionable pre-fetch / use-Files-API
guidance. Three of four provider paths throw — same asymmetry
as image_url (M2.X.5.y). Document parity post-M2.X.5.aa.y: bytes
on Bedrock + Anthropic + OpenAI Responses; URLs on Anthropic
only. Operators with mixed-provider workflows pre-fetch URLs to
bytes when targeting non-Anthropic providers. M2.X.5.aa adds a `DocumentContentBlock`
variant to the kernel content union for PDF inputs, closing
ADR-0096 Q7. New types in `@crossengin/ai-providers/src/types.ts`:
`DOCUMENT_FORMATS = ["pdf"]` const tuple (singleton; future
expansion purely additive), `DocumentFormat` type,
`DocumentContentBlockSchema = {type: "document", format,
bytes, name?: string<120}`. `LlmContentBlockSchema` discriminated
union grows from 5 to 6 variants. Same role rule as images
(rejected on tool messages). Per-provider translation: Bedrock
emits `{document: {format, name, source: {bytes}}}` (defaults
name to "document"); Anthropic emits `{type: "document", source:
{type: "base64", media_type: "application/pdf", data}, title?}`
(maps kernel `name` → Anthropic `title`); OpenAI Responses API
emits `{type: "input_file", filename, file_data: "data:
application/pdf;base64,<bytes>"}` (defaults filename to
"document.<format>"); OpenAI Chat Completions THROWS with
actionable error message pointing to the Responses API path.
Both `BedrockDocumentContentBlock` and `OpenAIResponses
ContentFileInput` added to their respective provider unions.
Anthropic's `AnthropicContentBlock` gains the document variant
with both base64 + url source types (URL variant added for
future M2.X.5.aa.y). Provider asymmetry: three of four real
provider paths support PDFs natively; OpenAI Chat throws with
actionable "use Responses API path" guidance. M2.X.5.z removes the M2.X.5.y throw
in the Anthropic translator + threads URLs through to
Anthropic's native URL source variant, closing ADR-0094 Q3.
Anthropic recently added URL source support; the
`AnthropicContentBlock` image source becomes a discriminated
union on `source.type`: existing `{type: "base64", media_type,
data}` variant unchanged + new `{type: "url", url}` variant
added. `translateKernelBlock` for `image_url` now returns
`{type: "image", source: {type: "url", url: block.url}}`
instead of throwing. Provider parity for URL-based images is
now: OpenAI Chat Completions ✓, OpenAI Responses ✓, Anthropic
✓. Bedrock ✗ (still throws — Bedrock's image source format
has no URL variant; operators with cross-provider URL workflows
pre-fetch bytes when targeting Bedrock). Format hint dropped on
URL path (Anthropic infers from response Content-Type). The
existing M2.X.5.y throw test was replaced with two passthrough
tests: pure URL translation + mixed bytes + URL in same
message. M2.X.9 adds the third kernel-level
cross-provider error classifier: `isInputTooLargeError(err)`.
Follows the same shape as M2.X.6.x (`isModerationError`) and
M2.X.7 (`isRetryableError`) — duck-types on `.kind` against a
shared tuple. New `input-too-large.ts` module exports
`INPUT_TOO_LARGE_ERROR_KINDS = ["request_too_large"]`
(singleton tuple — all three providers map HTTP 413 to this
kind via their classifyHttpStatus paths),
`InputTooLargeErrorKind` type, `isInputTooLargeErrorKind`
discriminator, `InputTooLargeDiscriminator` interface, and the
headline predicate. The kernel surface now partitions the
error space into four buckets: retryable (try again with
backoff), moderation (terminal; audit), input-too-large
(terminal; reduce input), other (auth / permission /
invalid_request / unknown — terminal; surface to user).
Operators classifying errors across providers use three
parallel discriminators with no provider-package imports:
isModerationError + isRetryableError + isInputTooLargeError.
Mutual exclusivity verified by tests: a request_too_large
error is NOT retryable + NOT a moderation event.
Cross-package integration tests in all three providers verify
the predicate works against their native error classes.
Pattern continues to scale — adding a fourth classifier (e.g.
isSafetyFilterError if a provider ships a distinct kind) is an
additive tuple expansion. M2.X.5.y adds a URL-based image
variant to the kernel content union, closing ADR-0093 Q1. New
`ImageUrlContentBlock` type `{type: "image_url", url: string,
format?: ImageAttachmentFormat}` added to the LlmContentBlock
discriminated union (grows from 4 to 5 variants: text, image,
image_url, tool_use, tool_result). URL validated via
`z.string().url()` at parse time; `format` optional (URL
responses' Content-Type tells the provider). Same role rule as
image (rejected on tool messages). Per-provider translation:
OpenAI Chat Completions passes the URL through to `image_url:
{url}` (URL passthrough, OpenAI fetches server-side); OpenAI
Responses API passes through to `input_image: {image_url: url}`;
Bedrock + Anthropic THROW with explicit error message ("pre-
fetch the URL to base64 bytes and use an image block
instead") — both providers require base64 inline. Auto-
fetching deferred (operator code owns timeout / retry / cache /
SSRF policy). Payload size + latency win for OpenAI users: a
5 MB image URL is 100 bytes in the request vs ~6.7 MB inline
base64. Pattern set for future URL-only variants (audio_url,
video_url). All 6,713 pre-M2.X.5.y tests pass unchanged; 13
new tests verify URL validation, role rules, OpenAI Chat /
Responses pass-through, Bedrock + Anthropic throw semantics.
M2.8.6 threads `ImageContentBlock`
through the OpenAI Responses API path, closing ADR-0088 Q6.
Pre-M2.8.6 the Responses-API translator used `contentToText`
throughout — array content was flattened to text only, silently
dropping any image blocks. New `OpenAIResponsesContentImage
Input` type `{type: "input_image", image_url: string}` added
to the `OpenAIResponsesContentBlock` discriminated union
(grows from 2 to 3 variants: input_text, input_image,
output_text). New private `buildUserInputBlocks` helper walks
user content: string → single input_text; array content
walks each block (text → input_text, image → input_image
with `data:image/<format>;base64,<bytes>` URL matching
Chat Completions format; tool_use/tool_result skipped — they
flow via top-level function_call_output items or are kernel-
schema rejected on user role). Attachments field flows into
input_image blocks for M2.X backwards compat. Block order
preserved. Empty text blocks filtered. Empty result emits a
single empty input_text block (Responses API rejects empty
content arrays). All 19 pre-M2.8.6 Responses-API tests pass
unchanged; 7 new tests verify image-input threading,
backwards compat, attachment paths, 4 image formats, mixed
text/image ordering, empty filtering. OpenAI provider now has
full multimodal parity across both API paths. M2.X.8 ships standalone OpenAI
Moderations API support in `@crossengin/ai-providers-openai`,
closing ADR-0086 Q1. New `moderations-api.ts` module exports
`OPENAI_MODERATION_MODELS` (4 models: omni-moderation-latest as
default + 2024-09-26 dated + 2 legacy text-moderation models),
`OPENAI_MODERATION_CATEGORY_KEYS` (11 documented categories),
`buildModerationRequest` (input validation: rejects empty
string / empty array / array-with-empty-string at build time),
`normalizeModerationResponse` (folds raw response into
`{model, anyFlagged, results, flaggedCategoriesPerResult}` —
operator-facing summary plus raw results preserved),
`highestCategoryScore(result)` (returns top scoring category,
useful for soft-threshold policies). `OpenAIProvider.moderate
({input, model?})` POSTs to `/v1/moderations` with same
network / HTTP / parse error handling as other endpoints.
`OpenAIProviderOptions.defaultModerationModel?` validated at
construction; unsupported model throws synchronously. Input
accepts `string | readonly string[]` (batch up to 32 strings
per OpenAI's docs); per-call `model` override checked at call
time. Use cases: pre-screen user input before paying for a
chat call ($0.0001 moderation vs $0.005+ chat), bulk content
audits, soft-threshold risk scoring. Provider-specific method
(not on `LlmProvider` interface) because Anthropic + Bedrock
don't expose standalone moderation endpoints. M6.6 migrates `@crossengin/ai-router`
to use the kernel cross-provider helpers, validating M2.X.6.x
+ M2.X.7 with a real non-test consumer + closing a latent bug
exposed by M2.X.5. Three coordinated changes in retry.ts +
router.ts: (1) retry.ts's local `isRetryableError` becomes a
hybrid predicate — checks kernel's kind-based `isRetryableError`
first (the M2.X.7 path); falls back to the legacy `isRetryable()`
method-based duck-typing for compat with custom error classes.
(2) router.ts's `isRouterRetryable` gains an explicit
`isModerationError(err) → false` early-exit BEFORE delegating
to `isRetryableError`. Documents intent: moderation events
never trigger fallback to alternate providers (the input
itself triggered the policy violation; switching providers
won't help). Pre-M6.6 the correct behavior was accidental
(moderation errors return false from each provider's
`isRetryable()`); post-M6.6 it's explicit + tested. (3)
`estimateRequestTokens` bug fixed — was using
`m.content.length` which broke after M2.X.5 (returned block
count for array content, not char count); now uses
`contentToText(m.content).length` which handles both string +
LlmContentBlock[] shapes correctly. Three new router tests
verify: refusal from primary does NOT trigger fallback;
guardrail_intervened same; rate_limit_error DOES trigger
fallback. Six new retry tests verify the kernel-kind shape
works: errors with `.kind: "rate_limit_error" |
"network_error" | "model_stream_error"` are classified
retryable; moderation kinds + auth_error are not. All 51
existing router tests + 14 existing retry tests pass
unchanged. M2.X.7 adds a kernel-level
cross-provider retryability helper to `@crossengin/ai-providers`,
mirroring M2.X.6.x for the second cross-cutting error concern.
Closes ADR-0087 Q3. New `retryable.ts` module exports
`RETRYABLE_ERROR_KINDS` const tuple ([rate_limit_error,
overloaded_error, network_error, timeout_error, api_error,
model_stream_error] — the UNION of all three providers'
retryable sets; Bedrock-specific model_stream_error included so
kernel agrees with Bedrock's local classification),
`RetryableErrorKind` type, `RetryableDiscriminator` interface,
`isRetryableErrorKind(value)` string discriminator, and the
headline predicate `isRetryableError(err): err is Error &
{kind: RetryableErrorKind}`. Same duck-typing approach as
`isModerationError`: inspects `err.kind` against the shared
tuple. No changes to provider error classes; their existing
local `RETRYABLE_KINDS` sets + `isRetryable()` methods continue
to work. Cross-package integration tests in all three real
providers verify the kernel helper agrees with the provider's
local isRetryable() method for each shared kind; moderation +
auth kinds correctly return false. Symmetric API surface:
operators have parallel discriminators `isModerationError` +
`isRetryableError`, both narrow `.kind`, both work across
providers, neither requires provider-package imports. Pattern
set for future third cross-provider concern. M2.X.5.x adds `tool_use` +
`tool_result` content block variants to the kernel
`LlmContentBlock` discriminated union, consolidating the
tool-call surface. New types in `@crossengin/ai-providers/src/
types.ts`: `ToolUseContentBlock` (`{type: "tool_use", id, name,
input}`), `ToolResultContentBlock` (`{type: "tool_result",
toolUseId, content, status?: "success" | "error"}`), and the
`TOOL_RESULT_STATUSES` const tuple. LlmMessageSchema's
superRefine validates role-bound semantics: tool_use only on
assistant role, tool_result only on user or tool role, image
NOT allowed on tool messages (text-only by convention). All
three provider translators handle the new blocks: Bedrock
emits `{toolUse: {toolUseId, name, input}}` and `{toolResult:
{toolUseId, content: [{text}], status?}}`; Anthropic emits
`{type: "tool_use", id, name, input}` and `{type: "tool_result",
tool_use_id, content}`. OpenAI required a flatMap refactor —
`translateMessage` now returns `OpenAIChatMessage[]` because a
single kernel user message with tool_result blocks splits into
multiple OpenAI messages (tool-role per result + user-role with
remaining text). buildOpenAIChatRequest switched from `.map` to
`.flatMap`. Hybrid support: a single assistant LlmMessage can
mix the legacy `toolUses` field with inline `tool_use` content
blocks; OpenAI merges both into one `tool_calls` envelope array.
Bidirectional field compat: the legacy `LlmMessage.toolUses`
field + `role: "tool"` messages continue working unchanged;
operators can mix legacy + canonical patterns. Unblocks
parallel tool calls in a single assistant turn, bundled tool
results in a single user turn, and arbitrary text/tool
interleaving without losing order. M2.X.5 lifts the kernel
`LlmMessage.content` from `string` to a discriminated union
`string | LlmContentBlock[]`, closing the M2.X asymmetry where
user messages could carry images (via `attachments`) but
assistant messages could only emit text. New types in
`@crossengin/ai-providers/src/types.ts`: `TextContentBlock` +
`ImageContentBlock` (flat shape `{type, format, bytes}`
matching ImageAttachment for symmetry), `LlmContentBlock`
discriminated union, `LlmContent` union, and four helpers —
`isStringContent`, `isBlockContent`, `normalizeContent`
(string → `[{type: "text", text}]`), `contentToText` (extracts
text from blocks, joins, ignores images). LlmMessageSchema's
superRefine gains validation: array content + attachments
together is REJECTED (mutually exclusive); string content +
attachments still valid (M2.X backwards compat). Empty arrays
rejected via `.min(1)`. All three provider message-builders
gained a private `appendKernelBlocks(out, content)` helper
that branches on `typeof content` — Bedrock pushes
`{text}` / `{image: {format, source: {bytes}}}`, Anthropic
pushes `{type: "text", text}` / `{type: "image", source:
{type: "base64", media_type: "image/<format>", data}}`,
OpenAI pushes `{type: "text", text}` / `{type: "image_url",
image_url: {url: "data:image/<format>;base64,<bytes>"}}`.
Assistant messages with array content now emit provider-
native content arrays instead of strings — unblocks image-
generation responses and any future multimodal assistant
output. Backwards compat: 90+ existing string-content call
sites pass unchanged; verified by full pre-M2.X.5 test suite
running at 6,588. The OpenAI Responses API path uses
`contentToText` throughout (its top-level shape doesn't
support inline image parts the same way; image content is
silently dropped — future M2.8.6). Pattern set for future
content variants (audio / video / document) — append to the
discriminated union + update each provider's translator. M2.X.6.x adds a kernel-level
cross-provider moderation helper to `@crossengin/ai-providers`,
closing ADR-0084 Q7 + ADR-0086 Q3. New `moderation.ts` module
exports `MODERATION_ERROR_KINDS` const tuple ([
"guardrail_intervened", "content_filtered", "refusal"] — the
union of moderation-event kinds across Bedrock, OpenAI, and
Anthropic), `ModerationErrorKind` type, `ModerationDiscriminator`
interface, `isModerationErrorKind(value)` string discriminator,
and the headline predicate
`isModerationError(err): err is Error & {kind: ModerationErrorKind}`.
Duck-typing approach: inspects `err.kind` against the shared
tuple; works against any error class whose `.kind` matches the
moderation slice. No changes to provider error classes —
`BedrockGuardrailViolationError`, `OpenAIContentFilteredError`,
`AnthropicRefusalError` are byte-identical to M2.9.8 / M2.X.6;
they already set `.kind` to the right string values. Type
narrowing: inside the predicate's true branch, `err.kind`
narrows to `ModerationErrorKind` — verified by a TS assignment
test. Robust against non-Error inputs (null / undefined /
primitives / objects without `kind` / objects with non-string
`kind`). Cross-package integration tests in all three real
providers verify their error classes flow through the kernel
helper. Operators using the router catch one error shape
instead of three:
  if (isModerationError(err)) auditViolation(err.kind);
Pattern set for future kernel-level cross-provider helpers
(retryability, token-limit detection). Forward-compatible: a
fourth provider's novel moderation kind just gets appended to
the tuple. M2.X.6 ships parallel moderation
surfaces in `@crossengin/ai-providers-openai` and
`@crossengin/ai-providers-anthropic`, matching M2.9.8's pattern.
New `moderation.ts` module in each package exports a typed
error class (`OpenAIContentFilteredError extends OpenAIError`,
`AnthropicRefusalError extends AnthropicError`) plus
discriminator helpers (`isContentFilterFinishReason` /
`isContentFilteredResponse`, `isRefusalStopReason` /
`isRefusalResponse`) and the relevant stop-reason constants
(`OPENAI_CONTENT_FILTER_FINISH_REASON = "content_filter"`,
`ANTHROPIC_REFUSAL_STOP_REASON = "refusal"`). Both providers'
`_ERROR_KINDS` grow by one (`content_filtered` /  `refusal`);
neither is in `RETRYABLE_KINDS`. Schema extension: Anthropic's
`AnthropicResponse.stop_reason` union now includes `"refusal"`
(OpenAI's `finish_reason` already had `"content_filter"`).
Streaming detection: both `chunksFromSse` / `readSseStream`
generators track a contentFiltered / refused flag in stream
state; at the appropriate event (`finish_reason: "content_
filter"` for OpenAI, `message_delta.delta.stop_reason: "refusal"`
for Anthropic), set the flag without throwing; after yielding
`usage_final` normally, throw the typed error. Same
post-usage_final-throw ordering as M2.9.8 — cost accounting
flows even on moderation. Non-streaming asymmetry preserved:
`completeNonStreaming` returns the raw response; callers use
the discriminator helpers to detect. Cross-provider error
landscape: all three real providers now throw non-retryable
typed errors on moderation events. The shared `content_filtered`
kind name between Bedrock + OpenAI is intentional — operators
classifying logs by `error.kind` get matching coverage.
ADR-0084 Q7 (cross-provider abstraction) now has three concrete
data points to reason about; revisit in future M2.X.6.x if
patterns stabilize. Zero kernel changes: `CompletionRequest`,
`CompletionChunk`, `LlmProvider` interface — all untouched.
M2.9.8.x adds two new public methods
to BedrockProvider for per-request guardrail override:
`completeWithGuardrail(req, guardrailOverride?)` (streaming) +
`completeNonStreamingWithGuardrail(req, guardrailOverride?)`
(non-streaming). Three-state override semantics:
`BedrockGuardrailConfig` → use this config (validated at call
time via buildBedrockGuardrailConfig); `null` → explicitly
DISABLE the provider's default guardrail for this request;
`undefined` (or omitted) → fall back to provider default.
Closes ADR-0084 Q3. Internal refactor: `complete()` and
`completeNonStreaming()` now delegate to private
`completeInternal` / `completeNonStreamingInternal` taking the
effective resolved guardrail explicitly; the duplicated
`guardrailConfig` spread sites are unified. Validation timing
preserved: bad override identifier/version/trace throws BEFORE
the fetch (rejected promise for non-streaming). The kernel
`LlmProvider.complete(req)` interface is untouched — operators
wanting per-request overrides use the Bedrock-specific
sibling methods directly, bypassing the router. Operationally
unblocks: per-tenant guardrail tiers (Bronze/Gold compliance
packs), A/B testing content policies, admin escape hatches
(`null` override skips filtering for security-ops inspection),
mixed-sensitivity workloads (trial users get stricter PII
redaction than enterprise customers). M2.9.8 wires AWS Bedrock Guardrails
into `@crossengin/ai-providers-bedrock` as an opt-in safety
surface. New `guardrails.ts` module exports
`BedrockGuardrailConfig` ({guardrailIdentifier, guardrailVersion,
trace?: "enabled"|"disabled"}), `buildBedrockGuardrailConfig`
(slug-regex validator: identifier `^[a-z0-9]{6,16}$`, version
`^(DRAFT|[1-9][0-9]{0,4})$`), `BedrockGuardrailViolationError
extends BedrockError` (carries `stopReason` ∈
{guardrail_intervened, content_filtered} + optional `trace`),
plus discriminators `isBedrockGuardrailInterventionStopReason`
+ `isGuardrailInterventionResponse`. `BEDROCK_ERROR_KINDS`
grows by two — both non-retryable. `BedrockConverseRequest`
gains optional `guardrailConfig` field; `buildBedrockConverse
Request` threads it from `BuildConverseRequestOptions`; OMITTED
from request body when undefined (byte-identical to pre-M2.9.8
for unguarded providers). `BedrockProviderOptions.guardrailConfig?`
validates at construction time (fast-fail on bad config); stored
on the instance; passed to both `complete()` (streaming) and
`completeNonStreaming()`. The event-stream parser now tracks a
`ConverseStreamState` ({toolBlocks, pendingIntervention,
guardrailTrace}) instead of just a Map. At `messageStop` with an
intervention `stopReason`, the parser SETS the pending flag but
does NOT throw — `metadata` event still fires + yields
`usage_final` for cost accounting; the parser also pulls
`trace.guardrail` if present. AFTER the stream loop ends with
pendingIntervention set, throws `BedrockGuardrailViolationError`
{stopReason, trace}. Consumer ordering: text/tool chunks →
usage_final → throw. Non-streaming asymmetry: returns the raw
`BedrockConverseResponse` with `stopReason` already typed to
include the intervention values; callers inspect via
`isGuardrailInterventionResponse(response)` rather than catching
an error. `BedrockGuardrailViolationError extends BedrockError`
so `instanceof BedrockError` keeps working; the `kind` field
discriminates. Router automatically treats guardrail violations
as terminal (no retry burn). M4.10.x adds a `--by-source-pack`
flag to `gateway routes unregister-pack`, exposing M4.10's
`deleteByPackSlug` API at the CLI. When set, the entire
manifest pipeline (resolvePack → resolveManifest →
tryValidateManifest → generatePackRoutes) is skipped; the
handler issues a single `DELETE WHERE source_pack = $1`
(or `listByPackSlug` + table render under --dry-run).
Operationally unblocks three real scenarios: decommissioned
packs (slug no longer in the registry → resolvePack would
throw UnknownPackError), broken manifests (resolveManifest
fails on ExtendsCycle / UnknownParent), and forgotten old
versions (manifest changed; M4.8.x's default path would only
delete the CURRENT generation, leaving old routes orphaned).
Slug validation is enforced at the CLI boundary via the same
regex as the DB CHECK + zod schema (`^[a-z][a-z0-9-]*
(\/[a-z][a-z0-9-]*)*$`); invalid slug → exit 2. Dispatcher
short-circuit updated: `--by-source-pack` always needs PG (the
--dry-run path reads via listByPackSlug), so the
register-pack/unregister-pack PG-free short-circuit excludes
`unregister-pack --by-source-pack`. Output shapes: human
"deleted N route(s) where source_pack = 'X'" (live) or
"-- dry-run: N route(s) would be deleted (by source_pack =
'X')" (preview); JSON {pack, bySourcePack: true, deleted,
dryRun} (live) or {pack, bySourcePack: true, count, dryRun:
true, routes[{id, method, operationId}]} (preview). The
`bySourcePack: true` field is the schema discriminator for
consumers parsing M4.8.x vs M4.10.x output. Existing M4.8.x
default path unchanged — verified by test: `unregister-pack
<slug>` without the flag still issues N per-id DELETEs from
the manifest-derived ID set. M4.10 adds a `source_pack TEXT`
column (nullable + indexed + slug-pattern CHECK) to
META_GATEWAY_ROUTES, closing the three open questions across
ADR-0079/0080/0081 about which pack owns which route. The
column is set by `generatePackRoutes` to the pack slug on
every CRUD + transition route; routes registered via
`gateway routes register <route.json>` default to NULL.
`RouteDefinitionSchema` gains `sourcePack: z.string().regex
(/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/).max(120).nullable
().default(null)`. `PostgresRouteRegistry` upsert grows to
16 INSERT params + ON CONFLICT writes `source_pack =
EXCLUDED.source_pack`; new methods `listByPackSlug(slug)` +
`deleteByPackSlug(slug): Promise<number>` add bulk
source-attribution queries; all three SELECT call sites
(`listAll`, `loadCompiled`, `listByPackSlug`) factor through
a shared `SELECT_COLUMNS` constant. `runRoutesSyncPack`
classification expands from three buckets to four: `added`
(generated − stored), `persistent` (generated ∩ stored),
`obsolete` (stored with sourcePack === slug, not in current
generation — SAFE to prune), `external` (stored with
sourcePack !== slug or NULL — NEVER pruned). New flag
`--prune-obsolete` opt-in deletes obsolete routes; safely
no-ops on legacy NULL-attributed routes. JSON shape gains
{obsolete, obsoleteIds[], pruned, pruneObsolete} alongside
the existing {added, persistent, external, externalIds[]}.
Human output names the obsolete bucket separately with
"use --prune-obsolete to delete" hint. Backwards compatible:
pre-M4.10 routes survive with NULL source_pack (no
auto-classification); operators backfill by re-running
register-pack which now writes the slug via ON CONFLICT.
Eleven RouteDefinition construction sites across 9 files
updated to include `sourcePack: null` — TS strict catches
any missed site at compile time. M4.8.y completes the three-verb
gateway-routes pack vocabulary: `crossengin gateway routes
sync-pack <slug> [--api-version v1] [--dry-run] [--created-by
<uuid>]`. Re-generates the desired route set, calls
`registry.listAll()` for the stored set, classifies route IDs
into three buckets: `added` (generated but not stored —
will be upserted), `persistent` (in both — will be refreshed
via upsert), `external` (in stored but not generated — left
alone, reported). Upserts all generated routes (both buckets);
NEVER deletes external routes — without a `source_pack`
column or previous-manifest snapshot we cannot reliably
classify them as "obsolete from this pack" vs "from a
different pack" vs "operator-curated." sync-pack ALWAYS needs
PG (even --dry-run reads the stored set for the diff) —
documented departure from M4.8 / M4.8.x where --dry-run was
PG-free. Output shapes: human "synced N route(s) for pack 'X'
(A added, B refreshed[, C external — left alone])" with
optional external-IDs list, JSON {pack, dryRun, total, added,
persistent, external, externalIds[]}; dry-run human prints
three sections (added / refreshed / external) with rt_<hex> +
method + path + operationId per row. Idempotent by design:
second invocation on unchanged manifest reports (0 added, N
refreshed, 0 external) and writes N upserts. CI-grade: one
command per deploy step that's safe to re-run. M4.8.x ships the companion to M4.8:
`crossengin gateway routes unregister-pack <slug> [--api-
version v1] [--dry-run]`. Same generation pipeline as
register-pack (resolvePack → resolveManifest →
generatePackRoutes) but instead of `registry.upsert` per
route, it calls `registry.deleteByRouteId(r.route.id)` —
re-deriving the deterministic hash IDs guarantees we look up
exactly the rows register-pack would have created. Soft-fail
semantics: missing routes report as `notFound` rather than
erroring (re-running idempotently surfaces "unregistered 0 of
N (N not found — already removed)"). Skips
tryValidateManifest — operators tearing down a pack don't need
post-resolve validation. Dispatcher short-circuit extended to
cover `unregister-pack --dry-run` so operators preview without
PG. Output shapes: human "unregistered N of M route(s) for
pack 'X'" (optional partial-miss suffix), JSON {pack,
attempted, deleted, notFound, notFoundIds[]}; dry-run human
prints rt_<hex> + method + path + operationId, dry-run JSON
emits {pack, count, dryRun, routes[{id, method, operationId}]}.
End-to-end verified: `crossengin gateway routes
unregister-pack operate-erp/payments --dry-run` emits the
34-row route-ID list without touching PG. M4.8 closed M4.7's manifest-driven
route-registration open question. New
`apps/architect-cli/src/gateway-pack-routes.ts` exports a pure
`generatePackRoutes({manifest, packSlug, apiVersion?})`
function that derives `RouteDefinition[]` from the resolved
manifest: 5 standard CRUD routes per entity
(list/read/create/update/delete with appropriate HTTP method +
idempotency + scope) plus one route per `entityLifecycle`
workflow transition (`POST /v1/<plural>/:id/transitions/<name>`).
Pluralizer kebabifies CamelCase + adds `s` (or `ies` for
consonant+y endings); `entityKey` produces snake_case for
operationIds + scopes. `routeIdFor({packSlug, operationId})`
emits `rt_<sha256(...).slice(0,16)>` — deterministic, regex-
safe, collision-free within a pack. New CLI action:
`crossengin gateway routes register-pack <slug>
[--api-version v1] [--dry-run] [--created-by <uuid>]` resolves
the pack via the M7.6.5 packManifestRegistry, validates
post-resolve via tryValidateManifest, generates the route
list, and either upserts every row via `PostgresRouteRegistry
.upsert` (registered N route(s) for pack '<slug>') or prints
the route table without writing (`--dry-run`). The dispatcher
short-circuits the `--dry-run` path before resolving the
registry so operators can preview routes without a running
database. Three packs immediately bulk-deployable:
core → 24 routes (4 entities × 5 CRUD + 4 invoice transitions);
payments resolved → 34 (+1 entity, +5 payment transitions);
healthcare resolved → 47 (+2 entities, +5 encounter, +3
observation transitions). End-to-end verified:
`crossengin gateway routes register-pack operate-erp/
healthcare --dry-run` emits the 47-row route table without
touching PG. M2.X closed M2.9.7 Q1 by extending the kernel
`LlmMessage` schema with `attachments?: MessageAttachment[]`
and threading vision content blocks through all three real
providers. New types in `@crossengin/ai-providers/src/types.ts`:
`IMAGE_ATTACHMENT_FORMATS = [png, jpeg, gif, webp]`,
`ImageAttachmentSchema`, `MessageAttachmentSchema`
(discriminated union on `kind`; only `"image"` today, but
audio/video/document slot in cleanly), `imageMediaType(format)`
helper. `LlmMessageSchema.superRefine` rejects attachments on
non-user roles at parse time. `ProviderCapabilitiesSchema`
gains `vision: z.boolean().default(false)`. All three real
providers flip `vision: true`; mock provider keeps false.
Provider translators wired:
`@crossengin/ai-providers-anthropic/messages-api.ts` user
branch emits `content: [{type: text}, {type: image, source:
{type: base64, media_type: image/<format>, data}}]` when
attachments present, falls back to string content otherwise;
`AnthropicContentBlock` discriminated union grows the image
variant. `@crossengin/ai-providers-openai/chat-api.ts`
`OpenAIChatMessage.content` widens to `string | null |
OpenAIContentPart[]`; user branch emits
`[{type: text}, {type: image_url, image_url: {url:
data:image/<format>;base64,<bytes>}}]`;
`extractTextFromResponse` joins text parts + ignores image_url
parts on content-part responses (forward-compat for vision
model outputs). `@crossengin/ai-providers-bedrock/converse-
api.ts` user branch appends `BedrockImageContentBlock` entries
(the type already existed from M2.9.7) — kernel-side
attachments now flow into the Bedrock builder's content array.
Router's `unionCapabilities` ORs `vision` across configured
providers so the chat substrate sees the union flag. Backward
compat: messages without attachments produce byte-identical
provider requests; existing 6,396 tests unchanged. M2.9.7 closed M2.9.5 Q6 by shipping Bedrock multimodal
embeddings (`amazon.titan-embed-image-v1`) + chat image content
block types. Two new surfaces in `@crossengin/ai-providers-
bedrock`, all additive, zero kernel changes. First — new
provider-native method `embedMultimodal({model?, text?, image
Base64?, dimensions?})` POSTs to `/model/amazon.titan-embed-
image-v1/invoke` with sig-v4. Takes EITHER text OR image OR
both; returns `{vector, dim, model, usage: {inputTextTokens,
imageCount, cost}}`. Dual billing: $0.80/M text tokens + flat
$0.00006 per image (combined inputs sum both tracks). 256/384/
1024-dim output (default 1024). New types in pricing.ts:
`BEDROCK_MULTIMODAL_EMBEDDING_MODELS`,
`BedrockMultimodalEmbeddingPricing`,
`computeBedrockMultimodalEmbeddingCost`,
`buildBedrockMultimodalEmbeddingUsage`,
`isBedrockMultimodalEmbeddingModel`. `BedrockModel` union
expands to three families (chat / embedding / multimodal
embedding); `isBedrockModel` accepts all three. `embed()` (the
kernel-facing method) now rejects `model: "amazon.titan-embed-
image-v1"` with a redirect error pointing to `embedMultimodal`
— catches the typo case that would silently pick the wrong
billing track. Second — Bedrock chat `BedrockImageContentBlock`
type added to the discriminated union (`{image: {format,
source: {bytes}}}`); `BEDROCK_IMAGE_FORMATS = [png, jpeg, gif,
webp]`; `buildBedrockImageBlock({format, imageBase64})` factory;
`isBedrockImageFormat` discriminator. `extractTextFromConverse
Response` + `extractToolCallsFromConverseResponse` skip image
blocks via the existing `"text" in block` / `"toolUse" in
block` discriminators (regression-tested). No
`buildBedrockConverseRequest` wiring yet — the kernel
`LlmMessage.content: string` is text-only; the types are ready
for a future M2.X kernel extension that adds structured
content. M2.9.6 closed M2.9 Q3 + M2.9.5 Q4 with two additive opt-in
features for the Bedrock provider. First — kernel-level
`CompletionRequest.cacheControl` now threads into Bedrock
`cachePoint` content blocks: `systemPrompt` and/or `toolSchemas`
appends a cachePoint to the end of the `system` array;
`conversationHistory` appends one to the penultimate message's
content (no-op when `messages.length < 2`); `retrievedContext`
appends one to the last message's content. Three independent
placements; operators set any combination. Anthropic-on-Bedrock
+ Claude 3.5/3.7/Opus 4 get the documented 90%-off cached-
input rate at $0.30/$1.50/$0.30 per million via the existing
`BEDROCK_CHAT_PRICING[model].cachedInputUsdPerMillion` path —
no extra cost-accounting work. New types:
`BedrockCachePointBlock`, `BEDROCK_CACHE_POINT` constant,
`isCachePointBlock` discriminator. `extractTextFromConverse
Response` + `extractToolCallsFromConverseResponse` already
discriminate via `"text" in block` / `"toolUse" in block`,
so cachePoint blocks fall through silently (regression-tested).
Second — `titanConcurrency` constructor option (default 4,
range [1, 100]) parallelizes the Titan single-text-only loop
in `embedViaTitan`. Refactored from sequential `for (const
text of texts)` to chunked Promise.all (chunks of `titan
Concurrency` size), preserving input order via pre-allocated
result array indexed by request position regardless of
completion order. Cohere unchanged — its native batching
(96 texts per call) already covers parallelism for that
family. M4.7.6 closed
M4.7.5's two follow-up questions: cloud-IdP-friendly JWKS URL
fetching + hot-reload. `apps/architect-cli/src/gateway-jwks.ts`
gained `loadJwksFromUrl(url, opts?)` (injectable FetchLike,
10s default timeout, AbortSignal-translated to typed
JwksLoadError on timeout), `normalizeJwksEntry` accepts BOTH
CrossEngin-native `{kid, publicKeyBase64}` AND RFC 7517 OKP/
Ed25519 `{kid, kty: "OKP", crv: "Ed25519", alg?: "EdDSA",
x: <base64url>}` entries (RSA / EC / oct rejected at parse
time with a clear EdDSA-only message), and a `Refreshable
JwksProvider` class wrapping an initial provider + a loader
function; `refresh()` atomically swaps the inner pointer on
success, keeps old keys on loader failure, and exposes
`startPeriodicRefresh({intervalMs, onResult})` /
`stopPeriodicRefresh()` (timer `.unref()`'d so it doesn't
keep the event loop alive). `runGatewayStart` integrated:
new flags `--jwks-url <url>` (mutually exclusive with
`--jwks-file`) and `--jwks-refresh-seconds <n>` (range [0,
86400]; defaults to 300 in URL mode, 0 in file mode where
SIGHUP is the reload path). After server boot the runtime
installs a SIGHUP handler + a periodic-refresh interval if
configured; both emit structured `{kind: "jwks_refresh",
source, ok, error?}` events (NDJSON in JSON format mode,
human prints otherwise). Initial JWKS load is hard-fail (exit
2 with typed JwksLoadError); subsequent refreshes are soft-
fail (old keys retained on loader error). `GatewayContext`
gained two test seams — `jwksFetch?: FetchLike` and
`registerReloadHandler?` — so the URL + SIGHUP paths are
exhaustively tested without real network/signals. End-to-end
verified: `crossengin gateway start --jwks-url http://...
--jwks-refresh-seconds 1` boots; SIGHUP triggers a
`jwks_refresh` event; periodic refresh fires every second.
RSA/oct JWKS endpoints, fs.watch hot-reload, lazy-on-miss
refresh, cached-on-disk JWKS responses, and per-tenant JWKS
isolation deferred to M4.7.7+. M4.7.5 closed M4.7's
two biggest open questions: JWT auth + routes management. New
`apps/architect-cli/src/gateway-jwks.ts` loads JWKS keys from a
JSON file shaped `{keys: [{kid, publicKeyBase64}, ...]}` and
returns an `InMemoryJwksProvider`; `resolveJwtFlags` is the
flag-glue layer that validates the all-or-nothing constraint
(`--jwks-file` requires both `--jwt-issuer` + `--jwt-audience`;
JWT options without `--jwks-file` are rejected with exit 2).
`runGatewayStart` resolves JWT flags BEFORE building the
runtime and spreads them via `jwtRuntimeOptions(jwt)` into the
`GatewayRuntime` constructor (both in-memory and Postgres
modes). New `gateway-routes.ts` adds `crossengin gateway routes
<list|register|unregister>` mirroring the M5.9 sessions
subcommand pattern — list renders a 7-column table (route_id /
method / path / version / operation / scopes / deprecated) or
JSON; register reads a JSON file, validates via
`RouteDefinitionSchema.parse()`, calls `registry.upsert`;
unregister deletes by route id with proper exit-code semantics.
`PostgresRouteRegistry` gained two additive methods —
`listAll()` returning RouteDefinition[] sorted by api_version /
method / route_id, and `deleteByRouteId(routeId)` returning
boolean + invalidating the cache. End-to-end verified:
`crossengin gateway start --jwks-file /tmp/jwks.json --jwt-
issuer X --jwt-audience Y` boots with JWT auth wired; anonymous
GET /__ping returns 200 (empty scopes); malformed Bearer
returns 401 + RFC 9457 problem detail with WWW-Authenticate
challenge. Documented constraint: the CrossEngin JWT verifier
accepts EdDSA only with base64-encoded public keys — different
from RSA JWKS most IdPs emit. URL-fetched JWKS, hot-reload, RSA
support, and bulk route management deferred to M4.7.6+. M6.5.6 wired the M2.9 / M2.9.5 Bedrock
provider into `architect-cli`'s `chat` subcommand by extending
`router-setup.ts` env-var detection. `AWS_ACCESS_KEY_ID` +
`AWS_SECRET_ACCESS_KEY` (required pair) plus optional
`AWS_SESSION_TOKEN` (STS) + `AWS_REGION` / `AWS_DEFAULT_REGION`
(default us-east-1) trigger BedrockProvider construction.
`DEFAULT_TASK_POLICIES` extended so every task fallback chain
ends with a Bedrock entry — planner adds `bedrock/anthropic.
claude-opus-4-20250514-v1:0`, executor adds Sonnet-on-Bedrock,
summarizer/diff-narrator/rerank/classifier add Haiku-on-
Bedrock, and the previously-empty embedding fallback gains
`bedrock/amazon.titan-embed-text-v2:0` at the same $0.02/M as
OpenAI's text-embedding-3-small. The `filterPoliciesByAvailable`
filter strips Bedrock entries when AWS env is unset — tenants
running with one or two providers see the same single/two-way
router behavior as before. New `resolveBedrockDefault(forceModel)`
helper mirrors the Anthropic + OpenAI ones. Three-key envs
return a 3-provider router with `availableProviders: ["anthropic",
"openai", "bedrock"]` for real failover diversity across
independent control planes. Help text + NoProvidersConfiguredError
message now mention all three credential paths. M2.9.5 closed M2.9's open Q4 by
implementing `embed()` for the Bedrock provider. New
`embeddings.ts` module dispatches on model family — Amazon Titan
(`amazon.titan-embed-text-v2:0` at $0.02/M with selectable 256 /
512 / 1024 dimensions, `amazon.titan-embed-text-v1` at $0.10/M)
uses a single-text-only `InvokeModel` request shape and the
provider loops over `texts: string[]`; Cohere (`cohere.
embed-english-v3` / `cohere.embed-multilingual-v3` at $0.10/M)
uses a batched `{texts, input_type}` request and the provider
makes one call per batch (max 96 per AWS). Token counts come
from Titan's `inputTextTokenCount` or Cohere's `meta.
billed_units.input_tokens` when reported; falls back to
ceil(chars/4) approximation otherwise. `BedrockProvider`
capabilities flip `embedding: false → true`; `models` expands
from 8 to 12 (4 new embedding models); constructor gains
`defaultEmbeddingModel` (default titan-embed-text-v2:0),
`defaultEmbeddingDimensions` (Titan v2 only — 256/512/1024),
`defaultCohereInputType` (search_document/_query/classification/
clustering). Same sig v4 path as chat; both endpoints hit
`POST /model/{modelId}/invoke`. Cost rounds to 6 decimals;
output_tokens always 0 for embeddings. Router (M6.5) now has a
second embedding-capable provider — operators serving non-
English markets can route `task: "embedding"` to
`cohere.embed-multilingual-v3` for 100+ language coverage while
keeping OpenAI's `text-embedding-3-small` as fallback. AWS-
native end-to-end story closed: a tenant with strict residency
requirements can now serve both chat completion AND vector
search entirely inside their AWS account in their region. M2.9 shipped the third real `LlmProvider` —
`@crossengin/ai-providers-bedrock`. AWS Bedrock converse-stream
client implementing the same contract as M2.7 (Anthropic) +
M2.8 (OpenAI). Zero runtime deps — pure `fetch` + `node:crypto`
with from-scratch AWS Signature V4 (verified against the
AWS-documented `f4780e2d...` reference signing key). 6 modules:
pricing (8 chat models — Claude on Bedrock matches first-party
pricing including 90%-off cached input + Llama 3.1 70B/405B +
Mistral Large 2407 + Titan Text Premier; per-million rates +
6-decimal cost rounding), signing (AWS sig v4 with HMAC chain
kSecret → kDate → kRegion → kService → aws4_request,
URI-encoded canonical request, signed headers always include
host + x-amz-date + x-amz-content-sha256), converse-api
(CompletionRequest → BedrockConverseRequest: system messages
lifted to top-level system array, assistant.toolUses translated
to content blocks with toolUseId, tool-role messages folded
back as user messages with toolResult blocks per Bedrock's
quirk), event-stream (AWS event-stream BINARY frame parser —
4-byte BE length prelude + headers + JSON payload + CRC, NOT
SSE; parses headers byte-by-byte, dispatches on
`:event-type` to map messageStart / contentBlockStart /
contentBlockDelta / contentBlockStop / messageStop / metadata →
CompletionChunk; tracks contentBlockIndex → toolUseId across
deltas; throws BedrockError on `:message-type: exception`),
errors (12 typed kinds including `model_stream_error` for
ModelStreamErrorException; CODE_TO_KIND maps 15 AWS exception
classes — ThrottlingException, ValidationException,
ServiceUnavailableException, ExpiredTokenException etc. — to
kernel-level kinds; same isRetryable shape as M2.7 / M2.8),
provider (BedrockProvider class with complete() +
completeNonStreaming() + embed() rejects with typed error
directing to OpenAI; constructor accepts accessKeyId +
secretAccessKey + optional sessionToken + region + clock
injectable for sig v4 testing). Residency derived from region
prefix (us-* → ["us"], eu-* → ["eu"], ap-*/me-* → ["ap"], sa-*
→ ["sa"]). Capabilities: `{chat: true, streaming: true,
toolUse: true, jsonMode: false, embedding: false,
maxContextTokens: 200_000}`. Router (M6.5) now has three real
providers to chain — failover diversity across three
independent control planes (Anthropic + OpenAI + AWS). Titan
embeddings + JWKS-style OIDC role assumption + automatic env
detection in CLI deferred to M2.9.5 / M6.5.6. M7.9 shipped the third vertical pack — `@crossengin/pack-erp-
healthcare`. Three FHIR-shaped entities (Patient with auditable +
tenant_owned + 12 user fields including mrn unique-per-account,
sex_assigned_at_birth, blood_type, allergies, preferred_language,
emergency contact; Encounter referencing Patient with FHIR
EncounterClass enum + 6-state lifecycle scheduled → checked_in →
in_progress → completed | cancelled | no_show; Observation
referencing both Encounter and Patient with code_system enum
matching LOINC/SNOMED/ICD-10 + value_quantity decimal(18,6) +
FHIR R4 ObservationStatus). Three relations: Account → Patient,
Patient → Encounter restrict, Encounter → Observation cascade.
Two new role contributions: erp_clinician + erp_front_desk merge
with core's three. Two lifecycle workflows: encounter_lifecycle
(5 transitions + 2 SLAs; only mark_no_show is automatic for the
sweep job) and observation_lifecycle (4 states matching FHIR R4
exactly; mark_in_error is admin-only for amendment discipline).
Three jobs: daily encounter-reminder, 15-min no-show-sweep,
event-triggered FHIR R4 export on `healthcare.encounter.
completed`. compliancePacks defaults to ["hipaa", "21_cfr_11"].
Registered in architect-cli's pack registry; `crossengin apply
--pack=operate-erp/healthcare` emits 65 pack statements
covering all 7 entities (4 core + 3 healthcare) with M7.7
tenant scoping intact, exercises the M7.6.5 resolver with a
second downstream consumer. M4.7 closed
the substrate-to-binary loop for the gateway pillar.
`crossengin gateway start [--port N] [--host A] [--in-memory]`
boots the M4 `GatewayRuntime` against a Node `http.createServer`
and the M4.5 Postgres-backed stores (idempotency / route registry
/ rate limit / pipeline executions). Built-in routes `GET /__ping`
+ `GET /__health` register at startup with `requiredScopes: []`
and `idempotencyRequired: false` so the server is responsive even
with an empty route registry; both flow through the full 17-stage
pipeline. New modules: `apps/architect-cli/src/gateway.ts` (CLI
entry + runtime construction), `gateway-server.ts` (Node HTTP
adapter — `buildIncomingFromNode`, `writeOutgoing`, `readBody`
with 1 MB cap, `generateRequestId` returning `req_<24-hex>`), and
`gateway-handlers.ts` (`platform.ping` + `platform.health`
handlers). `--in-memory` swaps PG adapters for in-memory
equivalents; default mode reads `PGHOST/PGDATABASE/...` env vars
and persists pipeline executions to `meta.gateway_pipeline_
executions`. `PostgresRouteRegistry.ensureLoaded()` runs as a
per-request `beforeHandle` so the route cache stays warm. SIGINT
/ SIGTERM trigger graceful shutdown — server closes, PG connection
closes, exit 0. End-to-end verified: `curl http://127.0.0.1:14250
/__ping` returns 200 + `{status:"ok",at:<ISO>}`; `/__health`
reports `uptimeSeconds` since boot; `/nope` returns 404 via the
gateway's `match_route` stage. JSON format mode emits NDJSON-
style records (`{kind:"started",...}` on boot, one
`{kind:"request",...}` per request). JWT mode + manifest-driven
route registration deferred to M4.7.5 + M4.8. M7.6.5 wired the kernel's
existing `resolveManifest` (from `packages/kernel/src/manifest/
extends.ts`) into the CLI's apply pipeline. `buildErpPaymentsPack
()` refactored to return a child-only manifest (1 entity, 1
relation, etc.) with `meta.extends: ["operate-erp/core"]`; the
inline merge with `buildErpCorePack()` is gone. `apps/
architect-cli/src/pack-registry.ts` gained `packManifestRegistry
()` factory wrapping `PACK_REGISTRY` as a `ManifestRegistry`
implementation; `apps/architect-cli/src/apply.ts`'s `buildPlan`
became async, calling `resolveManifest(rawManifest, {registry:
packManifestRegistry()})` before `tryValidateManifest`. Added
typed error handling for `ExtendsCycleError` ("pack extends-chain
cycle") and `UnknownParentManifestError` ("pack references
unknown parent: <slug>. Available: <list>"). Pack-erp-payments
tests refactored: identity tests (slug, version, extends, child
counts) use `buildErpPaymentsPack()` directly; composition tests
(5 entities merged, cross-pack FK resolves) use a new
`buildResolvedPayments()` helper. End-to-end verified: `crossengin
apply --dry-run --pack=operate-erp/payments` still emits all 5
entity tables with M7.7 tenant scoping intact — the resolver
merges, the emitter sees one unified manifest. M5.9 added three CLI
subcommands for the chat audit data: `crossengin sessions
list` renders a table of recent sessions for a tenant;
`crossengin sessions show <id>` dumps one session's full
transcript (header + messages + tool invocations + proposals)
with truncation for terminal viewing; `crossengin sessions
replay <id>` renders the messages as chat-style output
(`You:` / `Architect:` / `[tool result ← tu_1]`) matching the
live REPL's look. New `apps/architect-cli/src/sessions.ts`
dispatches on positional action; `getBySessionId({tenantId,
sessionId})` added to `PostgresArchitectSessionStore` so the
CLI looks up by the user-visible session_id string (UUID lookup
also supported via regex check). Tests inject store overrides
via the new `SessionsContext.storesOverride` so the offline
CI path mirrors the chat side's `transcriptOverride`.
M7.8 wired pack-erp-payments to
M6's `workflow-signal-bridge`. New `signal-bridge.ts` module
exports `PAYMENT_SIGNAL_NAMES` (5 lifecycle signals matching
the payment_lifecycle workflow's transitions),
`PROVIDER_EVENT_SIGNAL_MAP` (Stripe + Adyen + Braintree event
types → canonical signal names), `paymentReferenceExtractor()`
backed by a new `FirstMatchingPathExtractor` that tries
multiple dotted paths (Stripe's `data.object.id`, Adyen's
`pspReference`, Braintree's `transaction.id`, generic
`provider_reference`), `buildPaymentSignalBridge(opts)`
factory, and `buildPaymentBridgesByEvent(opts)` that returns
a map of one bridge per provider event type. End-to-end test
proves: real HMAC-signed Stripe-shaped webhook → bridge
verifies → extractor finds `pi_xxx` → submitSignal called
with `payment.captured` + correct correlation key + idempotency
key. The pack's `erp-payments-provider-webhook` job declaration
now has matching code-side wiring.
M7.5 shipped the second vertical pack —
`@crossengin/pack-erp-payments` — proving the cross-pack
composition story. The pack adds 1 entity (Payment with both
`auditable` + `tenant_owned` traits; 13 user-fields including
provider enum, provider_reference unique-within-provider,
amount + refund_amount decimal(14,2), 6-state lifecycle),
1 relation (Invoice → Payment one-to-many RESTRICT), 5
permission transitions (admin-only refund + delete; everyone
else for capture/settle/fail/cancel), the `payment_lifecycle`
workflow (pending → captured → settled active; refunded /
failed / cancelled terminal; refund reachable from captured +
settled; 2 SLAs), 2 jobs (event-triggered payment-provider
webhook handler + hourly settlement sweep backstop), 1 list
view. `buildErpPaymentsPack()` calls `buildErpCorePack()` and
merges its additions — the resulting manifest declares
`extends: ["operate-erp/core"]` for documentation but applies
as one unified manifest (5 entities, 4 relations, 5 permission
sets, 2 workflows, 4 jobs, 3 views). `tryValidateManifest`
passes; cross-pack Payment.invoice_id → Invoice reference
resolves internally via merge. Pack-erp-payments registered in
the architect-cli pack-registry; `crossengin apply
--pack=operate-erp/payments` produces deployment-grade SQL
covering both core and payment tables.
M7.7 fixed the biggest open question from M7-wire:
pack tables now isolate per tenant at the DB level. The kernel's
`tenant_owned` built-in trait gained a `tenant_id UUID NOT NULL`
(indexed) field; `emitEntity` now emits a cross-schema FK
(`<table>_tenant_fk` → `meta.tenants(id) ON DELETE CASCADE`),
`ENABLE ROW LEVEL SECURITY`, and a `<table>_tenant_isolation`
policy (`tenant_id = current_setting('app.current_tenant_id',
true)::UUID` — matches META exactly) for entities declaring the
trait. Pack-erp-core's four entities (Account, Contact,
Invoice, InvoiceLine) now use `["auditable", "tenant_owned"]`.
`crossengin apply --pack=operate-erp/core` now produces
deployment-grade DDL — every pack table carries `tenant_id`, FK
to `meta.tenants`, RLS enabled, isolation policy.
M7-wire closed the substrate-to-pack loop in the CLI.
New `apps/architect-cli/src/pack-registry.ts` maps slug →
manifest builder (today: just `operate-erp/core` →
`buildErpCorePack()`; future packs add entries). `runApply`
gains `--pack <slug>` and `--pack-schema <name>` flags
(default schema: `public`). `buildPlan` validates the pack
via `tryValidateManifest` before any DB write, then emits its
DDL via `emitManifestCreate(manifest, {schema})`. The dry-run
output streams META bootstrap SQL followed by pack DDL with a
divider; JSON mode exposes `pack` + `metaStatementCount` +
`packStatementCount` + `availablePacks`. Live apply
concatenates both statement lists into one `MigrationApplier`
run — atomic via advisory-lock + per-statement transactions.
`crossengin apply --dry-run --pack=operate-erp/core` now
produces ~730 statements total (META bootstrap + 4 ERP entity
tables in `public` with FKs, check constraints, indexes —
topologically ordered).
M2.8.5 extended `@crossengin/ai-providers-openai` with the
Responses API (`/v1/responses`) as an opt-in alternative to
Chat Completions. 2 new modules: responses-api (`buildOpenAI
ResponsesRequest` translates `CompletionRequest` to the
flat input-array shape with `instructions` instead of system
messages; `function_call` + `function_call_output` items
replace assistant `tool_calls` and tool-role messages),
responses-streaming (named-event SSE parser dispatching on
`response.output_text.delta` / `response.function_call_
arguments.delta` / `response.completed`). `OpenAIProvider`
gains `defaultApiPath: "chat" | "responses"` constructor
option (defaults to `"chat"` — backward compat) and
`reasoningEffort: "low" | "medium" | "high"` for thinking
models (o1, o3). Two new methods: `completeViaResponses` +
`respondNonStreaming`. The CompletionChunk discriminated
union is unchanged; reasoning summary surfaces only on the
non-streaming envelope via `summarizeResponsesResponse`.
M6.5.5 wired the ai-router into `architect-cli`'s `chat` subcommand. New
`router-setup.ts` exports `DEFAULT_TASK_POLICIES` (7 tasks
mapped to Anthropic-primary + OpenAI-fallback chains; cheap
tasks like summarizer/classifier go to gpt-4o-mini primary) and
`buildChatCompleter({env, forceModel?, costCeiling?})` which
chooses adaptively: one API key → single provider (legacy
behavior); both keys → `DefaultLlmRouter` wrapped in a
`RouterAsProvider` adapter so the chat engine still sees a
single `LlmProvider`-shaped interface. New `--cost-ceiling-usd`
flag enforces per-request budget when the router is active.
Strict `isAnthropicModel` check replaced with a union-aware
check against `provider.models`. Session summary now reports
`providerKind` (single | router) and `availableProviders`.
M2.8 added
`@crossengin/ai-providers-openai` — the second concrete
`LlmProvider`, mirroring M2.7's Anthropic structure. 6 modules:
pricing (5 chat models + 2 embedding models with current
per-token + cached + output rates), chat-api (Chat Completions
request builder + response normalizer with `LlmMessage.toolUses`
→ `tool_calls` translation), streaming (SSE parser for OpenAI's
indexed-tool-call delta format; `delta.tool_calls[i].index`
identifies a call across deltas; usage from the final
`stream_options.include_usage` chunk), embeddings (the FIRST
real `embed()` implementation — buildEmbeddingsRequest +
normalizeEmbeddingResponse with sorted-by-index vectors + dim),
errors (11 typed kinds matching Anthropic's shape so the
router's `isRetryable()` check works uniformly across
providers), provider (`OpenAIProvider.complete()` streaming +
`completeNonStreaming()` + `embed()`; rejects embedding model
in `complete()` and chat model in `embed()`). Zero runtime
deps — pure `fetch` + `ReadableStream`. The router can now
chain Anthropic + OpenAI with real fallback semantics; the
chat substrate can route `--task=summarizer` to gpt-4o-mini
($0.15/M) for cheap operations while keeping authoring on
Claude. Embeddings finally have a real backend.
M6.5 added `@crossengin/ai-router` — the orchestration layer
between consumers and `LlmProvider` implementations. 5 modules: retry
(exponential backoff + isRetryable check + withRetry wrapper),
cost-tracker (CostCeiling interface + InMemoryCostTracker with
rolling per-tenant windows + CostCeilingExceededError),
latency-tracker (rolling p50/p95 buffer per provider), resolve
(pure provider-chain resolution: parseProviderRef + residency
filter + parent/override merge), router (DefaultLlmRouter
implements LlmRouter from @crossengin/ai-providers — picks a
provider per task, retries transient errors, falls back to the
next provider on failure, enforces cost ceilings pre-flight,
buffers chunks for clean retry replays, throws
AllProvidersExhaustedError when every fallback exhausts). The
chat substrate can swap its direct AnthropicProvider for a
router whenever M2.8 (OpenAI) lands — the consumer-facing
LlmProvider surface is identical.
M7 shipped the first vertical pack — `@crossengin/pack-erp-core`: a real Manifest
with 4 entities (Account, Contact, Invoice, InvoiceLine all
on the `auditable` trait), 3 relations (Account→Contacts
cascade, Invoice→Account restrict, Invoice→Lines cascade),
3 roles (erp_admin / erp_accountant / erp_viewer), per-entity
permissions including transition grants, an entityLifecycle
workflow for Invoice (draft → sent → paid|overdue|void with
a 30-day SLA), 2 jobs (scheduled overdue-invoice-reminder +
event-driven payment-received-handler), 2 list views. The
`buildErpCorePack(opts)` builder returns the full Manifest;
`tryValidateManifest` passes — every cross-reference resolves,
proving the kernel's abstractions hold up under a real schema.
M5.7 added chat persistence:
`@crossengin/ai-architect-pg` ships
`PostgresArchitectSessionStore` / `…MessageStore` /
`…ToolInvocationStore` / `…ProposalStore` plus a
`PostgresTranscript` orchestrator that implements the
`Transcript` lifecycle interface (`onSessionStart` /
`onMessage` / `onToolInvocation` / `onProposal` /
`onSessionEnd`). The chat engine emits events via this
interface — `NullTranscript` is the default no-op, so
non-persisted runs are unchanged. Four new META_ARCHITECT_*
tables (sessions / messages / tool_invocations / proposals)
with tenant RLS + FK chain. `crossengin chat --persist` reads
PG env vars and writes a full audit trail of who proposed
what, when, and whether it was applied. Operators can join
sessions ⇒ messages ⇒ tool_invocations ⇒ proposals to
reconstruct any developer's authoring history.
M5.8 closed the authoring loop by
adding a write tool with human-in-the-loop approval.
`propose_manifest_edit({path, new_manifest_json})` shows the
developer a diff + entity counts + new hash, prompts y/N (via
a shared `LineReader` that the REPL also uses, so the approval
read doesn't compete with the for-await on stdin), and only
writes the file on approval. `--allow-file-write` gates the
tool; `--auto-approve-writes` skips the prompt (required for
one-shot scripted use). Refactored ChatReplOptions: `stdin:
AsyncIterable<string>` → `lines: LineReader` so the approver
and the REPL share one source. `tools.ts` now ships an
`autoApprover(approve = true)` and `chat.ts` exports
`interactiveApprover({io, reader})`.
M5.6 made `crossengin chat` a real authoring loop
by adding tool dispatch. The CLI exposes
`validate_manifest` / `hash_manifest` / `diff_manifests` /
`summarize_manifest` (plus opt-in `read_file` under
`--allow-file-read`) as tools Claude can invoke mid-turn. The
chat engine assembles tool inputs from streamed
`tool_call_arg_delta` chunks, executes locally via
`executeToolCall`, appends tool-role results to history, runs
continuation turns until the assistant produces terminal text
or hits `DEFAULT_MAX_TOOL_ITERATIONS` (5). To round-trip cleanly
through Anthropic's API, `LlmMessage` in `@crossengin/
ai-providers` gained an optional `toolUses: {id, name, input}[]`
field; `buildAnthropicRequest` in `ai-providers-anthropic`
encodes those as `tool_use` content blocks alongside text on
assistant messages. Pattern extends to OpenAI / Bedrock / Vertex
when M2.8+ ships.
M5.5 wired the Anthropic provider into `architect-cli`'s `chat`
subcommand. `crossengin chat` now actually talks to Claude:
streams tokens as they arrive, reports per-turn + aggregate cost
in USD, supports `--prompt` for one-shot mode + REPL otherwise,
`--model` / `--max-tokens` / `--system` / `--system-file` /
`--tenant-id` / `--session-id` flags, `--format=json` emits the
`CompletionChunk` discriminated union as NDJSON. Tests inject
a stub `LlmProvider` via `RunContext.providerOverride` so CI
runs offline. Default system prompt primes Claude as the
CrossEngin Architect.
M2.7 added `@crossengin/ai-providers-anthropic` — a real
Anthropic Messages API client implementing the `LlmProvider`
interface from `@crossengin/ai-providers`. Zero runtime deps —
pure `fetch` + `ReadableStream`. 5 modules (pricing for the
five Claude 4.x models with per-token + per-cache-tier rates,
messages-api request builder + response normalizer, SSE
streaming parser with shared state across read boundaries,
typed error classification + retry policy, and the
`AnthropicProvider` class itself with `complete()` streaming +
`completeNonStreaming()` + `anthropic-beta` header support).
The Architect agent now has a real backend to call.
M6 added `@crossengin/workflow-signal-bridge` — verify a webhook
via `sdk/webhook-signing`, extract a correlation key, route
to `workflow-runtime.submitSignal`. Pairs with the gateway as
a registered Handler so every external webhook → workflow
advance flows through one place. The four runtime pillars
(DDL execution + cryptography + workflow execution + HTTP
gateway) are in place; both impure runtime pillars (workflows +
gateway) now have production-shape Postgres adapters; M5 added
the first app under `apps/` — `@crossengin/architect-cli` ships
the `crossengin` binary with `init`, `validate`, `diff`, `patch`,
`hash`, `apply`, `chat` (stubbed for M5.5), `version`, `help`.
The end-to-end story works today: `crossengin init m.json &&
crossengin validate m.json && crossengin apply --dry-run`
produces a 3,061-line SQL dump of the full meta-schema. M3.6
added `ProjectingEventLog` + `buildPersistentEngine` to
`@crossengin/workflow-runtime-pg` — wrap a `WorkflowEngine` once
and every event append automatically projects + upserts the
instance / activity / signal / timer rows into their META_
WORKFLOW_* tables. M3.5 added
`@crossengin/workflow-runtime-pg` — PostgresEventLog + four
projection stores (instance / activity / signal / timer) backed
by the existing META_WORKFLOW_* tables, with cached wfi_*/wfd_*
→ UUID resolvers that bridge the runtime's string IDs to the
schema's UUID FKs. M4.5 added `@crossengin/api-gateway-pg` —
Postgres-backed adapters for the gateway runtime's four store
interfaces (IdempotencyStore, RouteRegistry, RateLimitChecker,
PipelineExecutionStore) backed by the existing META_GATEWAY_* +
META_RATE_LIMIT_DECISIONS tables via `@crossengin/kernel-pg`.
M4 added `@crossengin/api-gateway-runtime` — the 17-stage
pipeline as real middleware, with EdDSA JWT verification (via
crypto), idempotency-key replay detection, rate-limit denial
with Retry-After, RFC 9457 problem details for every error, and
a queryable PipelineExecution per request. M1
added `@crossengin/kernel-pg` (Postgres-backed migration applier).
M2 added `@crossengin/crypto` (real SHA-256 / BLAKE2b-512 /
HMAC-SHA256 / Ed25519). M2.5 wired crypto into marketplace + sdk
+ forensics + tenant-lifecycle. M2.6 finished M2 wiring into
`access-reviews` (`signDecisionAttestation` for digital + qualified
e-signatures; `sealEvidenceWithBundle` + `verifyEvidenceSeal` for
SOC 2 / ISO 27001 / HIPAA / PCI / GDPR / 21 CFR Part 11 evidence
packs) and `data-lineage` (`sealArticle15Pack` +
`deliverArticle15Pack` + `verifyArticle15PackSeal` for the GDPR
Article 15 evidence pack lifecycle). M3 added `@crossengin/
workflow-runtime` — in-process event-sourced executor consuming
`@crossengin/workflow-engine` contracts; turns workflow
definitions into actually-running instances with append-only
event log, deterministic replay-style projection, registered
activity handlers, signal correlation, timer firing, automatic
transitions, on-entry actions (set_variable / schedule_activity /
schedule_timer), and saga compensation planning.

ADRs 0001-0104 are fully drafted in `docs/adr/` — no reserved
gaps. ADR-0046 is the Phase 2 implementation plan (M1 DDL → M2
crypto → M3 workflow runtime → M4 gateway runtime → M5 architect-
cli → M6 notifications + workflow bridge → M7 first vertical pack
→ M8 SLO enforcement); ADR-0047 covers M1, ADR-0048 covers M2,
ADR-0049 covers M3, ADR-0050 covers M4, ADR-0051 covers M5,
ADR-0052 covers M6, ADR-0053 covers M2.7 (Anthropic provider),
ADR-0054 covers M5.5 (architect-cli chat mode), ADR-0055 covers
M5.6 (tool-driven chat), ADR-0056 covers M5.8 (write tools with
human-in-the-loop approval), ADR-0057 covers M5.7 (chat
persistence to META_ARCHITECT_*), ADR-0058 covers M7
(`pack-erp-core` — first vertical pack), ADR-0059 covers M6.5
(`ai-router` — provider router with retry / cost / latency),
ADR-0060 covers M2.8 (`ai-providers-openai` — Chat Completions
+ embeddings + tool calls), ADR-0061 covers M6.5.5
(architect-cli router integration), ADR-0062 covers M2.8.5
(OpenAI Responses API support), ADR-0063 covers M7-wire
(CLI `--pack` apply), ADR-0064 covers M7.7 (pack tenant
scoping via `tenant_owned` trait), ADR-0065 covers M7.5
(`pack-erp-payments` — second vertical pack proving cross-pack
composition), ADR-0066 covers M7.8 (payment signal-bridge
wiring), ADR-0067 covers M5.9 (CLI sessions subcommands),
ADR-0068 covers M7.6.5 (kernel `extends` resolver wiring),
ADR-0069 covers M4.7 (CLI gateway binding),
ADR-0070 covers M7.9 (`pack-erp-healthcare` — third vertical
pack), ADR-0071 covers M2.9 (`ai-providers-bedrock` — third
real LlmProvider), ADR-0072 covers M2.9.5 (Bedrock Titan +
Cohere embeddings closing M2.9's open Q4), ADR-0073 covers
M6.5.6 (architect-cli Bedrock integration — env-var detection +
three-deep task fallback chains), ADR-0074 covers M4.7.5
(gateway JWT auth + routes subcommand closing M4.7's open
questions), ADR-0075 covers M4.7.6 (URL-fetched JWKS +
hot-reload via SIGHUP + periodic refresh), ADR-0076 covers
M2.9.6 (Bedrock cacheControl threading + Titan parallelism
closing M2.9 Q3 + M2.9.5 Q4), ADR-0077 covers M2.9.7 (Bedrock
multimodal embeddings + image content block types closing
M2.9.5 Q6), ADR-0078 covers M2.X (kernel LlmMessage.attachments
+ vision capability closing M2.9.7 Q1), ADR-0079 covers M4.8
(gateway routes from pack manifest — bulk register-pack
closing M4.7 manifest-driven question), ADR-0080 covers
M4.8.x (gateway routes unregister-pack — symmetric tear-down
via deterministic ID re-derivation), ADR-0081 covers M4.8.y
(gateway routes sync-pack — composite diff/upsert command
that completes the three-verb pack-routes vocabulary),
ADR-0082 covers M4.10 (routes.source_pack column closing
the open ownership-attribution question across ADRs
0079/0080/0081, enabling safe `sync-pack --prune-obsolete`),
ADR-0083 covers M4.10.x (`unregister-pack --by-source-pack` —
manifest-free tear-down via M4.10's `deleteByPackSlug` API,
closing ADR-0082 Q3), ADR-0084 covers M2.9.8 (Bedrock
Guardrails integration — opt-in content moderation via
guardrailConfig threaded through converse + converse-stream,
with `BedrockGuardrailViolationError` thrown after `usage_final`
for streaming consumers and `isGuardrailInterventionResponse`
helper for non-streaming), ADR-0085 covers M2.9.8.x
(per-request guardrail override via `completeWithGuardrail` +
`completeNonStreamingWithGuardrail` sibling methods, with
three-state semantics: BedrockGuardrailConfig / null / undefined),
ADR-0086 covers M2.X.6 (OpenAI + Anthropic moderation surfaces —
`OpenAIContentFilteredError` for `finish_reason: "content_filter"`
and `AnthropicRefusalError` for `stop_reason: "refusal"`,
matching the M2.9.8 post-usage_final-throw pattern), ADR-0087
covers M2.X.6.x (cross-provider moderation helper — kernel-level
`isModerationError(err)` predicate + `MODERATION_ERROR_KINDS`
shared tuple, duck-typing against `err.kind`), ADR-0088 covers
M2.X.5 (kernel LlmMessage.content as discriminated union —
lifted `content: string` to `string | LlmContentBlock[]` to
unblock multimodal assistant outputs across all three
providers), ADR-0089 covers M2.X.5.x (tool_use + tool_result
content block variants — consolidates tool-call surface with
provider translators handling Bedrock + Anthropic natively
and OpenAI via message-flattening flatMap), ADR-0090 covers
M2.X.7 (cross-provider retryable helper — kernel-level
`isRetryableError(err)` predicate + `RETRYABLE_ERROR_KINDS`
shared tuple, symmetric with M2.X.6.x's moderation helper),
ADR-0091 covers M6.6 (router uses kernel cross-provider
helpers — retry.ts hybrid predicate, explicit moderation
early-exit, estimateRequestTokens bug fix for M2.X.5 array
content), ADR-0092 covers M2.X.8 (standalone OpenAI
Moderations API — `provider.moderate(input)` calls
`/v1/moderations` for proactive content screening before
paying for a chat completion), ADR-0093 covers M2.8.6 (OpenAI
Responses API image inputs — threads ImageContentBlock through
to input_image blocks, closing the M2.X.5 vision gap on the
Responses path), ADR-0094 covers M2.X.5.y (ImageUrlContentBlock
URL variant — adds `{type: "image_url", url}` block alongside
the existing bytes-based image variant; OpenAI providers pass
URLs through, Bedrock + Anthropic throw with explicit
pre-fetch guidance), ADR-0095 covers M2.X.9 (cross-provider
input-too-large helper — third kernel-level predicate
`isInputTooLargeError`; partitions the error space alongside
isModerationError + isRetryableError), ADR-0096 covers M2.X.5.z
(Anthropic URL-source image support — removes the M2.X.5.y
throw, threads URLs through to Anthropic's native URL source
variant; provider parity expanded — OpenAI both paths +
Anthropic now accept URL-based images, Bedrock still requires
bytes), ADR-0097 covers M2.X.5.aa (DocumentContentBlock —
PDF inputs across Bedrock + Anthropic + OpenAI Responses;
OpenAI Chat throws with "use Responses API" guidance),
ADR-0098 covers M2.X.5.aa.y (DocumentUrlContentBlock —
URL-based document inputs; Anthropic native passthrough,
Bedrock + OpenAI throw with pre-fetch guidance), ADR-0099
covers M2.X.5.aa.x (document format expansion — txt/md/csv
added to DOCUMENT_FORMATS enum; Anthropic uses text-source
variant with UTF-8 decoding, OpenAI Responses uses format-
aware MIME types, Bedrock passes format through natively),
ADR-0100 covers M2.X.5.aa.x.1 (office document format
expansion — doc/docx/xls/xlsx/html added; Bedrock native,
Anthropic + OpenAI Responses throw with conversion guidance),
ADR-0101 covers M2.X.10 (kernel LlmMessage.name regex
enforcement + OpenAI Chat threading across all four roles;
Anthropic + Bedrock + OpenAI Responses silently drop),
ADR-0102 covers M2.X.5.aa.z (OpenAI Files API integration —
upload/retrieve/delete CRUD + kernel FileReferenceContentBlock
threaded through Responses API; other providers throw with
actionable guidance), ADR-0103 covers M2.X.5.aa.z.1 (Anthropic
Files API integration — same CRUD shape; removes the M2.X.5.aa.z
throw in the Anthropic translator; file_id blocks now flow
natively to both OpenAI Responses + Anthropic), ADR-0104
covers M2.X.5.aa.z.2 (listFiles() on both Files APIs — provider-
native pagination shapes preserved; tenant offboarding + audit
workflows unblocked), ADR-0105 covers M2.X.5.aa.z.3 (Bedrock
batch inference listBatches — first control-plane operation on
Bedrock; two-host model documented; pattern set for future
control-plane enumeration methods).

## Architecture in 90 seconds

- **`zod` schemas are the source of truth.** Types derive via
  `z.infer`. Every package exports `XSchema` + `type X` pairs.
- **Pure contracts + deterministic helpers only.** A package
  defines record shapes, state machines, and pure functions
  (validators, predicates, comparators). It does not open
  sockets, hit databases, or shell out.
- **Kernel meta-schema is the integration point.** Every package
  that needs persisted records wires `META_*` table definitions
  into `packages/kernel/src/bootstrap/meta-schema.ts`. The kernel
  emits DDL deterministically from those.
- **Tenant isolation by RLS.** Tenant-scoped tables enable PG
  row-level security with `tenant_id = current_setting(
  'app.current_tenant_id', true)::UUID`. Platform-wide tables
  skip RLS. Both are tested by the meta-schema test suite.
- **Strict TypeScript.** No `any`. No `--no-verify`. Use explicit
  return types for exported functions when inference is murky.

## Package map

Grouped by concern. Each is `packages/<name>` with `src/index.ts`
re-exporting everything.

### Substrate (the kernel itself)
- **`kernel`** — meta-schema (113 tables), DDL emit, manifest
  validate/diff/patch/topology/hash, bootstrap SQL generator.
- **`kernel-pg`** — Postgres-backed migration applier (first
  impure package). 7 modules: connection (PgConnection interface
  + `parsePgEnvConfig` + node-postgres binding), statement-hash
  (sha256 of normalized SQL), migration-log (`_meta_migrations`
  bookkeeping), preconditions (`pg_uuidv7` extension + PG ≥ 14 +
  CREATE privilege checks), applier (advisory-lock-gated, per-
  statement transactions, halt-on-first-failure, hash-based
  skip), introspection (pg_catalog queries + pure parsers), diff
  (pure `diffSchema` vs `META_TABLES`). Ships `crossengin-pg`
  CLI with `apply`, `apply --dry-run`, `drift`, `inspect`,
  `version` commands.
- **`workflow-runtime-pg`** — Postgres-backed adapters for the
  workflow runtime. 9 modules: id-mapping
  (WorkflowInstanceIdResolver + WorkflowDefinitionIdResolver,
  cached wfi_*/wfd_* → UUID lookups against workflow_instances /
  workflow_definitions), event-log (PostgresEventLog implements
  EventLog over META_WORKFLOW_EVENTS, parses JSONB or text
  payloads, computes latestSequence via MAX(sequence_number)),
  instance-store (PostgresInstanceStore.create INSERTs
  workflow_instances + caches the UUID; upsertProjection
  UPDATEs all status / variables / awaiting* fields by
  instance_id), activity-store (UPSERT into workflow_activities
  via ON CONFLICT (activity_id) DO UPDATE), signal-store (UPSERT
  workflow_signals with COALESCE-preserving instance_id),
  timer-store (UPSERT workflow_timers with status/firedAt/
  cancelledAt), projecting-event-log (ProjectingEventLog wraps
  any EventLog + auto-runs the four projection writers after
  each append; creates the workflow_instances row on
  instance_started so the FK is satisfied; re-projects + upserts
  the instance / activities / signals / timers on every
  subsequent event), persistent-engine (buildPersistentEngine
  one-call factory: pass a PgConnection + definitions map, get
  back {engine, eventLog, stores} where the engine is wired to
  the projecting log so all engine ops persist automatically),
  replayer (WorkflowReplayer.resyncInstance re-projects from the
  event log + upserts all projection tables to fix drift;
  verifyInstance returns a per-field DriftReport comparing
  expected projection vs stored rows; bulkResync iterates with
  pagination + maxInstances cap for periodic CI / observability
  guards).
- **`api-gateway-pg`** — Postgres-backed adapters for the four
  gateway runtime store interfaces + a replayer. 5 modules:
  idempotency-store (INSERT … ON CONFLICT DO UPDATE on tenant+
  operation+key, TTL-based deleteExpired), route-registry
  (cache-backed lookup + listVersionsFor with configurable TTL,
  upsert that invalidates the cache), rate-limit-checker
  (per-(tenant, principal, operation) sliding-window counter;
  writes META_RATE_LIMIT_DECISIONS with allowed /
  denied_rate_limit_exceeded outcomes), pipeline-execution-store
  (INSERT … ON CONFLICT DO NOTHING for the M4 PipelineExecution,
  plus countSince audit query), replayer
  (verifyPipelineExecutionShape pure validator flagging
  stages-out-of-order, stage-repeated, final-stage/outcome
  mismatch, pass-with-4xx-or-5xx, duration-inconsistent,
  terminating-not-last; GatewayReplayer.verifyExecution adds the
  rate_limit_decision_not_found check by joining against
  META_RATE_LIMIT_DECISIONS; listRecentExecutions /
  bulkVerify paginate over META_GATEWAY_PIPELINE_EXECUTIONS;
  summarize computes pass/deny/error counts + p50/p95 latency).
- **`api-gateway-runtime`** — HTTP gateway middleware
  (fourth impure package). 7 modules: adapters (RequestAdapter +
  ResponseAdapter for Node HTTP + edge runtimes,
  buildIncomingRequest helper), stores (PrincipalResolver +
  IdempotencyStore + RateLimitChecker + RouteRegistry interfaces
  + in-memory implementations), auth (EdDSA JWT verify with iss/
  aud/exp/nbf checks via @crossengin/crypto, opaque token matcher
  with constant-time compare, parseAuthHeader for Bearer/Basic/
  x-api-key), problems (RFC 9457 envelope builders for the 14
  declared problem types — authenticationRequired with WWW-
  Authenticate, tooManyRequests with Retry-After, sunsetEndpoint
  with Sunset header), dispatcher (HandlerRegistry mapping
  operationId → handler, handlerOutputToResponse converting
  json/empty/bytes outputs), pipeline-runner (PipelineRecorder
  enforcing stage-order monotonicity, building schema-valid
  PipelineExecution), runtime (GatewayRuntime.handleRequest walks
  the 17 stages: receive → parse_request → validate_tls →
  parse_auth → authenticate → resolve_principal → match_route →
  negotiate_version → negotiate_content → check_idempotency →
  check_rate_limit → validate_signature → validate_schema →
  dispatch_handler → transform_response → apply_security_headers
  → emit_audit; halts on terminating outcomes; merges
  DEFAULT_SECURITY_HEADERS on pass).
- **`workflow-runtime`** — in-process event-sourced workflow
  executor (third impure package). 7 modules: clock (Clock +
  IdGenerator interfaces, SystemClock + FixedClock,
  RandomIdGenerator + CountingIdGenerator), event-log (append-
  only `EventLog` interface + InMemoryEventLog with monotonic-
  per-instance sequence enforcement), projection (pure
  `projectInstance` / `projectActivities` / `projectSignals` /
  `projectTimers` — definition-aware projection refines status
  to waiting_for_signal/timer/manual based on outgoing transition
  triggers), transitions (pure trigger matching + guard
  evaluation, defaultGuardEvaluator covers always_true /
  variable_equals / variable_predicate with 8 operators /
  role_required), activity-handlers (`ActivityRegistry` with
  specific + per-kind fallback resolution, built-in handlers for
  audit_emit + transformation), engine (`WorkflowEngine.start
  Instance` / `submitSignal` / `tickTimers` / `cancelInstance` /
  `getInstanceState` / `listEvents`; step loop runs automatic
  transitions + on-entry actions until quiescent; signals
  matched by tenant + correlationKey with exactly_once
  idempotency dedup), saga (pure `planCompensation` /
  `listCompensatableActivities` / `hasOutstandingCompensation`
  handling immediate_reverse_order / parallel / manual_review /
  no_compensation strategies).
- **`crypto`** — real cryptography over `node:crypto`. 7 modules:
  algorithms (`HashAlgorithm`/`MacAlgorithm`/`SignatureAlgorithm`
  + `KeyPurpose` allow-list), hashing (SHA-256, BLAKE2b-512, hash
  chain step, content addressing, constant-time compare), hmac
  (HMAC-SHA256 + webhook signing in `t=...,v1=...` format with
  replay-window verify), signing (Ed25519 sign/verify/keypair via
  Node JWK, public key fingerprint), key-handles (opaque
  `KeyHandle` with tenant-scoped `KeyId` and `assertHandleTenant`
  guard), key-store (`KeyStore` interface + `InMemoryKeyStore`
  with rotate + revoke + per-tenant isolation), audit (auto-audit
  for management ops, schema-validated `CryptoAuditRecord`).
- **`types`** — primitive zod types shared across the workspace
  (UUIDs, ISO 8601, slugs, etc.).
- **`config`** — shared TypeScript + lint config base.
- **`testing`** — `vitestPreset` re-export used by every package.

### Identity, security, data
- **`auth`** — RBAC + ABAC + field-level permissions + write
  masks. RoleDefinition, RbacGrant, principals.
- **`sso`** — federated identity: SAML 2.0 + OIDC providers,
  SCIM 2.0 provisioning, claim mappings + JIT policies, session
  lifecycle, login audit.
- **`security`** — data classification, encryption keys, CSP,
  backup policy, incident classification, threat model,
  certifications.
- **`compliance`** — compliance pack architecture (21 CFR 11,
  HIPAA, GDPR, UAE-MoH). Packs contribute clauses to manifests.
- **`residency`** — 8 regions (eu-central/west, us-east/west,
  me-uae, gcc-ksa, apac-sg, ap-south), broad regions,
  residency profiles, routing.
- **`files`** — file lifecycle (upload → scan → available →
  archived), storage tier transitions, OCR, quota, audit.

### AI surface
- **`ai-providers`** — provider router contract, pricing tables,
  fallback policy, latency budgets.
- **`ai-router`** — `DefaultLlmRouter implements LlmRouter` —
  picks a provider per task using `TaskPolicyMap.primary` +
  `fallback[]`, retries transient (`isRetryable()`) failures
  with exponential backoff + jitter, falls back to the next
  provider on exhaustion, enforces per-tenant cost ceilings
  pre-flight via `CostTracker` (InMemoryCostTracker default
  ships rolling per-tenant USD windows; PostgresCostTracker is a
  future M6.6). Buffers chunks per-attempt so retry replays are
  clean. Tracks per-provider p50/p95 latency for observability +
  future latency-based routing. Throws `CostCeilingExceededError`
  / `ProviderResolutionError` / `AllProvidersExhaustedError` —
  all non-retryable, so the router doesn't loop on them.
- **`ai-providers-bedrock`** — real AWS Bedrock client
  implementing `LlmProvider`. Zero runtime deps; pure `fetch` +
  `node:crypto` + from-scratch AWS Signature V4. Speaks Bedrock's
  `converse-stream` (binary event-stream framing, NOT SSE),
  `converse` (non-streaming), `invoke` (embeddings via Titan
  or Cohere), AND the control-plane `ListModelInvocationJobs`
  endpoint (M2.X.5.aa.z.3). Two-host model: runtime endpoints
  at `bedrock-runtime.{region}.amazonaws.com`, control-plane
  endpoints at `bedrock.{region}.amazonaws.com`, same sig v4
  service. 8 modules: batch-api (BedrockBatchJobStatus +
  BEDROCK_BATCH_JOB_STATUSES 10-value tuple +
  buildBatchListQuery validator + parseBatchListResponse
  strict parser + BedrockBatchJobSummary /
  BedrockBatchJobListResponse types — for listBatches()
  enumeration of long-running batch inference jobs), pricing
  (8 chat models —
  Claude on Bedrock, Llama 3.1 70B/405B, Mistral Large, Titan
  Premier + 4 embedding models — Titan v2/v1, Cohere
  english/multilingual), signing (sig v4 with HMAC chain
  verified against the AWS-documented `f4780e2d...` reference
  signing key), converse-api (chat request builder + response
  normalizer), embeddings (family-dispatched request builders —
  Titan single-text with selectable 256/512/1024 dimensions;
  Cohere batched up to 96 texts with input_type selector),
  event-stream (binary frame parser → CompletionChunk; tracks
  contentBlockIndex → toolUseId across deltas; throws
  BedrockError on `:message-type: exception`), errors (12
  typed kinds including `model_stream_error` for
  ModelStreamErrorException; CODE_TO_KIND maps 15 AWS exception
  classes), provider (BedrockProvider with complete +
  completeNonStreaming + embed + embedMultimodal + listBatches —
  embed dispatches on family, loops over Titan or batches Cohere;
  listBatches GETs the control-plane host with sig v4 + sorted
  query string via signedControlPlaneGet helper). Capabilities:
  `{chat: true, streaming: true, toolUse: true, jsonMode: false,
  embedding: true, maxContextTokens: 200_000}`. The router has
  THREE real chat providers to chain — Anthropic + OpenAI + AWS
  — and TWO embedding providers — OpenAI's text-embedding-3 +
  Bedrock's Titan/Cohere. Real failover diversity across
  independent control planes; AWS-native end-to-end for tenants
  with strict residency requirements.
- **`ai-providers-anthropic`** — real Anthropic Messages API
  client implementing `LlmProvider`.
- **`ai-providers-openai`** — real OpenAI Chat Completions +
  Embeddings client implementing `LlmProvider`. Zero runtime
  deps (`fetch` + `ReadableStream`). 6 modules: pricing
  (gpt-4o / gpt-4o-mini / gpt-4-turbo / o1 / o1-mini for chat;
  text-embedding-3-small / text-embedding-3-large for
  embeddings; per-token + cached input + output rates with
  6-decimal cost rounding), chat-api (Chat Completions request
  builder translating `LlmMessage.toolUses` → OpenAI's
  `tool_calls` array; assistant.content goes to `null` when
  paired with tool calls and no text), streaming (SSE parser
  for the indexed-tool-call delta format — `tool_calls[i].
  index` identifies a call across deltas; arguments come as
  streamed JSON string fragments; usage from the final
  `stream_options.include_usage` chunk), embeddings (the FIRST
  real `embed()` implementation in the workspace; sorts vectors
  by index + derives `dim`), errors (11 typed kinds with same
  `isRetryable()` shape as Anthropic so the router treats them
  uniformly; maps `rate_limit_exceeded` + `service_unavailable`
  to the platform vocabulary), provider (`OpenAIProvider.
  complete()` + `completeNonStreaming()` + `embed()`; type
  guards reject embedding-model-in-chat and chat-model-in-embed
  locally; optional `openai-organization` + `openai-project`
  headers for enterprise routing). Capabilities `{embedding:
  true, jsonMode: true, supportsThinking: false}` — the
  complement of Anthropic's, so the router can route embedding
  tasks to OpenAI automatically. Zero runtime deps (pure
  `fetch` + `ReadableStream`). 5 modules: pricing (5 Claude 4.x
  models with per-token + cached + cache-write rates, USD cost
  rounded to 6 decimals), messages-api (request builder
  flattens system messages + re-attaches tool-role messages as
  `tool_result` blocks under user role; response normalizer
  computes Usage with cost), streaming (SSE parser + async
  generator over ReadableStream; shared StreamState across read
  boundaries so token counters survive multi-chunk fills),
  errors (11 typed kinds + RETRYABLE_KINDS set,
  `classifyHttpStatus` + `fromHttpResponse` + `fromNetworkError`
  with isRetryable() helper), provider
  (`AnthropicProvider.complete()` streaming + `completeNon
  Streaming()` + `embed()` throws invalid_request_error;
  `anthropic-beta` header for prompt caching / tool streaming
  / computer use; `FetchLike` injection for tests).
- **`ai-architect`** — AI Architect session contract, safety
  policy (refusals, gates, refusal copy, tenant settings, cost
  ceilings, eval gate, incidents, redteam). Plus session-record
  zod schemas (`ArchitectSessionRecord` / `…MessageRecord` /
  `…ToolInvocationRecord` / `…ProposalRecord`) that
  ai-architect-pg materializes into Postgres rows.
- **`ai-architect-pg`** — Postgres-backed transcript adapter for
  chat sessions. 5 modules: session-store + message-store +
  tool-invocation-store + proposal-store (each with append +
  list helpers against META_ARCHITECT_*); transcript
  (PostgresTranscript class threads sessionUUID + tenantId
  through onMessage / onToolInvocation / onProposal / onSession
  End — implements the `Transcript` interface architect-cli's
  chat engine emits into). `crossengin chat --persist` wires
  this in; tests use a fake transcript via ctx.transcriptOverride.

### Runtime + operations
- **`jobs`** — Inngest-style job kinds, idempotency keys, dead
  letters, cost ledger.
- **`observability`** — SLO definitions, error budget compute,
  redaction, synthetics, OTel-style tracing.
- **`integrations`** — integration call audit, idempotency at the
  integration boundary, HMAC signatures, retry policy.
- **`rate-limiting`** — unified rate-limit + quota contracts. 6
  algorithms (token_bucket, leaky_bucket, fixed/sliding window,
  sliding_log, concurrent_request) × 10 scope kinds × policies
  with 5 overage handling kinds; 10 quota targets × 7 periods × 6
  classes; RFC 9457 problem details + IETF rate-limit headers on
  every denial; 6 exception kinds with per-kind duration caps +
  four-eyes; throttle event audit.
- **`api-gateway`** — per-request edge pipeline composing auth +
  sso + rate-limiting + sdk. 17-stage pipeline (receive → ... →
  emit_audit) with state-machine ordering. 8 auth schemes × 15
  outcomes with clock-skew + audience + issuer + hmac-replay
  validation. Route matching with version negotiation + sunset.
  RFC-9457 problem details with 14 problem types. Idempotency
  with replay detection. Content + encoding + language negotiation.
  CORS + default security headers.
- **`feature-flags`** — 7 flag kinds (boolean, string, number,
  json, multivariate, percentage_rollout, kill_switch). 10
  targeting rule kinds with FNV-1a sticky percentage bucketing.
  9-stage rollout state machine (1pct → 5pct → ... → 100pct or
  rolled_back). 8-trigger kill switches with full separation of
  duties (armer ≠ trigger ≠ co-trigger). 17 evaluation reasons.
  23-kind append-only change audit with four-eyes gate.
- **`workflow-engine`** — runtime contracts for the manifest-level
  workflows declared in kernel: definitions (canonical executable
  form), instances (12 statuses), activities (10 kinds, retry
  policies, saga compensation), signals (3 delivery guarantees),
  timers (4 kinds), compensation plans, append-only event history.

### Reporting / search / UI
- **`reporting`** — reports, dashboards, schedules, ClickHouse
  audit, CDC.
- **`search`** — Typesense-style manifest, query, permission tags,
  embeddings, reindex.
- **`views`** — frontend renderer types (columns, views, theme,
  i18n, permissions, widgets).
- **`i18n`** — locales, ICU MessageFormat, CLDR plurals, bundle,
  resolution, calendar, tenant config.
- **`notifications`** — 6 channels × 18 providers, 5 content
  categories, template + audience + preference/suppression
  contracts, dispatch + delivery audit with retry/throttle/digest
  + quiet-hours decisions.

### Vertical packs
- **`pack-erp-healthcare`** — third vertical pack. Extends
  `operate-erp/core` via `meta.extends`. 3 entities (Patient
  with auditable + tenant_owned, references Account + Contact;
  Encounter referencing Patient with FHIR EncounterClass +
  6-state lifecycle; Observation referencing Encounter +
  Patient with FHIR R4 status enum + code_system covering
  LOINC/SNOMED/ICD-10). 3 relations (Account→Patient restrict,
  Patient→Encounter restrict, Encounter→Observation cascade).
  2 new roles (erp_clinician + erp_front_desk) that merge with
  core's three. 2 workflows: encounter_lifecycle (scheduled →
  checked_in → in_progress → completed | cancelled | no_show;
  only mark_no_show is automatic, used by the 15-min sweep job;
  2 SLAs at PT30M + P1D) and observation_lifecycle (FHIR R4 4
  states; entered_in_error is admin-only via permission gate
  for amendment discipline). 3 jobs (daily encounter-reminder
  at 08:00 UTC with phi i/o data class; */15 no-show-sweep;
  event-triggered fhir-export on `healthcare.encounter.
  completed` for downstream EHR integration). 3 list views.
  compliancePacks defaults to ["hipaa", "21_cfr_11"] — the
  meta-level signal for downstream tooling. Cross-pack
  references (Patient → Account, Patient → Contact) resolve via
  the M7.6.5 kernel resolver; standalone manifest fails
  validation by design (intentional — resolver merges first).
- **`pack-erp-payments`** — second vertical pack. Extends
  `operate-erp/core` via `meta.extends`. 1 entity (Payment
  with auditable + tenant_owned, references Invoice), 1
  relation (Invoice → Payment), 5 permission transitions,
  `payment_lifecycle` workflow (6 states: pending → captured
  → settled active; refunded / failed / cancelled terminal;
  refund reachable from captured or settled; 2 SLAs at P1D
  and P5D), 2 jobs (event-triggered provider webhook handler
  on `billing.payment_received` for the M6 signal bridge to
  consume; hourly settlement sweep as backstop), 1 list view.
  As of M7.6.5, `buildErpPaymentsPack()` returns a child-only
  manifest with `meta.extends: ["operate-erp/core"]`; the
  kernel's `resolveManifest` merges the parent at apply
  time. Cross-pack Payment → Invoice FK resolves via the
  merged manifest. Pattern for future packs that extend an
  existing pack — author declares `extends`, kernel does the
  merge work.
- **`pack-erp-core`** — first vertical pack. Declarative
  `Manifest` with 4 entities (Account, Contact, Invoice,
  InvoiceLine on the `auditable` trait), 3 relations, 3 roles
  (erp_admin / erp_accountant / erp_viewer), per-entity
  permissions + transition grants, an entityLifecycle workflow
  for Invoice (draft → sent → paid|overdue|void with `mark_paid`
  reachable from both sent + overdue; 30-day SLA on sent→paid),
  2 jobs (scheduled cron overdue-invoice-reminder +
  event-triggered payment-received-handler), 2 list views.
  `buildErpCorePack(opts?)` returns the full Manifest; passes
  `tryValidateManifest` end-to-end. Pattern for future
  `pack-erp-healthcare` / `pack-erp-retail` / etc. that extend
  via `meta.extends: ["operate-erp/core"]`.

### Business operations
- **`billing`** — plans, subscriptions, metered usage, invoices,
  payments, dunning, tax, events.
- **`finops`** — 17 cost categories × 5 allocation methods,
  per-tenant attribution, budgets + breach actions, unit
  economics (LTV/CAC/contribution margin), chargeback
  statements, cost reports.
- **`tenant-lifecycle`** — 7-state lifecycle (trial → … →
  deleted), grace periods, GDPR Article 17 deletion requests,
  data exports, cryptographic tombstones.

### Delivery + operations infrastructure
- **`deploy`** — apps × environments × strategies; migrations;
  feature flags; releases; artifacts; on-prem/BYOC packaging.
- **`dr`** — 5 DR tiers (mission-critical → best-effort), RPO/
  RTO targets, replication topology, backups, failover
  records, drills, runbooks.
- **`edge`** — region routing, latency budgets per route,
  autoscaling policies, edge cache, throttling, region
  affinity.
- **`active-active`** — multi-region active-active topology, 7
  consistency levels, vector clocks, 6 CRDT kinds (G/PN counters,
  OR-set, LWW register/map, MV register), conflict detection +
  resolution, split-brain lifecycle.
- **`pwa`** — PWA manifest, service worker, IndexedDB outbox,
  sync, push notifications (PHI-safe stubs), Capacitor wrapper.

### Developer / partner surface
- **`sdk`** — public API contract (versioning, scopes, operations,
  RFC 9457 problem details, cursor pagination, idempotency,
  webhooks with HMAC-SHA256).
- **`sdk-clients`** — language-specific client generation
  contract (10 target languages × 10 registries × 3 tiers,
  generator pipeline, semver release lifecycle, compatibility
  matrix, auth + retry helpers, client telemetry with W3C
  trace context).
- **`marketplace`** — installable extension packs, pack registry
  with ed25519 signing + security review, per-tenant install
  lifecycle, permission grants, marketplace listings + reviews.
- **`migration`** — 12 source kinds (CSV, JSONL, Salesforce,
  ServiceNow, SQL dumps, FHIR, etc.), schema inference, field
  mapping, preview/dry-run, idempotent backfill ledger,
  onboarding flow (workspace_setup → … → go_live).
- **`ml-training`** — opt-in consent (phi/regulated permanently
  forbidden), training datasets, eval sets (safety_refusal
  requires 100% pass), training runs, evaluations, model
  registry with shadow/canary/production lifecycle.

### Audit + compliance operations
- **`incident-response`** — 5 SEV levels with SLA profiles, 7
  incident roles, 8-state incident lifecycle, runbook
  executions, blameless postmortems with action items,
  customer comms with GDPR 72h breach notification deadline.
- **`forensics`** — hash-chained tamper-evident logs, evidence
  with sealed/retention/destruction lifecycle, chain-of-custody
  with sha256-verified transfers, legal holds with separation of
  duties, e-discovery requests, court-admissible attestations.
- **`access-reviews`** — periodic attestation campaigns (SOC 2 /
  ISO 27001 / HIPAA / PCI / GDPR / 21 CFR Part 11). Campaigns,
  items, decisions with attestation + four-eyes, exceptions with
  per-reason duration caps, templates, sealed evidence with
  per-framework control mappings.
- **`data-lineage`** — provenance graph for GDPR Article 15 right
  of access (+ CCPA / LGPD / PIPEDA / UAE peers). 14 node kinds ×
  10 edge kinds with classification propagation rules
  (pii → public via anonymized_from with k≥5, phi → internal via
  aggregated_from with k≥11). Provenance records, data subject
  registry (sha256-only identifiers), subject access requests,
  graph traversal (ancestors/descendants/path/cycle/subject impact),
  retention policies + Article 15 evidence packs.

## Cross-cutting invariants

Recurring patterns enforced by zod `superRefine`:

- **Four-eyes principle.** Anywhere an action is privileged
  (deletion, hold release, postmortem review, four-eyes
  approvals), the actor must not also be the approver. Check
  for `executedBy !== approvedBy`, `author ∉ reviewers`,
  `releasedBy !== issuedBy`.
- **State machines.** Most lifecycle types export a `*_STATUSES`
  enum, a `*_TRANSITIONS` map, and a `canTransition*` helper.
  The schema enforces status↔required-fields pairing.
- **Cryptographic anchoring.** Sha256 hashes for content
  addressing show up everywhere: dataset freezing, deletion
  proofs, evidence sealing, postmortem storage, webhook signing,
  pack signing (ed25519 there).
- **Tenant scoping.** Records with `tenant_id` get RLS. Cross-
  tenant audit/compliance records are platform-wide (cdc
  checkpoints, regions, plans, deployments, ediscovery,
  tombstones).
- **Forbidden lists.** PHI/regulated data can never be used for
  ML training (`FORBIDDEN_TRAINING_DATA_CLASSES`). Latest docker
  tag is forbidden (deploy). Two-person integrity for human
  evidence collection.
- **Deadlines.** Where regulation imposes timing (GDPR 72h
  breach, Article 12(3) 3-month deletion deadline), schemas
  enforce it.

## Meta-schema

`packages/kernel/src/bootstrap/meta-schema.ts` is the central
catalog of 115 platform-level Postgres tables. Each new package
adds tables there + updates `meta-schema.test.ts` (table count,
expected names list sorted alphabetically, column-check
assertions).

The test suite enforces two invariants:
1. Every `tenant_id`-bearing table has RLS enabled.
2. Foreign-key references resolve to a table declared earlier
   in `META_TABLES`.

When adding tables, **append them to the array at the bottom in
the order the package was built**, not alphabetically. The
expected-names test sorts independently.

## Build + test commands

```bash
# Install
pnpm install

# Per-package
pnpm --filter @crossengin/<name> build
pnpm --filter @crossengin/<name> test
pnpm --filter @crossengin/<name> typecheck

# Workspace
pnpm -r build
pnpm -r test
pnpm -r typecheck

# Build is fast; full workspace test ≈ 30s
```

There is **no top-level lint script**. ESLint config has not
been migrated to v9 flat config yet; ignore lint until asked.

## Conventions

- **Module structure.** Each package: `package.json`,
  `tsconfig.json` (extends `@crossengin/config/typescript/base`),
  `vitest.config.ts` (re-exports `vitestPreset`), `src/index.ts`
  (re-exports all source modules), 4–7 `src/*.ts` source modules,
  matching `src/*.test.ts` files.
- **Naming.** Constants `SCREAMING_SNAKE_CASE`, types `PascalCase`,
  schemas `<Name>Schema`. Stable id prefixes per kind:
  `INC-YYYY-NNNN` for incidents, `EV-` for evidence, `PM-` for
  postmortems, `LH-` for legal holds, etc.
- **Tests.** Each module gets its own `*.test.ts`. Tests cover
  constants, schema validation (accept + reject paths), helper
  functions, and state-machine transitions. Aim for 15–30 tests
  per module.
- **No comments.** The codebase generally doesn't have JSDoc or
  inline comments. Don't add them unless explaining a non-obvious
  invariant.

## Workflow

The user drives construction with `go [letter]` commands. After
each completed package, propose 6–8 next options labeled A–H and
recommend one. The user picks. Each landed package follows this
shape:

1. Read the relevant ADR (or design fresh against the
   conversation context if no ADR exists yet).
2. Scaffold `package.json` + `tsconfig.json` + `vitest.config.ts`.
3. Build 4–7 source modules with comprehensive zod schemas +
   deterministic helpers. No placeholders.
4. Build `src/index.ts` re-exporting everything.
5. Wire `META_*` tables into kernel meta-schema (+ test).
6. Write `*.test.ts` files alongside each source module.
7. Run `pnpm --filter @crossengin/<name> test` until green.
8. Run `pnpm -r test` to confirm no regression.
9. Run `pnpm -r typecheck`.
10. `git commit` with a detailed multi-paragraph message
    describing each module's enums + invariants + helpers.
11. `git push -u origin claude/crossengin-development-LXLNw`.

## Git

- Working branch: `claude/crossengin-development-LXLNw`.
- Never force-push. Never skip hooks (`--no-verify`).
- Don't create PRs unless the user asks.
- Repository scope is restricted to `amoufaq5/crossengin` and
  `amoufaq5/erp`.

## What's deferred to Phase 2+

The current packages model the *shape* of the platform. The
following are intentionally out of scope until contracts settle:

- Real provider clients (Stripe, Salesforce, ServiceNow).
  Today the packages have credential refs + record types only.
  (Anthropic ships its real client in M2.7 — see below.)
- Real cryptography. Signature fields are typed as strings; the
  actual HMAC/ed25519 computation is not in this codebase.
- Customer-facing apps under `apps/` other than `architect-cli`.
  UI lives in `views` as type definitions only.

**No longer deferred (as of M1):** kernel DDL execution. The
`kernel-pg` package executes meta-schema DDL against a real
Postgres, with `_meta_migrations` bookkeeping for idempotent
re-runs and pg_catalog introspection for drift detection.

**No longer deferred (as of M2):** real cryptography. The
`crypto` package produces verifiable SHA-256 / BLAKE2b-512
hashes, real HMAC-SHA256 / Ed25519 signatures over `node:crypto`,
with an opaque `KeyHandle` contract that hides raw key material
behind a `KeyStore` interface.

**No longer deferred (as of M2.5 + M2.6):** downstream crypto
wiring. The crypto package is now called from six existing
packages, so previously-string-only signature/hash fields are
populated by real verifiable values: marketplace pack manifests
carry real Ed25519 signatures with sha256 public key
fingerprints; sdk webhook deliveries carry real HMAC-SHA256
signatures bound to timestamps for replay protection; forensics
chain entries carry real hash chains rooted at GENESIS_HASH plus
Ed25519 entry signatures, and evidence is sealed with real
sha256 + Ed25519; tenant-lifecycle tombstones carry
canonical-JSON-derived contentManifestSha256 + proofSha256;
access-reviews decision attestations carry real Ed25519
signatures for the four strong attestation kinds (e_signature_
digital, qualified_e_signature, two_person_attestation) and the
campaign evidence pack carries a real sealedSha256 over the
canonical evidence + bundle bytes; data-lineage Article 15
evidence packs carry a real sealedSha256 over the canonical
pack + bundle bytes for GDPR right-of-access deliverables.

**No longer deferred (as of M2.7):** real LLM provider client.
The `ai-providers-anthropic` package ships a working binding to
Anthropic's Messages API. `AnthropicProvider.complete(req)`
POSTs to `/v1/messages` with `x-api-key` + `anthropic-version:
2023-06-01` + `accept: text/event-stream`, yields the
discriminated-union `CompletionChunk` kinds (`text` /
`tool_call_start` / `tool_call_arg_delta` / `tool_call_end` /
`usage_final`) from `@crossengin/ai-providers` as SSE events
stream in. Token state is shared across `reader.read()`
boundaries via an internal `processSseEvents(raw, state)`
helper, so `usage_final` carries cumulative input/output/cached
tokens with USD cost computed at per-model rates (opus-4-7
$15/$75 per million, sonnet-4-6 $3/$15, haiku-4-5 $1/$5;
cached input 90% off; cache-write 25% premium). Errors normalize
to `AnthropicError` with `kind` + `status` + `isRetryable()`.
The provider is the first concrete `LlmProvider` implementation
— the Architect agent (M5.5 chat command) can now run against
a real backend with real cost accounting.

**No longer deferred (as of M3):** workflow execution. The
`workflow-runtime` package consumes `WorkflowDefinition` shapes
and actually runs them: starts instances, threads variables,
runs automatic transitions, schedules + executes activities via
a registered handler registry, fires timers when their fireAt is
reached, accepts signals matched by tenant + correlationKey,
emits the documented 24 event kinds (instance_started /
state_transitioned / activity_* / signal_* / timer_* /
variable_updated / compensation_* / instance_completed/failed/
cancelled/suspended/resumed), and replays state by left-folding
the event stream.

**No longer deferred (as of M3.5 + M3.6 + M3.7):** workflow
persistence + wiring + recovery. The `workflow-runtime-pg`
package implements the `EventLog` interface against
META_WORKFLOW_EVENTS via `@crossengin/kernel-pg`. Events survive
process restarts; multiple worker processes can share an event
log. PostgresInstanceStore / ActivityStore / SignalStore /
TimerStore turn projected in-memory state into UPSERTs against
the corresponding META_WORKFLOW_* tables. `ProjectingEventLog`
wraps any `EventLog` and auto-runs the projection writers after
each append — drop it into a `WorkflowEngine` and every
transition, signal, timer, activity scheduling becomes a
Postgres write without the consumer needing to know.
`WorkflowReplayer.resyncInstance` re-projects from the canonical
event log + re-upserts to fix drift after crashes or schema
changes; `verifyInstance` returns a typed DriftReport for CI
guards; `bulkResync` iterates with pagination so periodic sweeps
stay bounded.
`buildPersistentEngine(conn, definitions)` is the one-call
factory that wires the whole thing together.

**No longer deferred (as of M4):** HTTP request handling. The
`api-gateway-runtime` package executes the 17-stage pipeline
declared in `@crossengin/api-gateway` as real middleware. A
POST request lands → walks the stages → produces an
OutgoingResponse + a schema-valid PipelineExecution. Unauth →
401 + WWW-Authenticate. Valid JWT + over-quota → 429 +
Retry-After. Replay with same Idempotency-Key → cached 201 with
X-Idempotent-Replay: true. Routes with required scopes plug
into @crossengin/auth's principal model.

**No longer deferred (as of M4.5 + M4.6):** production-shape
gateway persistence + audit. The `api-gateway-pg` package
implements the four store interfaces against the existing
META_GATEWAY_* + META_RATE_LIMIT_DECISIONS tables via
`@crossengin/kernel-pg`. Idempotency records survive process
restarts and persist across nodes. Route definitions live in the
database (cache reload on TTL or explicit refresh, plus upsert
API for tooling). Rate-limit decisions are auditable rows in
META_RATE_LIMIT_DECISIONS. PipelineExecutions persist to
META_GATEWAY_PIPELINE_EXECUTIONS so every request is queryable
by tenant + correlationId + time. `GatewayReplayer.verifyExecution`
returns a typed DriftIssue list per request — stages out of
order, final stage/outcome mismatches, pass with 4xx/5xx, deny
without 4xx/5xx, terminating outcome not last, duration
inconsistent, rate-limit decision orphaned. summarize / bulkVerify
power periodic SLO + audit sweeps over the execution stream.

**No longer deferred (as of M5 + M4.7):** the developer entry
point + a running gateway. `apps/architect-cli` ships a
`crossengin` binary with the M5 subcommand surface: `init`
(scaffold a manifest), `validate` (zod-check + summary), `diff`
(computeManifestDiff with human or JSON output), `patch` (write
a manifest patch), `hash` (deterministic manifestHash), `apply`
(--dry-run emits the 3,061-line meta-schema SQL; live mode uses
MigrationApplier against PGHOST/PGDATABASE), `chat` (wired in
M5.5 — see below), `gateway start` (M4.7 — boots the gateway
runtime against a Node HTTP server, in-memory or Postgres-backed,
with built-in `/__ping` + `/__health` routes), `version`, `help`.
Every subcommand has --format human|json. Exit codes: 0 success /
1 runtime problem / 2 misuse. The CLI is the first binary that
composes contracts → real artifact, and now also the binary that
turns the M4 gateway runtime into a real listening HTTP server.

**No longer deferred (as of M5.9):** the chat audit trail is
queryable from the CLI. `crossengin sessions list / show /
replay` reads from META_ARCHITECT_* via the existing M5.7
stores and renders sessions as human-readable transcripts.
The new `getBySessionId({tenantId, sessionId})` on the
session store makes the (tenant_id, session_id) compound key
first-class. Operators debugging a "Claude gave wrong manifest"
report find the session via `list`, inspect the full
transcript via `show`, and re-read the conversation
chat-style via `replay`. M5.6 tool dispatch + M5.8 write
approvals surface verbatim in the audit data.

**No longer deferred (as of M7.8):** webhook → workflow signal
wiring for payments. `pack-erp-payments/src/signal-bridge.ts`
exports the canonical signal-name vocabulary, the provider
event-type → signal-name map (Stripe + Adyen + Braintree), a
multi-path correlation extractor (handles `data.object.id`,
`pspReference`, `transaction.id`, generic `provider_reference`),
and factory functions that wrap M6's `WorkflowSignalBridge`
with the right defaults. End-to-end verified: HMAC-signed
Stripe-shaped `payment_intent.succeeded` webhook → bridge
extracts `pi_xxx` → `submitSignal({signalName: "payment.captured",
correlationKey: "pi_xxx", tenantId, idempotencyKey})`. Pattern
for future webhook-driven packs (`pack-erp-shipping` for
carriers, etc.).

**No longer deferred (as of M7.5 + M7.6.5 + M7.9):** cross-pack
composition with kernel-driven extends resolution, exercised by
TWO downstream consumers. `pack-erp-payments` and
`pack-erp-healthcare` both declare `meta.extends: ["operate-erp/
core"]`; both return only their child additions; both resolve
via the kernel's `resolveManifest(manifest, {registry})` (which
loads the parent by slug from the CLI's `packManifestRegistry()`
and merges entities + traits + relations + roles + permissions
+ workflows + jobs + views into one unified manifest). The
healthcare pack adds 2 new roles (erp_clinician + erp_front_
desk) that merge with core's three — proving role contributions
flow correctly. `crossengin apply --pack=operate-erp/payments`
emits 5 entity tables; `--pack=operate-erp/healthcare` emits 7
(4 core + 3 healthcare); both with M7.7 tenant isolation
intact. Cycle detection (`ExtendsCycleError`) and unknown-
parent errors (`UnknownParentManifestError`) surface as typed
CLI exit codes. Pattern set for future verticals — declare
extends, kernel does the merge, marketplace enumerates
dependencies without running pack builders.

**No longer deferred (as of M7.7):** per-tenant isolation on
pack tables. The kernel's `tenant_owned` built-in trait now
injects `tenant_id UUID NOT NULL` (indexed), a cross-schema FK
to `meta.tenants(id) ON DELETE CASCADE`, `ENABLE ROW LEVEL
SECURITY`, and a `<table>_tenant_isolation` policy that uses
the same `current_setting('app.current_tenant_id', true)::UUID`
expression as every META table. Pack-erp-core's four entities
opt in via `["auditable", "tenant_owned"]`; the resulting SQL
is production-grade for multi-tenant deployments.

**No longer deferred (as of M7-wire):** the substrate-to-pack
end-to-end loop. `crossengin apply --pack <slug>` now resolves
a registered pack (today: `operate-erp/core`), validates its
manifest, emits per-entity DDL via the kernel's
`emitManifestCreate`, and concatenates with the meta bootstrap
SQL into one atomic MigrationApplier run. Five years of
contract work + nine months of runtime work produce a working
binary that ships a working schema in one command.

**No longer deferred (as of M2.8.5):** OpenAI Responses API.
The provider opts into `/v1/responses` via the `defaultApiPath`
constructor option (or per-call via `completeViaResponses`).
The Responses path collapses system messages into `instructions`,
flattens tool calls + tool results into top-level
`function_call` + `function_call_output` items, and surfaces
reasoning summaries via the non-streaming
`summarizeResponsesResponse` helper (streaming only emits
text + tool chunks; reasoning lives off-channel). Pattern set
for future named-event streaming providers (Anthropic's
upcoming responses-style endpoint, AWS Bedrock converse stream)
without touching the `CompletionChunk` discriminated union.

**No longer deferred (as of M6.5.5):** the router is live in
the CLI. `crossengin chat` now uses `buildChatCompleter` to
adapt to whichever API keys are configured. One key →
single-provider mode (legacy behavior preserved). Both keys →
`DefaultLlmRouter` with default task policies (cheap tasks to
gpt-4o-mini, premium tasks to opus, embeddings to OpenAI).
New `--cost-ceiling-usd` flag enforces per-request budget when
the router is active. The CLI's session-end summary reports
which mode was used.

**No longer deferred (as of M2.8):** the second real LLM
provider + embeddings. `@crossengin/ai-providers-openai`
covers OpenAI's Chat Completions (gpt-4o family + o1 family)
and Embeddings (text-embedding-3 family) APIs end-to-end. The
M5.6 `LlmMessage.toolUses` extension translates cleanly into
OpenAI's `tool_calls` format with no schema changes — proving
the cross-provider pattern. The router (M6.5) now has two
real providers to route between; embeddings have a real
backend for the first time. Operators can configure
`taskPolicies.summarizer = { primary: "openai/gpt-4o-mini",
fallback: ["anthropic/claude-haiku-4-5"] }` to drop cheap
summarization to a $0.15/M model while keeping authoring on
Claude.

**No longer deferred (as of M6.5):** policy routing across
providers. `@crossengin/ai-router` lets a consumer hand off a
`CompletionRequest` and get back a stream with: provider chosen
via `TaskPolicyMap` (primary then fallback), residency-filtered
to the tenant's policy, retried with exponential backoff on
retryable errors, falling back to the next provider when
exhausted, and refused if the tenant's `costCeiling` would be
breached. Pre-flight cost estimate uses input length + maxTokens
× per-million pricing; the post-call `usage_final.cost` replaces
the estimate in the cost tracker. Pattern set for OpenAI /
Bedrock / Vertex once their `LlmProvider` adapters land — no
router changes needed.

**No longer deferred (as of M7):** the first vertical pack.
`@crossengin/pack-erp-core` ships a real Manifest that exercises
every kernel cross-validator. The substrate is now proven —
entities, relations, roles, permissions, workflows, jobs, and
views all resolve correctly under a realistic ERP schema. The
Architect agent has a concrete starting point: `buildErpCorePack
(opts)` returns a working Manifest a developer can validate +
hash + apply via the existing CLI flow. Pattern set for future
verticals (healthcare, retail, construction): same module shape,
same cross-validators, optional `meta.extends` lineage.

**No longer deferred (as of M5.7):** chat audit trail. The new
`@crossengin/ai-architect-pg` package persists every chat
session, message, tool invocation, and write proposal to four
META_ARCHITECT_* tables. The chat engine emits lifecycle events
(`onSessionStart` / `onMessage` / `onToolInvocation` /
`onProposal` / `onSessionEnd`) into an abstract `Transcript`
interface; `NullTranscript` (default) discards events,
`PostgresTranscript` writes them. Sessions are unique per
(tenant, session_id); messages are ordered by
(turn_index, message_index); proposals record `decision` (one
of auto_approved / interactive_approved / interactive_denied /
no_changes / invalid_manifest) + `applied` + `denial_reason`.
Operators query `SELECT * FROM meta.architect_proposals WHERE
decision = 'interactive_approved'` to audit writes,
`JOIN architect_messages ON session_id` to reconstruct the
conversation context for any proposal.

**No longer deferred (as of M5.8):** closed authoring loop.
`crossengin chat --allow-file-write` now exposes
`propose_manifest_edit({path, new_manifest_json})` as a tool
Claude can invoke. Every write proposal surfaces a diff
(entities added / removed / modified) + the new hash to the
developer, who approves (`y` / `yes`) or denies (`n` /
anything else / EOF). Approved writes go to disk pretty-
printed; denied / invalid / no-change proposals return
typed `{applied: false, reason}` envelopes Claude can react
to. `--auto-approve-writes` skips the prompt (required for
one-shot scripted mode, where there's no human to ask).
`WriteApprover` interface decouples approval policy from
the tool itself — `autoApprover(true)` for scripted runs,
`interactiveApprover({io, reader})` for the REPL. Both share
the same `LineReader` the REPL uses, so the approval prompt
and the chat prompt cooperate over one stdin without
competing readers.

**No longer deferred (as of M5.6):** tool-driven authoring loop.
`crossengin chat` now exposes the manifest-side CLI helpers as
tools Claude can call mid-conversation. The default catalog
(`validate_manifest` / `hash_manifest` / `diff_manifests` /
`summarize_manifest`) gives Claude what it needs to author +
verify a manifest in one session; `--allow-file-read` adds an
extension-gated, size-capped `read_file` tool when the developer
explicitly opts in. `runChatExchange` orchestrates per-message
tool dispatch with a `DEFAULT_MAX_TOOL_ITERATIONS` (5) circuit
breaker. Tool errors don't terminate the exchange — they go
back to Claude as `tool_result` envelopes so the model can
react. `@crossengin/ai-providers.LlmMessage` gained an optional
`toolUses` field so assistant tool_use blocks round-trip
correctly through Anthropic's API (required for `tool_use_id`
matching on subsequent `tool_result` blocks).

**No longer deferred (as of M5.5):** chat against a real model.
`crossengin chat` now constructs an `AnthropicProvider` (using
`ANTHROPIC_API_KEY` from env + a configurable `--model`,
defaulting to claude-sonnet-4-6) and routes through the shared
chat engine in `architect-cli/src/chat.ts`. `runChatTurn`
streams chunks from `provider.complete()` to a renderer
(plain-text for human, NDJSON for `--format=json`), accumulates
assistant text + tool calls + usage. `runChatRepl` handles both
one-shot (`--prompt "..."`) and REPL (stdin lines until `/exit`
/ EOF) modes, aggregating per-turn usage into a session total
with USD cost. Tests inject a stub `LlmProvider` via
`RunContext.providerOverride`, so CI runs offline without an
Anthropic key.

## ADRs

ADRs 0001-0104 exist as markdown in `docs/adr/`. Every shipped
package has a corresponding ADR; no reserved gaps. ADR-0046 is
the bridge from Phase 1 contracts to Phase 2 runtime (8
milestones). ADR-0047 covers Phase 2 M1 (`kernel-pg`), ADR-0048
covers Phase 2 M2 (`crypto`), ADR-0049 covers Phase 2 M3
(`workflow-runtime`), ADR-0050 covers Phase 2 M4
(`api-gateway-runtime`), ADR-0051 covers Phase 2 M5
(`architect-cli`), ADR-0052 covers Phase 2 M6
(`workflow-signal-bridge`), ADR-0053 covers Phase 2 M2.7
(`ai-providers-anthropic`), ADR-0054 covers Phase 2 M5.5
(architect-cli chat mode), ADR-0055 covers Phase 2 M5.6
(architect-cli tool-driven chat), ADR-0056 covers Phase 2
M5.8 (architect-cli write tools), ADR-0057 covers Phase 2
M5.7 (chat persistence to META_ARCHITECT_*), ADR-0058 covers
Phase 2 M7 (`pack-erp-core`), ADR-0059 covers Phase 2 M6.5
(`ai-router`), ADR-0060 covers Phase 2 M2.8
(`ai-providers-openai`), ADR-0061 covers Phase 2 M6.5.5
(architect-cli router integration), ADR-0062 covers Phase 2
M2.8.5 (OpenAI Responses API support), ADR-0063 covers Phase 2
M7-wire (CLI `--pack` apply), ADR-0064 covers Phase 2 M7.7
(pack tenant scoping via `tenant_owned` trait), ADR-0065
covers Phase 2 M7.5 (pack-erp-payments — cross-pack
composition), ADR-0066 covers Phase 2 M7.8 (payment
signal-bridge wiring), ADR-0067 covers Phase 2 M5.9 (CLI
sessions subcommands), ADR-0068 covers Phase 2 M7.6.5
(kernel `extends` resolver wiring), ADR-0069 covers Phase 2
M4.7 (CLI gateway binding), ADR-0070 covers Phase 2 M7.9
(`pack-erp-healthcare` — third vertical pack), ADR-0071 covers
Phase 2 M2.9 (`ai-providers-bedrock` — third real LlmProvider
with AWS sig v4 + binary event-stream parsing), ADR-0072 covers
Phase 2 M2.9.5 (Bedrock Titan + Cohere embeddings closing
M2.9's open Q4), ADR-0073 covers Phase 2 M6.5.6 (architect-cli
Bedrock integration), ADR-0074 covers Phase 2 M4.7.5 (gateway
JWT auth + routes subcommand), ADR-0075 covers Phase 2 M4.7.6
(URL-fetched JWKS + SIGHUP/periodic hot-reload), ADR-0076
covers Phase 2 M2.9.6 (Bedrock cacheControl + Titan
parallelism), ADR-0077 covers Phase 2 M2.9.7 (Bedrock
multimodal embeddings + chat image content block types),
ADR-0078 covers Phase 2 M2.X (kernel LlmMessage.attachments
+ vision capability — multimodal chat across Anthropic +
OpenAI + Bedrock), ADR-0079 covers Phase 2 M4.8 (gateway
routes from pack manifest — bulk register-pack via the
M7.6.5 extends resolver), ADR-0080 covers Phase 2 M4.8.x
(gateway routes unregister-pack — symmetric tear-down),
ADR-0081 covers Phase 2 M4.8.y (gateway routes sync-pack —
composite diff/upsert + external-route reporting), ADR-0082
covers Phase 2 M4.10 (routes.source_pack column — pack
attribution + safe `sync-pack --prune-obsolete`), ADR-0083
covers Phase 2 M4.10.x (`unregister-pack --by-source-pack` —
manifest-free tear-down via the source_pack column), ADR-0084
covers Phase 2 M2.9.8 (Bedrock Guardrails integration — opt-in
content moderation with thrown errors for streaming + typed
stopReason for non-streaming), ADR-0085 covers Phase 2 M2.9.8.x
(Bedrock per-request guardrail override — sibling methods with
three-state semantics for tenant-specific / A-B-cohort /
admin-escape-hatch use cases), ADR-0086 covers Phase 2 M2.X.6
(OpenAI + Anthropic moderation surfaces — typed errors for
`finish_reason: "content_filter"` and `stop_reason: "refusal"`
matching the M2.9.8 post-usage_final-throw pattern), ADR-0087
covers Phase 2 M2.X.6.x (cross-provider moderation helper —
kernel-level `isModerationError(err)` predicate + shared
`MODERATION_ERROR_KINDS` tuple), ADR-0088 covers Phase 2 M2.X.5
(kernel LlmMessage.content discriminated union — unblocked
multimodal assistant outputs across Anthropic / OpenAI / Bedrock),
ADR-0089 covers Phase 2 M2.X.5.x (tool_use + tool_result content
block variants — consolidates tool-call surface with OpenAI
flatMap refactor for message-flattening), ADR-0090 covers Phase
2 M2.X.7 (cross-provider retryable helper — kernel-level
`isRetryableError(err)` + shared `RETRYABLE_ERROR_KINDS` tuple,
symmetric with M2.X.6.x's moderation helper), ADR-0091 covers
Phase 2 M6.6 (router uses kernel cross-provider helpers —
exercises M2.X.6.x + M2.X.7 in real consumer code + fixes
M2.X.5 array-content estimation bug), ADR-0092 covers Phase 2
M2.X.8 (standalone OpenAI Moderations API — provider.moderate
for proactive pre-screening with 11-category classification),
ADR-0093 covers Phase 2 M2.8.6 (OpenAI Responses API image
inputs — closes M2.X.5 vision gap on the Responses path),
ADR-0094 covers Phase 2 M2.X.5.y (ImageUrlContentBlock — URL-
based image variant for the kernel content union, with
OpenAI pass-through and Bedrock/Anthropic throw semantics),
ADR-0095 covers Phase 2 M2.X.9 (cross-provider input-too-
large helper — third predicate in the kernel error
classification surface, completing the partition into
retryable + moderation + input-too-large + other), ADR-0096
covers Phase 2 M2.X.5.z (Anthropic URL-source image support —
threads ImageUrlContentBlock URLs through to Anthropic's
native URL source variant; provider parity expanded for
URL-based images across both OpenAI paths + Anthropic),
ADR-0097 covers Phase 2 M2.X.5.aa (DocumentContentBlock — PDF
inputs supported on Bedrock + Anthropic + OpenAI Responses
via native document/file content blocks; OpenAI Chat throws
with actionable guidance pointing to the Responses path),
ADR-0098 covers Phase 2 M2.X.5.aa.y (DocumentUrlContentBlock —
URL-based PDF inputs; Anthropic native passthrough, three other
provider paths throw with pre-fetch guidance), ADR-0099 covers
Phase 2 M2.X.5.aa.x (document format expansion txt/md/csv —
4 formats × 3 providers all native), ADR-0100 covers Phase 2
M2.X.5.aa.x.1 (office document format expansion — doc/docx/xls/
xlsx/html added; Bedrock native, two-provider throw with
conversion guidance), ADR-0101 covers Phase 2 M2.X.10 (kernel
LlmMessage.name enforcement + OpenAI Chat threading across all
four message roles), ADR-0102 covers Phase 2 M2.X.5.aa.z
(OpenAI Files API integration — upload/retrieve/delete CRUD +
FileReferenceContentBlock kernel variant; OpenAI Responses
native passthrough, three other provider paths throw),
ADR-0103 covers Phase 2 M2.X.5.aa.z.1 (Anthropic Files API
integration — mirror of OpenAI Files API but with Anthropic
beta header and document source: {type: "file"} variant; the
M2.X.5.aa.z Anthropic throw becomes a native passthrough),
ADR-0104 covers Phase 2 M2.X.5.aa.z.2 (Files API listFiles()
across OpenAI + Anthropic — provider-native pagination shapes
preserved; CRUD+list pattern complete on both providers),
ADR-0105 covers Phase 2 M2.X.5.aa.z.3 (Bedrock batch inference
listBatches — first control-plane operation on Bedrock,
exposed via a separate controlPlaneBaseUrl + signedControlPlaneGet
helper; three-provider enumeration parity achieved across
OpenAI listFiles + Anthropic listFiles + Bedrock listBatches).
When you ship a new package, write the matching ADR in the same
session, following `0000-template.md` and the style of the
existing 0026-0037 batch.
