# ADR-0092: Standalone OpenAI Moderations API (Phase 2 M2.X.8)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0086 (M2.X.6 OpenAI + Anthropic moderation), ADR-0084 (M2.9.8 Bedrock Guardrails), ADR-0060 (M2.8 OpenAI provider) |

## Context

M2.X.6 added in-band content-filter detection on OpenAI chat completions — when `finish_reason === "content_filter"`, the provider throws `OpenAIContentFilteredError`. That's reactive: the model has already attempted to respond and the filter blocked or truncated the output. The tokens are billed; the call ran.

ADR-0086 Q1 noted the proactive surface OpenAI offers: the standalone `POST /v1/moderations` endpoint. Operators send input separately, get back a structured classification (11 category booleans + 11 floating-point scores), and decide BEFORE running a chat completion whether to proceed. Use cases:

- **Pre-screen user input.** Before paying for a $0.01 GPT-4 turn, run a $0.0001 moderation check; refuse obviously-violating inputs without burning the model call.
- **Bulk content audits.** Classify a batch of historical messages for compliance review.
- **Multi-channel risk scoring.** Even if the chat itself doesn't trigger a filter, the moderation scores can drive downstream decisions (escalate to human review, log to compliance audit, etc.).

M2.X.8 ships `provider.moderate(input)` calling `/v1/moderations`. Closes ADR-0086 Q1.

## Decision

Three coordinated changes to `@crossengin/ai-providers-openai`.

### 1. New `moderations-api.ts` module

Types + helpers, all data-only (no fetch):

```ts
export const OPENAI_MODERATION_MODELS = [
  "omni-moderation-latest",
  "omni-moderation-2024-09-26",
  "text-moderation-latest",
  "text-moderation-stable",
] as const;
export type OpenAIModerationModel = (typeof OPENAI_MODERATION_MODELS)[number];

export const OPENAI_DEFAULT_MODERATION_MODEL = "omni-moderation-latest";

export const OPENAI_MODERATION_CATEGORY_KEYS = [
  "sexual", "hate", "harassment", "self-harm",
  "sexual/minors", "hate/threatening", "violence/graphic",
  "self-harm/intent", "self-harm/instructions",
  "harassment/threatening", "violence",
] as const;
export type OpenAIModerationCategoryKey =
  (typeof OPENAI_MODERATION_CATEGORY_KEYS)[number];
```

11 categories — the canonical OpenAI documented set. Four models — the current omni-moderation (multimodal-capable, default) + the legacy text-moderation pair for backwards compat.

Three helpers:

- `buildModerationRequest({input, model?, defaultModel})` — input is `string | readonly string[]`; rejects empty string / empty array / array with empty entries at build time (fast-fail before fetch).
- `normalizeModerationResponse(response)` — folds the raw `OpenAIModerationResponse` into a `NormalizedModerationOutcome`: `{model, anyFlagged, results, flaggedCategoriesPerResult}`. The latter is a `OpenAIModerationCategoryKey[][]` — one array per result with the categories whose `categories[k] === true`.
- `highestCategoryScore(result)` — returns `{category, score}` of the highest-scoring category, or `null` if no numeric scores present. Operators using soft thresholds (e.g. "flag at score > 0.7 even if `flagged === false`") use this.

### 2. `OpenAIProvider.moderate(input)`

```ts
async moderate(input: {
  readonly input: string | readonly string[];
  readonly model?: OpenAIModerationModel;
}): Promise<NormalizedModerationOutcome>;
```

Signature mirrors `embed`'s shape (object arg + optional model override). The model resolves via `resolveModerationModel` (similar to `resolveChatModel` / `resolveEmbeddingModel`) — undefined uses `defaultModerationModel`; unknown model throws `OpenAIError({kind: "invalid_request_error"})`.

POSTs to `/v1/moderations` with the existing `headers({stream: false})` + handles network / HTTP / JSON-parse errors via `fromNetworkError` / `fromHttpResponse` / `OpenAIError` — same pattern as the other endpoints.

### 3. `OpenAIProviderOptions.defaultModerationModel?`

