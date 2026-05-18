# ADR-0071: AWS Bedrock LLM provider (Phase 2 M2.9)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-18 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0053 (Anthropic provider), ADR-0060 (OpenAI provider), ADR-0062 (OpenAI Responses API), ADR-0059 (ai-router) |

## Context

M2.7 shipped `@crossengin/ai-providers-anthropic` — the first concrete `LlmProvider`. M2.8 shipped `@crossengin/ai-providers-openai` — the second, with embeddings. The router (M6.5) can chain them with retry + cost ceilings + provider fallback. M2.9 ships the third real provider — `@crossengin/ai-providers-bedrock` — completing the multi-provider trio.

Why Bedrock specifically:

1. **AWS gravity.** Many enterprise tenants are already on AWS for residency / billing / compliance. Routing chat workloads through Bedrock keeps inference inside their AWS account, simplifies SOC 2 / HIPAA / 21 CFR 11 boundaries (cf. the M7.9 healthcare pack).
2. **Model diversity behind one API.** Bedrock's converse API gives a single shape over Anthropic Claude, Meta Llama, Mistral, and Amazon Titan models. Without changing the router, an operator can route the `summarizer` task to `meta.llama3-1-70b-instruct` ($0.72/M) and the `planner` task to `anthropic.claude-3-7-sonnet` on Bedrock ($3/$15) — and tomorrow swap to whichever model is cheapest for that quarter.
3. **Failover diversity.** Today's router fallback chain is Anthropic → OpenAI. If both providers' first-party APIs degrade simultaneously (rare but it happens), having a third unrelated control plane (AWS) genuinely matters. Same model (e.g., Claude 3.5 Sonnet) served from a different endpoint via Bedrock is a valid hedge.

Three constraints shaped the design:

- **Zero runtime deps, like M2.7 / M2.8.** No `@aws-sdk/*` packages. Pure `fetch` + `node:crypto` + a from-scratch AWS Signature V4 implementation. Same pattern as the existing providers.
- **Binary event-stream framing, not SSE.** Bedrock's `converse-stream` endpoint returns AWS event-stream binary frames (4-byte BE length prelude → headers → JSON payload → CRC), not SSE. The streaming module must parse the binary protocol byte-by-byte; the `CompletionChunk` output is identical to OpenAI/Anthropic streaming. The contract stays uniform; the wire format diverges per provider.
- **No embeddings yet.** Bedrock has Titan embeddings (`amazon.titan-embed-text-v2`), but they use a different `InvokeModel` endpoint with a different request/response shape. Wiring them is a clean separable concern — out of M2.9 scope. `embed()` rejects with a typed error directing callers to OpenAI or a future M2.9.5 Titan-embeddings binding.

## Decision

New workspace package `packages/ai-providers-bedrock` (6 source modules + tests).

### Module map

```
packages/ai-providers-bedrock/
  package.json          # deps: @crossengin/ai-providers, zod
  tsconfig.json         # extends @crossengin/config/typescript/base.json
  vitest.config.ts      # re-exports vitestPreset
  src/
    index.ts            # barrel exports
    pricing.ts          # 8 chat models + per-token rates + cost computer
    signing.ts          # AWS Signature V4 (pure node:crypto)
    converse-api.ts     # CompletionRequest → BedrockConverseRequest
    event-stream.ts     # AWS event-stream binary parser → CompletionChunk
    errors.ts           # 12 typed error kinds + retry policy
    provider.ts         # BedrockProvider class
    *.test.ts           # one test file per source module
```

### `pricing.ts`

8 chat models with realistic per-token rates:

| Model | Input $/M | Output $/M | Cached input $/M |
|---|---|---|---|
| `anthropic.claude-3-5-haiku-20241022-v1:0` | 0.80 | 4.00 | 0.08 |
| `anthropic.claude-3-5-sonnet-20241022-v2:0` | 3.00 | 15.00 | 0.30 |
| `anthropic.claude-3-7-sonnet-20250219-v1:0` | 3.00 | 15.00 | 0.30 |
| `anthropic.claude-opus-4-20250514-v1:0` | 15.00 | 75.00 | 1.50 |
| `meta.llama3-1-70b-instruct-v1:0` | 0.72 | 0.72 | — |
| `meta.llama3-1-405b-instruct-v1:0` | 5.32 | 16.00 | — |
| `mistral.mistral-large-2407-v1:0` | 2.00 | 6.00 | — |
| `amazon.titan-text-premier-v1:0` | 0.50 | 1.50 | — |

Claude-on-Bedrock matches Anthropic's first-party pricing exactly, including the 90%-off cached-input rate. Llama / Mistral / Titan have no separate cached pricing (Bedrock doesn't expose prompt caching for those models in the same way). `computeBedrockChatCost(model, tokens)` subtracts cached input from the uncached bucket before applying the per-million rate.

### `signing.ts` — AWS Signature V4

Pure implementation, no SDK deps. Uses `node:crypto` (`createHash` for SHA-256, `createHmac` for the HMAC chain). Five-step key derivation: `kSecret → kDate → kRegion → kService → kSigning`, each step `HMAC-SHA256(prev, next_input)`. The final `signature = HMAC-SHA256(kSigning, stringToSign)` is hex.

The canonical request is built per the AWS spec: `method\npath\ncanonicalQuery\ncanonicalHeaders\nsignedHeaders\nbodySha256`. Headers are lowercased + sorted. URI encoding follows AWS rules (unreserved set: alphanumeric + `-_.~`; slashes in paths preserved; query parameters fully encoded). The `x-amz-content-sha256` header is always added and always signed (required by Bedrock streaming).

`signRequest({method, host, path, query, headers, body, region, service, credentials, now})` returns `{authorization, amzDate, contentSha256, headers}`. Pure given inputs.

Verified against the AWS-documented reference: `HMAC chain for secret=wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY, date=20120215, region=us-east-1, service=iam` → `f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d`. Test `signRequest — signing key derivation matches AWS reference` asserts this exactly.

### `converse-api.ts`

Translates `CompletionRequest` → Bedrock's `ConverseRequest` shape:

- System messages → top-level `system: [{text}]` array (lifted out of the messages list)
- User messages → `{role: "user", content: [{text}]}`
- Assistant messages with `toolUses` → `{role: "assistant", content: [{text}, {toolUse: {toolUseId, name, input}}]}`
- Tool-role messages (tool results) → folded back into a `user` message with a `toolResult` content block (Bedrock's quirk — tool results are reattributed to the user role)
- Tools → `toolConfig: {tools: [{toolSpec: {name, description, inputSchema: {json}}}]}`
- `maxTokens` + `temperature` → `inferenceConfig`

Response normalizer `normalizeConverseUsage(model, usage)` extracts tokens, includes `cacheReadInputTokens` when present, and computes USD cost. Cache-write tokens are tracked separately by Bedrock but folded into the input bucket for cost (matches Anthropic's first-party behavior).

### `event-stream.ts` — AWS binary frame parser

The trickiest piece. Bedrock's `converse-stream` returns frames in this format:

```
[ 0.. 4)  uint32 BE: total length (entire frame including length fields + CRCs)
[ 4.. 8)  uint32 BE: headers length
[ 8..12)  uint32 BE: prelude CRC32
[12..12+headersLen)   headers
[12+headersLen..end-4) JSON payload
[end-4..end)  uint32 BE: message CRC32
```

Each header is `name_length (u8) + name + value_type (u8) + value_length (u16 BE) + value`. Only the `string` (type 7) and `byte_array` (type 6) types are supported in the parser — Bedrock event-stream only uses strings in practice.

`parseEventStreamMessage(buffer)` returns `{message: {headers, payload}, consumed}` or null when the buffer is too short. The CRC fields are NOT validated — at the TCP/HTTP layer the body has already passed transport-level integrity checks; rejecting on CRC mismatch in pure userspace would only catch SDK bugs (not transport corruption).

`mapEventToChunks(message, toolBlocks, opts)` dispatches on `:event-type`:

- `messageStart` → emits nothing
- `contentBlockStart` with `start.toolUse` → emits `{kind: "tool_call_start", id, name}` + records `(contentBlockIndex → toolUseId)` in the `toolBlocks` map
- `contentBlockStart` with text → emits nothing
- `contentBlockDelta` with `delta.text` → emits `{kind: "text", text}`
- `contentBlockDelta` with `delta.toolUse.input` (JSON string fragment) → emits `{kind: "tool_call_arg_delta", id, delta}` using the recorded id
- `contentBlockStop` on a tool block → emits `{kind: "tool_call_end", id}` + clears the map entry
- `messageStop` → emits nothing
- `metadata` → emits `{kind: "usage_final", usage}` with computed cost
- `:message-type: exception` → throws `BedrockError(kind: "model_stream_error")` with the upstream message

`readConverseEventStream(body, {model})` is the async generator: buffers `ReadableStream<Uint8Array>` reads, parses as many complete frames as possible after each read, and yields the chunks. Handles frames split across read boundaries. Throws if unparsed bytes remain at end of stream.

### `errors.ts`

12 typed error kinds (Bedrock-specific addition: `model_stream_error` for `ModelStreamErrorException`, fired when an upstream model crashes mid-stream). `RETRYABLE_KINDS = {rate_limit_error, overloaded_error, network_error, timeout_error, api_error, model_stream_error}` — same isRetryable() shape as M2.7 / M2.8. `BedrockError.isRetryable()` returns `RETRYABLE_KINDS.has(this.kind)`.

`fromHttpResponse({status, body})` parses AWS's `{__type: "Namespace#ThrottlingException", message: "..."}` JSON envelope, strips the namespace prefix, and maps via `CODE_TO_KIND` (15 AWS exception classes → 8 kernel-level kinds). Status-based fallback when the body isn't JSON.

### `provider.ts` — `BedrockProvider` class

```ts
new BedrockProvider({
  accessKeyId: string,           // required
  secretAccessKey: string,       // required
  sessionToken?: string,         // STS temp creds
  region?: string,               // default "us-east-1"
  defaultModel?: BedrockChatModel,
  defaultMaxTokens?: number,
  baseUrl?: string,              // computed from region by default
  residency?: Region[],          // derived from region prefix by default
  fetch?: FetchLike,             // injectable for tests
  clock?: () => Date,            // injectable for sig v4 testing
})
```

- `complete(req)` POSTs to `/model/{modelId}/converse-stream` with `accept: application/vnd.amazon.eventstream`, sig v4 signed, streams binary frames via `readConverseEventStream`. Errors wrap as `BedrockError`.
- `completeNonStreaming(req)` POSTs to `/model/{modelId}/converse` with `accept: application/json`, sig v4 signed, returns the parsed `BedrockConverseResponse`.
- `embed(_req)` rejects with `BedrockError(kind: "invalid_request_error")` directing callers to OpenAI or a future Titan embeddings provider.
- `extractText(response)` / `extractToolCalls(response)` / `normalizeUsage(model, response)` are exposed for non-streaming consumers.

Residency derivation: `eu-*` → `["eu"]`, `ap-*` / `me-*` → `["ap"]`, `sa-*` → `["sa"]`, else `["us"]`. Capability set: `{chat: true, streaming: true, toolUse: true, jsonMode: false, embedding: false, maxContextTokens: 200_000, supportsThinking: false}` — Bedrock claude models support 200k context; Llama / Mistral / Titan have smaller windows but the contract reports the union upper bound.

## Cross-cutting invariants enforced

- **Zero runtime deps.** Only `@crossengin/ai-providers` + `zod`. `node:crypto` is a built-in. No `@aws-sdk/*` anywhere.
- **Same `LlmProvider` contract as M2.7 + M2.8.** `complete()` returns `AsyncIterable<CompletionChunk>`. The discriminated-union chunks are identical. The router and chat substrate don't care which provider produced them.
- **Same isRetryable shape.** `RETRYABLE_KINDS` lines up with OpenAI's: rate_limit / overloaded / network / timeout / api errors are retryable; auth / validation / not_found / permission errors are not. The router's exponential-backoff retry logic works uniformly.
- **Sig v4 is verifiable.** The signing key derivation is tested against the AWS-published reference (the famous `f4780e2d...` constant). The full request signature is regression-tested for determinism + sensitivity (different body / region / path → different signature).
- **Binary parser is robust.** Tests cover: truncated buffers, frames split across reads, truncated headers, unknown event types (silently ignored — forward compatibility), exception events (throw with model_stream_error kind), tool-block tracking across deltas.
- **Pricing rounds to 6 decimals.** Same as OpenAI + Anthropic. `Number(value.toFixed(6))`.
- **No PII / credential leakage in errors.** AWS exception messages are truncated to 480 chars; the full request body never appears in error messages.

## Alternatives considered

- **Use `@aws-sdk/client-bedrock-runtime`.**
  - **Pros.** Battle-tested. Handles sig v4 + event-stream parsing + STS credential providers + retry built-in.
  - **Cons.** ~5 MB of runtime deps. Different streaming abstraction. Breaks the zero-dep pattern M2.7 + M2.8 established. Tighter coupling to AWS SDK versions (security updates pulled in transitively).
  - **Decision.** Build from scratch. Same investment we made for Anthropic's SSE + OpenAI's Chat Completions.

- **Skip `converse-stream` and use `InvokeModelWithResponseStream` directly.**
  - **Considered.** `InvokeModel` is the older API with per-model request/response shapes (Claude messages, Llama prompts, etc.).
  - **Decision.** Reject. `converse` / `converse-stream` give one unified shape across all model families — that's the whole point of routing through Bedrock instead of first-party APIs.

- **Embed sig v4 in `@crossengin/crypto` as a reusable helper.**
  - **Considered.** Future AWS integrations (S3 backups, SQS jobs, etc.) might want this.
  - **Decision.** Keep it local to the Bedrock provider for now. The signing module is 200 lines — moving it to crypto requires a stable cross-package contract. When the second AWS-talking package lands, refactor.

- **Validate CRC32 fields in event-stream frames.**
  - **Considered.** The AWS event-stream spec includes prelude CRC + message CRC.
  - **Decision.** Skip CRC validation. TCP / HTTP/2 already provide transport integrity. Userspace CRC mismatches would only catch SDK bugs in either direction. Adds complexity (node has `zlib.crc32` but it's lazy-imported) for ~zero real-world benefit.

- **Implement Titan embeddings alongside chat in M2.9.**
  - **Considered.** Round out the embedding story too.
  - **Decision.** Defer to M2.9.5. `InvokeModel` endpoint with `amazon.titan-embed-text-v2:0` body is a different request shape, different signed path, different response. Cleaner as its own milestone.

- **Add Bedrock to `architect-cli`'s `router-setup.ts` automatically when `AWS_ACCESS_KEY_ID` env var is present.**
  - **Considered.** Symmetric with how OpenAI + Anthropic are detected.
  - **Decision.** Defer to M6.5.6 (a future CLI integration milestone). M2.9 ships the provider; the CLI wiring is a separable concern with its own design (which task policies should default to Bedrock? Should Bedrock be the third fallback by default, or only when explicitly opted in?).

- **JWT-style endpoint role assumption via `AssumeRoleWithWebIdentity`.**
  - **Considered.** Production deployments often use OIDC-issued AWS roles (no static keys).
  - **Decision.** Defer. The current constructor accepts `sessionToken` so callers can use STS-issued temp credentials externally. Native OIDC flow can land in M2.9.5.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,214 tests** (+101 from M2.9). All green, zero type errors.
- **The router now has three real providers to chain.** `DefaultLlmRouter` (M6.5) can route `summarizer` to `meta.llama3-1-70b` on Bedrock at $0.72/M, fall back to `gpt-4o-mini` on OpenAI at $0.15/M, fall back to `claude-haiku-4-5` on Anthropic at $1/$5. Or any other combination. Three independent control planes = real failover diversity.
- **Same architectural pattern proves replicable.** M2.7 (Anthropic SSE), M2.8 (OpenAI SSE), M2.8.5 (OpenAI Responses named-event SSE), M2.9 (Bedrock binary event-stream) — four different wire formats, one `CompletionChunk` discriminated union. Future providers (Vertex Streaming, Cohere, etc.) drop into the same shape with no contract changes.
- **AWS sig v4 is a known quantity in this codebase.** When the next AWS-talking package lands (S3 file storage backend? SQS background job runner?), the signing logic can be extracted out of `ai-providers-bedrock` into `@crossengin/crypto` (or a new `@crossengin/aws-signing` helper) without rewriting it.
- **Healthcare residency story improves.** With Bedrock available, the M7.9 healthcare pack's PHI-bearing chat (e.g., a clinician asking the Architect to "draft a discharge summary from this Encounter's notes") can be routed entirely inside the tenant's AWS account in `us-east-1` / `eu-west-1` for HIPAA / GDPR alignment.
- **Documented pricing requires periodic refresh.** Bedrock pricing changes more often than first-party (AWS re-prices regularly). `BEDROCK_CHAT_PRICING` is a single readonly record that operators can monkey-patch via a custom provider subclass, or refresh in a future M2.9.x ADR with an explicit cutoff date.

## Open questions

- **Q1:** Should the provider fall back to `converse` (non-streaming) when the model doesn't support `converse-stream`?
  - _Current direction:_ No silent fallback. All 8 documented models support streaming; if a future model is non-streaming-only, surface that at construction time.
- **Q2:** Should `BedrockProvider` accept credentials from the environment automatically (mirror AWS SDK behavior)?
  - _Current direction:_ Not in M2.9. Constructor takes credentials explicitly; the CLI integration (M6.5.6) can read `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` from `ctx.env` and pass them in. Keeps the provider testable without env var mocking.
- **Q3:** What about prompt caching for Claude on Bedrock — does the existing `cacheControl` field in `CompletionRequest` get threaded through?
  - _Current direction:_ Out of scope for M2.9. Bedrock supports `cachePoint` markers in the converse request but the M5.6 `cacheControl` field is shaped for first-party Anthropic. A future M2.9.5 can translate between them.
- **Q4:** Should `embed()` route to `amazon.titan-embed-text-v2` when called via Bedrock?
  - _Current direction:_ Not in M2.9. M2.9.5 (Titan embeddings) lands separately. Today `embed()` rejects with a typed error suggesting OpenAI's `text-embedding-3-small` ($0.02/M).
- **Q5:** Should the streaming reader validate CRC32 fields?
  - _Current direction:_ No. See Alternatives. Could add it under a `{validateCrc: true}` constructor flag if a real corruption case ever shows up.
- **Q6:** Cross-region failover — should the router itself know about Bedrock regions, or should each region get its own `BedrockProvider` instance?
  - _Current direction:_ Each region = separate provider instance. The router's residency filter (`getTenantResidency`) selects the right one. Keeps the provider stateless per-region.
- **Q7:** Should sig v4 be extracted to `@crossengin/crypto`?
  - _Current direction:_ Not yet. Wait for the second AWS-talking package. Premature extraction without a real second consumer would freeze the API too early.
