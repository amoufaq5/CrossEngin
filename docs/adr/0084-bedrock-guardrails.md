# ADR-0084: Bedrock Guardrails integration (Phase 2 M2.9.8)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0071 (M2.9 Bedrock provider), ADR-0072 (M2.9.5 embeddings), ADR-0076 (M2.9.6 cache control), ADR-0077 (M2.9.7 multimodal embeddings), ADR-0078 (M2.X attachments + vision) |

## Context

M2.9 shipped the Bedrock chat provider with sig v4 signing + binary event-stream parsing. M2.9.5/.6/.7 added embeddings, cache-point threading, and multimodal block types. M2.X lifted attachments to the kernel and threaded vision through all three providers. What's still missing for production-grade safety: **content moderation**.

AWS Bedrock Guardrails is the service-side moderation surface. Operators define a guardrail (topic blocking, content policies, PII redaction, contextual grounding, word filters) in the AWS console and reference it from Bedrock requests via `guardrailIdentifier + guardrailVersion`. When the guardrail intervenes, the model response is either blocked outright (input intervention) or truncated mid-stream (output intervention), with `stopReason: "guardrail_intervened"` (or `"content_filtered"`) in the final messageStop event and optional trace details in the metadata event.

Pre-M2.9.8, the BedrockProvider silently dropped intervened responses on the floor — the chunk stream ended early, no error signal, no trace info. Cost accounting still flowed via `usage_final`, but the consumer had no way to distinguish "model produced clean output" from "guardrail blocked content." For regulated workloads (HIPAA, PCI, GDPR Article 22 automated decisions), that's not acceptable.

The design constraints:

- **Don't change the kernel `CompletionChunk` discriminated union.** Guardrail intervention is Bedrock-specific; surfacing it requires a Bedrock-specific error type, not a new kernel chunk kind.
- **Don't lose the usage_final chunk.** Cost accounting MUST still flow even when guardrails intervene — operators pay for the tokens that were processed, blocked or not. The thrown error needs to come AFTER usage_final yields.
- **Validate guardrail config at construction time.** Mistyped identifiers / versions should fail fast, not at first request.
- **Default to opt-in.** A provider constructed without `guardrailConfig` behaves byte-identically to M2.X — no field on the wire, no behavior change.

## Decision

Six coordinated changes to `@crossengin/ai-providers-bedrock`:

### 1. New `guardrails.ts` module

```ts
export const BEDROCK_GUARDRAIL_TRACE_MODES = ["enabled", "disabled"] as const;
export const BEDROCK_GUARDRAIL_INTERVENTION_STOP_REASONS = [
  "guardrail_intervened",
  "content_filtered",
] as const;
export const BEDROCK_GUARDRAIL_IDENTIFIER_PATTERN = /^[a-z0-9]{6,16}$/;
export const BEDROCK_GUARDRAIL_VERSION_PATTERN = /^(DRAFT|[1-9][0-9]{0,4})$/;

export interface BedrockGuardrailConfig {
  guardrailIdentifier: string;   // matches IDENTIFIER_PATTERN
  guardrailVersion: string;       // "DRAFT" or "1"-"99999"
  trace?: "enabled" | "disabled"; // default omitted
}

export function buildBedrockGuardrailConfig(input): BedrockGuardrailConfig;
export function isBedrockGuardrailIdentifier(value: string): boolean;
export function isBedrockGuardrailVersion(value: string): boolean;
export function isBedrockGuardrailInterventionStopReason(value: string): value is ...;
export function isGuardrailInterventionResponse(response: {stopReason: string}): boolean;

export interface BedrockGuardrailTrace {
  inputAssessment?: Record<string, BedrockGuardrailAssessment>;
  outputAssessments?: Record<string, readonly BedrockGuardrailAssessment[]>;
  modelOutput?: readonly string[];
}

export class BedrockGuardrailViolationError extends BedrockError {
  readonly stopReason: BedrockGuardrailInterventionStopReason;
  readonly trace: BedrockGuardrailTrace | null;
  // ... constructor sets BedrockError.kind = stopReason
}
```

`BedrockGuardrailViolationError` extends `BedrockError` so all consumers using `instanceof BedrockError` keep working. The `kind` field is set to the stopReason literal (`"guardrail_intervened"` or `"content_filtered"`), so callers using `error.kind` to discriminate get a precise tag.

### 2. Two new error kinds

`BEDROCK_ERROR_KINDS` grows by two: `"guardrail_intervened"`, `"content_filtered"`. Neither is in `RETRYABLE_KINDS` — guardrails are deterministic; retrying won't help. The router's `isRetryable()` check correctly bails out.

### 3. `BedrockConverseRequest.guardrailConfig?: BedrockGuardrailConfig`

The Bedrock Converse API accepts a top-level `guardrailConfig` field. `buildBedrockConverseRequest` now threads it through from `BuildConverseRequestOptions`:

```ts
const built = buildBedrockConverseRequest(req, {
  defaultMaxTokens: ...,
  guardrailConfig: this.guardrailConfig,  // when configured
});
```