Constructor accepts the default moderation model (omni-moderation-latest by default). Validated at construction via `isOpenAIModerationModel`; unsupported → throws.

```ts
new OpenAIProvider({
  apiKey: "sk-...",
  defaultModerationModel: "text-moderation-stable",  // optional override
});
```

### Output shape: `NormalizedModerationOutcome`

```ts
interface NormalizedModerationOutcome {
  readonly model: string;
  readonly anyFlagged: boolean;
  readonly results: readonly OpenAIModerationResult[];
  readonly flaggedCategoriesPerResult:
    ReadonlyArray<readonly OpenAIModerationCategoryKey[]>;
}
```

- `model` — echoes the response model (different from request if API auto-versions).
- `anyFlagged` — `true` if any result is flagged. The common-case decision flag.
- `results` — verbatim raw results, for operators who need the full category booleans + scores.
- `flaggedCategoriesPerResult` — per-result list of category keys whose boolean was `true`. Useful for audit logging without iterating the categories object.

## Cross-cutting invariants enforced

- **Input validation at build time.** Empty string / empty array / array-with-empty-string all throw before fetch. Verified by test.
- **Model validation at construction + at call time.** Unsupported model throws synchronously. Verified by test.
- **Same error-handling pattern as other endpoints.** Network → `fromNetworkError`; HTTP non-2xx → `fromHttpResponse`; JSON parse → `OpenAIError({kind: "api_error"})`.
- **The HTTP error path correctly maps to retryable kinds.** Verified by test: a 429 response surfaces as `OpenAIError` with `kind === "rate_limit_error"`.
- **Kernel `isRetryableError` agrees on moderation errors.** Same path as chat / embed — moderation errors with `kind in RETRYABLE_ERROR_KINDS` are classified retryable by the kernel helper.
- **Default model is omni-moderation-latest.** Current OpenAI recommendation; multimodal-capable, supersedes the legacy text-moderation models.

## End-to-end semantic

```ts
const provider = new OpenAIProvider({ apiKey: "sk-..." });

// Pre-flight check before paying for a chat call:
const outcome = await provider.moderate({ input: userMessage });
if (outcome.anyFlagged) {
  auditViolation(outcome.flaggedCategoriesPerResult[0]);
  return refuseUserPolicy();
}

// Batch audit of historical messages:
const batch = await provider.moderate({
  input: messages.map((m) => m.content),
});
for (let i = 0; i < batch.results.length; i++) {
  if (batch.results[i].flagged) {
    flagHistoricalMessage(messages[i].id);
  }
}

// Soft-threshold check (custom risk policy):
const single = await provider.moderate({ input: userMessage });
const top = highestCategoryScore(single.results[0]);
if (top !== null && top.score > 0.7) {
  escalateToHumanReview({ category: top.category, score: top.score });
}
```

## Alternatives considered

- **Add `moderate` to the kernel `LlmProvider` interface.**
  - **Considered.** Cross-provider abstraction — every provider implements `moderate`.
  - **Cons.** Anthropic + Bedrock don't expose a standalone moderation endpoint. Forcing the interface would mean throwing `not_supported` on those — vestigial.
  - **Decision.** Provider-specific method on `OpenAIProvider`. Future Anthropic / Bedrock standalone-moderation surfaces (if shipped) get their own methods.

- **Return raw `OpenAIModerationResponse` from `moderate`, no normalization.**
  - **Considered.** Pass-through; operators inspect raw fields.
  - **Cons.** Forces every consumer to walk the 11 categories themselves. `anyFlagged` + `flaggedCategoriesPerResult` are universal needs.
  - **Decision.** Return `NormalizedModerationOutcome` with raw results preserved as a sub-field.

- **Auto-call `moderate` before every `complete()`.**
  - **Considered.** Defense-in-depth — every chat is pre-screened.
  - **Cons.** Doubles the latency + cost. Operators decide when pre-screening is worth it (regulated tenants, anonymous endpoints, high-risk content).
  - **Decision.** Manual call. Operators wire `moderate` into their flow.