When `BuildConverseRequestOptions.guardrailConfig` is undefined, the field is OMITTED from the request body (not emitted as null) — byte-identical to pre-M2.9.8 requests for backwards-compat.

### 4. Stream parser captures intervention state

`event-stream.ts`'s loop state grows from `Map<number, string>` (toolBlocks) to a `ConverseStreamState` object with three fields:

```ts
interface ConverseStreamState {
  toolBlocks: Map<number, string>;
  pendingIntervention: BedrockGuardrailInterventionStopReason | null;
  guardrailTrace: BedrockGuardrailTrace | null;
}
```

At `messageStop`, the parser inspects `stopReason`. If it matches an intervention reason, it sets `pendingIntervention` but does NOT throw — the `metadata` event has not arrived yet, so `usage_final` hasn't been yielded. At `metadata`, it pulls `trace.guardrail` if present and yields `usage_final` normally. After the read loop exits, if `pendingIntervention !== null`, it throws `BedrockGuardrailViolationError({stopReason, trace})`.

The ordering is critical:
1. text/tool chunks (if any)
2. usage_final chunk (cost accounting flows)
3. **end of stream**
4. BedrockGuardrailViolationError thrown

Consumers iterating with `for await` see partial chunks, then the error terminates the loop. The `usage_final` cost is in their hands before the throw.

### 5. `BedrockProviderOptions.guardrailConfig?`

```ts
const provider = new BedrockProvider({
  accessKeyId: "...",
  secretAccessKey: "...",
  guardrailConfig: {
    guardrailIdentifier: "gr12345",
    guardrailVersion: "DRAFT",
    trace: "enabled",
  },
});
```

Constructor validates via `buildBedrockGuardrailConfig()` — bad identifier/version/trace fails fast at provider construction. Stored internally as `private readonly guardrailConfig: BedrockGuardrailConfig | undefined`; threaded into both `complete()` (streaming) and `completeNonStreaming()` request builders.

### 6. Non-streaming responses

`completeNonStreaming` returns the raw `BedrockConverseResponse`, which already typed `stopReason` to include `"guardrail_intervened" | "content_filtered"` in M2.9. Callers inspect via `isGuardrailInterventionResponse(response)` and can drill into `response` directly for the partial output. The non-streaming path does NOT throw — consistent with M2.9's "return the response, let the caller decide" pattern. Streaming throws because there's no final structured envelope to inspect.

### Asymmetry: streaming throws, non-streaming returns

This is deliberate. Streaming consumers iterate chunk-by-chunk and have no chance to inspect a final "all done" envelope; throwing is the canonical way to signal "the model didn't finish normally." Non-streaming consumers have the full response in hand; making them check `stopReason` is fine.

## Cross-cutting invariants enforced

- **Validation at construction time.** Bad guardrailConfig fails before any request is sent.
- **`usage_final` always flows.** Even when guardrails intervene. Cost accounting is non-negotiable.
- **`BedrockGuardrailViolationError extends BedrockError`.** Consumer code using `instanceof BedrockError` keeps working; new code can narrow to `instanceof BedrockGuardrailViolationError` to access `.stopReason` + `.trace`.
- **`isRetryable() === false`.** Both new kinds are non-retryable. The router won't burn the budget retrying a guardrail-blocked request.
- **Byte-identical requests when `guardrailConfig` is unset.** Pre-M2.9.8 deployments see no change.
- **Slug-pattern parity with AWS.** The identifier regex matches AWS's documented format (`^[a-z0-9]+$`, 6-16 chars). The version regex matches `DRAFT` or up to 5-digit positive integers.
- **`completeNonStreaming` does NOT throw.** Asymmetric with streaming but consistent with the rest of the non-streaming API (returns raw response; caller inspects).

## End-to-end semantic

```ts
const provider = new BedrockProvider({
  accessKeyId: "...",
  secretAccessKey: "...",
  guardrailConfig: {
    guardrailIdentifier: "phi12345",
    guardrailVersion: "1",
    trace: "enabled",
  },
});

try {
  for await (const chunk of provider.complete(req)) {
    if (chunk.kind === "text") emitToken(chunk.text);
    if (chunk.kind === "usage_final") logCost(chunk.usage.cost);
  }
} catch (err) {
  if (err instanceof BedrockGuardrailViolationError) {
    // err.stopReason: "guardrail_intervened" | "content_filtered"
    // err.trace: structured trace if trace: "enabled", null otherwise
    auditViolation(err.stopReason, err.trace);
  } else {
    throw err;
  }
}
```

Non-streaming:
```ts
const res = await provider.completeNonStreaming(req);
if (isGuardrailInterventionResponse(res)) {
  auditViolation(res.stopReason, /* trace lives on response.trace.guardrail */ );
}
```

## Alternatives considered

- **Throw at messageStop, before usage_final.**
  - **Considered.** Simpler control flow; the intervention error reaches the consumer immediately.
  - **Cons.** Cost accounting is lost — the consumer never sees `usage_final` and operators can't bill the tokens that were processed up to intervention.
  - **Decision.** Throw at end-of-stream after usage_final.

- **Yield a special "intervention" CompletionChunk kind instead of throwing.**
  - **Considered.** Keeps the stream API uniform — no exceptions, just chunks.
  - **Cons.** Requires extending `CompletionChunk` (kernel-level union) with a Bedrock-specific kind. Other providers would have to accommodate it. Throwing is the standard JS pattern for "stream did not terminate normally."
  - **Decision.** Throw an error. The kernel's CompletionChunk stays provider-agnostic.

- **Don't validate guardrailConfig at construction; let AWS reject at request time.**
  - **Considered.** Simpler; AWS does its own validation.
  - **Cons.** Loses fast-fail behavior. A typo'd identifier silently waits until the first request to surface.
  - **Decision.** Validate at construction.

- **Make `BedrockGuardrailViolationError` a top-level error (not extend BedrockError).**
  - **Considered.** Clean inheritance hierarchy.
  - **Cons.** Existing consumer code uses `instanceof BedrockError` for broad catch-all. Breaking that compat would require coordinated updates across the router + chat substrate.
  - **Decision.** Extend BedrockError. `kind` field is the new discriminator; class hierarchy is the legacy compat.

- **Support multiple guardrails (array of guardrailConfigs).**
  - **Considered.** Layered moderation policies.
  - **Cons.** AWS doesn't support it today — one guardrail per request. Adding the wrapper for hypothetical future capability is premature.
  - **Decision.** Single guardrail per provider. If AWS expands the API later, this can be revisited.

- **Per-request guardrailConfig override (in `CompletionRequest`).**
  - **Considered.** Different requests need different guardrails — patient-facing chat vs. internal admin tools.
  - **Cons.** Requires extending the kernel `CompletionRequest` schema (cross-cutting change). Operators with mixed workloads can construct multiple providers (one per guardrail) and route via task policies.
  - **Decision.** Provider-level configuration. Per-request override is future M2.9.8.x if demand surfaces.

- **Auto-redact in JS rather than relying on Bedrock guardrails.**
  - **Considered.** Pre-process user input + post-process model output via regex / NLP.
  - **Cons.** Far less robust than AWS Bedrock Guardrails (which use ML-based content classification). Duplicates effort. The whole point of M2.9.8 is to lean on AWS's investment.
  - **Decision.** Server-side via Bedrock. Out of scope: local redaction.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,537 tests** (+32 from M2.9.8). All green, zero type errors.
- **Production-grade safety story closed for Bedrock.** Operators serving PHI / PCI / regulated workloads can now wire up guardrails and trust that violations are surfaced as typed errors with optional trace details.
- **Pattern set for future provider-specific safety integrations.** Anthropic has its own content filters; OpenAI has the Moderations API. Both can ship analogous opt-in flags + error types without changing the kernel's CompletionChunk surface.
- **Three compliance triangles strengthened.** Privacy: PII redaction via SensitiveInformationPolicy. Access control: workload-specific guardrails per task. Runtime safety: terminal failure mode for blocked content.
- **The router gets a non-retryable failure mode it didn't have before.** Previously, all Bedrock errors that weren't `authentication_error` / `invalid_request_error` / `not_found_error` / `permission_error` were either retryable or untyped. Now `guardrail_intervened` + `content_filtered` are explicit non-retryable terminations.

## Open questions

- **Q1:** Should the router log guardrail violations to a dedicated audit table?
  - _Current direction:_ Out of scope. Future M2.9.8.x could surface violation events via the M6 signal-bridge pattern.
- **Q2:** Should we expose `bedrock:listGuardrails` / `bedrock:createGuardrail` admin operations?
  - _Current direction:_ Out of scope. Operators manage guardrails via the AWS console / CLI / CDK; CrossEngin only consumes them.
- **Q3:** Should the JWT verifier wire guardrails to per-tenant policies?
  - _Current direction:_ Out of scope. Per-tenant guardrails require per-request override; that's M2.9.8.x.
- **Q4:** Should `extractGuardrailTraceFromConverseResponse` be a helper for the non-streaming path?
  - _Current direction:_ Probably yes; tracked as M2.9.8.x. The response shape isn't fully typed yet for the trace field.
- **Q5:** What about applyGuardrail (server-side input pre-check before model invocation)?
  - _Current direction:_ Out of scope. The AWS `ApplyGuardrail` API is a separate operation; current scope is in-line guardrails via `converse`/`converse-stream`.
- **Q6:** Should `BedrockGuardrailViolationError` carry the partial text that was emitted before intervention?
  - _Current direction:_ No — consumers already received it via the chunk stream. Duplicating it on the error would be redundant.
- **Q7:** Cross-provider abstraction: a kernel-level `ContentModerationError` that wraps Bedrock guardrails + Anthropic filters + OpenAI moderations?
  - _Current direction:_ Premature. Each provider's surface is different enough that a kernel abstraction would lose fidelity. Revisit after the second provider's moderation integration lands.