- **Default to legacy `text-moderation-latest` model.**
  - **Considered.** Lower cost; widely supported.
  - **Cons.** OpenAI has deprecated the text-moderation family in favor of omni-moderation. Defaulting to deprecated models invites future breakage.
  - **Decision.** `omni-moderation-latest` default. Operators with cost constraints opt into text-moderation explicitly.

- **Accept structured content blocks (multimodal moderation) for omni-moderation models.**
  - **Considered.** Omni-moderation supports image inputs.
  - **Cons.** Adds API surface complexity (string vs array vs content-parts). The minimum viable surface is text-only. Future M2.X.8.x can add multimodal support.
  - **Decision.** Text-only input today (string or string[]). Multimodal deferred.

- **Cache moderation results in-memory by input hash.**
  - **Considered.** Same input twice = one call.
  - **Cons.** Caching policy belongs in the operator's layer, not the provider. Different tenants have different cache requirements.
  - **Decision.** No caching. Operators add their own.

- **Throw on `flagged === true` instead of returning a result.**
  - **Considered.** Forces operators to handle violations via catch handlers.
  - **Cons.** Often operators WANT to inspect flagged content (log, escalate, score). Throwing would require try/catch + re-parsing the error to access the categories. Returning the outcome is more flexible.
  - **Decision.** Return outcome. Operators decide whether flagged means refuse / log / continue.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,706 tests** (+29 from M2.X.8: 20 module + 9 provider integration). All green, zero type errors.
- **ADR-0086 Q1 closed.** OpenAI provider now exposes both reactive (in-band finish_reason detection) AND proactive (standalone Moderations API) safety surfaces.
- **Pattern for future standalone-moderation surfaces.** If Anthropic or Bedrock ships a similar endpoint, the same shape applies: provider-specific method + types module + normalized outcome.
- **Operators can pre-screen at low cost.** $0.0001 per moderation call vs $0.005+ per chat completion; pre-flight check is economically viable for high-volume endpoints.
- **NormalizedModerationOutcome is a stable contract.** The `anyFlagged` + `flaggedCategoriesPerResult` shape is the operator-facing layer; raw results stay available for advanced use.
- **No kernel changes.** `LlmProvider` interface is unchanged; cross-provider abstraction (if it ever ships) is M2.X.8.x territory.

## Open questions

- **Q1:** Should the chat substrate auto-pre-screen with `moderate` for specific tasks (e.g., `task: "executor"`)?
  - _Current direction:_ Out of scope. Operators wire this into their chat substrate per-tenant policy. Future M5.x could add a `preflightModerator` hook.
- **Q2:** Multimodal moderation (image inputs to omni-moderation)?
  - _Current direction:_ Deferred to M2.X.8.x. Need a clear use case + the structured-content-parts API shape.
- **Q3:** Should `moderate` cost be tracked in the cost-tracker the same way embed + complete are?
  - _Current direction:_ The Moderations API is currently free / extremely cheap. Cost tracking adds operational overhead for negligible billing impact. Defer until OpenAI starts charging meaningfully.
- **Q4:** A category-threshold helper `wouldFlag(result, thresholds: Partial<OpenAIModerationCategoryScores>): boolean`?
  - _Current direction:_ Operators write their own threshold predicates against `result.category_scores`. The function is 3 lines; not worth shipping.
- **Q5:** What about Anthropic's claimed message-classification capabilities?
  - _Current direction:_ Anthropic doesn't expose a standalone Moderations endpoint today. If one ships, follow the same shape in `@crossengin/ai-providers-anthropic`.
- **Q6:** Should `OpenAIContentFilteredError` (from M2.X.6) carry a `moderation` field for cross-referencing a pre-screen result?
  - _Current direction:_ Out of scope. The two surfaces are independent — pre-screen runs before chat; chat's content_filter is post-hoc. Cross-referencing is an operator-side concern.
- **Q7:** Per-tenant default moderation model (different tenants might want different strictness)?
  - _Current direction:_ Out of scope. Multiple `OpenAIProvider` instances handle this today; per-call `model` override handles per-request needs.
