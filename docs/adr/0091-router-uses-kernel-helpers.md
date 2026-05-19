# ADR-0091: Router uses kernel cross-provider helpers (Phase 2 M6.6)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0090 (M2.X.7 retryable helper), ADR-0087 (M2.X.6.x moderation helper), ADR-0088 (M2.X.5 content union), ADR-0059 (M6.5 ai-router) |

## Context

M2.X.6.x shipped `isModerationError` and M2.X.7 shipped `isRetryableError` — kernel-level cross-provider predicates that classify errors by `.kind` against shared tuples. Both pass their cross-package integration tests against all three real provider error classes.

The `ai-router` package's retry logic predates these helpers. It carries its own duck-typed `isRetryableError` that checks for an `isRetryable()` method on the error. This works for the three real provider classes (they all implement the method) but doesn't take advantage of the kernel's structural classification.

Three concrete problems to fix in this cleanup pass:

1. **Router's `isRetryableError` is a parallel implementation of the kernel helper.** Operators inspecting the router code see a competing classifier instead of the one source of truth.

2. **Router's `isRouterRetryable` doesn't explicitly handle moderation errors.** Today moderation errors fall through to `isRetryableError(err)` which returns `false` because the provider's `isRetryable()` method returns `false` for moderation kinds. Correct outcome, accidental code path. An explicit `isModerationError(err)` check documents intent and decouples the router from the provider's `isRetryable()` implementation.

3. **`estimateRequestTokens` is BROKEN post-M2.X.5.** It does `chars += m.content.length` — for `LlmContentBlock[]` content, `.length` returns the block count, not the character count. A user message with `[{type: "text", text: "long text"}, {type: "image", ...}]` would estimate as 2 characters → 1 token, hugely underestimating the cost.

M6.6 is a focused cleanup pass addressing all three.

## Decision

Three coordinated changes to `@crossengin/ai-router`, plus tests.

### 1. retry.ts: hybrid predicate using both kernel + method shapes

```ts
import { isRetryableError as isKernelRetryableError } from "@crossengin/ai-providers";

export function isRetryableError(err: unknown): boolean {
  if (isKernelRetryableError(err)) return true;
  if (
    err !== null &&
    typeof err === "object" &&
    typeof (err as { isRetryable?: unknown }).isRetryable === "function"
  ) {
    return (err as RetryableErrorMethod).isRetryable();
  }
  return false;
}
```

The router's `isRetryableError` now accepts BOTH shapes:

- Kernel `.kind` shape — any error with a `kind` matching `RETRYABLE_ERROR_KINDS` (the canonical post-M2.X.7 path).
- Legacy method shape — any object with an `isRetryable(): boolean` method returning true (backwards-compat with the previous behavior).

Provider errors satisfy both (they have `.kind` AND `isRetryable()`); custom callers using either pattern keep working. The `RetryableError` interface rename (to `RetryableErrorMethod`) clarifies its scope.

### 2. router.ts: explicit moderation early-exit

`isRouterRetryable` gains an explicit `isModerationError(err)` check before delegating to `isRetryableError`:

```ts
function isRouterRetryable(err: unknown): boolean {
  if (err instanceof CostCeilingExceededError) return false;
  if (err instanceof ProviderResolutionError) return false;
  if (err instanceof AllProvidersExhaustedError) return false;
  if (isModerationError(err)) return false;       // explicit terminal
  return isRetryableError(err);
}
```

Documented intent: moderation events are terminal, never trigger fallback to alternate providers (switching providers won't help — the input itself triggered the policy violation). Operators reading the router code see why moderation errors are special-cased.

### 3. router.ts: `estimateRequestTokens` uses `contentToText`

```ts
import { contentToText, isModerationError } from "@crossengin/ai-providers";

function estimateRequestTokens(req: CompletionRequest): number {
  let chars = 0;
  for (const m of req.messages) chars += contentToText(m.content).length;
  return Math.max(1, Math.ceil(chars / 4));
}
```

`contentToText` (from M2.X.5) handles both `string` and `LlmContentBlock[]` shapes, extracting text from text blocks and ignoring image / tool_use / tool_result blocks. The pre-M6.6 bug — `m.content.length` returning block count for arrays — is fixed.

The estimate is a best-effort pre-flight number used for cost-ceiling checking. Images don't contribute to text-token estimates (they're typically charged separately). Tool-use / tool-result blocks are extracted as text where they have text content (none today — they're not text variants — so they're correctly ignored).

## Cross-cutting invariants enforced

- **Provider error classes are unchanged.** All `instanceof <ProviderError> && err.isRetryable()` consumer code keeps working.
- **Router behavior unchanged for retryable + non-retryable cases.** Pre-M6.6 test suite (51 router tests) passes at 51 unchanged.
- **Moderation errors are terminal in the router** — explicit. Verified by 2 new tests (refusal + guardrail_intervened both NOT triggering fallback).
- **Retryable errors still flow to fallback.** Verified by test (rate_limit_error continues to fail over).
- **Array content estimation works.** Verified by test (rich content with image block doesn't break cost-ceiling preflight).
- **Kernel `isRetryableError` is the canonical classifier.** Router's local helper delegates to it first; method-based fallback is a compat layer.

## End-to-end semantic

```ts
// Pre-M6.6: router catches all errors, calls err.isRetryable() if present.
// Moderation errors flow through this path because BedrockGuardrailViolationError
// has isRetryable() returning false (via the provider's RETRYABLE_KINDS check).
// Correct outcome, accidental path.

// Post-M6.6: router catches errors, checks isModerationError FIRST,
// then delegates to isRetryableError (kernel + method).
try {
  for await (const chunk of router.complete(req)) { ... }
} catch (err) {
  // From the router's perspective:
  // - CostCeilingExceeded / ProviderResolution / AllProvidersExhausted → terminal
  // - Moderation (BedrockGuardrailViolation, OpenAIContentFiltered, AnthropicRefusal) → terminal
  // - Retryable (rate_limit_error etc.) → tried with backoff, then fall over to fallback
  // - Other → terminal
}
```

## Alternatives considered

- **Remove the legacy method-based predicate entirely.**
  - **Considered.** Simpler code; kernel `.kind`-based check only.
  - **Cons.** Existing retry tests use synthetic classes with `isRetryable()` methods but no `.kind` fields. Removing the method-based path means updating tests + breaking any external consumer using the duck-typed shape.
  - **Decision.** Hybrid. Kernel first, method fallback. Tests + external consumers unaffected.

- **Remove the local `isRetryableError` and re-export the kernel one.**
  - **Considered.** Eliminates the parallel implementation entirely.
  - **Cons.** Loses backwards compat with method-based consumer code that doesn't carry `.kind`.
  - **Decision.** Hybrid approach above.

- **Move the moderation check to `withRetry` in retry.ts.**
  - **Considered.** Then the retry layer itself short-circuits on moderation.
  - **Cons.** `withRetry` is a general-purpose retry combinator; it shouldn't know about moderation. The router's `isRouterRetryable` is the right layer for moderation-specific routing decisions.
  - **Decision.** Keep moderation check in `isRouterRetryable`.

- **Have the router count moderation events as a separate metric.**
  - **Considered.** Useful for observability.
  - **Cons.** Out of scope. The router records latency + cost; adding error-classification metrics is M8 observability work.
  - **Decision.** Just classify + don't retry. Metrics later.

- **`estimateRequestTokens` should fully tokenize, not just count chars.**
  - **Considered.** Real token counts via a tokenizer library.
  - **Cons.** Major scope creep — tokenizer libraries are model-specific + add 100s of KB. The char/4 heuristic is good enough for preflight + matches what the providers do for their own estimates.
  - **Decision.** Keep char-based heuristic; just fix the array-content bug.

- **Include image-block byte count in the token estimate.**
  - **Considered.** Images contribute to provider billing (vision tokens).
  - **Cons.** Each provider charges differently per image (some by tile count, some by megapixel, some flat). Modeling that cross-provider is out of scope.
  - **Decision.** Text-only estimate. Image cost is reconciled in `usage_final` after the call.

- **Have `isRouterRetryable` use `instanceof BedrockGuardrailViolationError | ...` instead of `isModerationError`.**
  - **Considered.** Explicit nominal types.
  - **Cons.** Defeats the kernel abstraction. The router would have to import all three provider packages. The whole point of M2.X.6.x's helper is that the router doesn't need provider imports.
  - **Decision.** Use `isModerationError`. Provider-package-free.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,677 tests** (+9 from M6.6: 6 retry + 3 router). All green, zero type errors.
- **Kernel helpers now have a non-test consumer.** `isModerationError` + `isRetryableError` are exercised in real router code. M2.X.6.x + M2.X.7 are validated end-to-end.
- **`estimateRequestTokens` bug fixed.** Array content (M2.X.5+) no longer hugely underestimates token counts.
- **Moderation routing is documented + tested.** Pre-M6.6 the correct behavior was accidental; post-M6.6 it's explicit + verified.
- **Pattern set for future cross-provider classifiers.** When a third helper ships (e.g. `isInputTooLargeError`), the same migration shape applies — add the explicit early-exit in `isRouterRetryable`.
- **Hybrid predicate is the migration template.** Other workspaces that ship their own retryable predicates can adopt the same "kernel first, local fallback" shape.

## Open questions

- **Q1:** Should the router emit a `RouterAttempt` entry for moderation errors with a special `errorKind: "moderation"` marker?
  - _Current direction:_ The current `errorKind(err)` returns the literal `.kind` value (`refusal`, `content_filtered`, `guardrail_intervened`). Downstream observability layers can classify via the same kernel helpers.
- **Q2:** Should the legacy method-based `isRetryable()` path be deprecated?
  - _Current direction:_ Not yet. Mark as legacy in retry.ts docs; deprecate when the chat substrate + tests migrate to `.kind`-only.
- **Q3:** Should `estimateRequestTokens` also include the system prompt + tool schemas?
  - _Current direction:_ Out of scope. System messages already flow through `req.messages` and are counted. Tool schemas are not — they're a constant overhead that doesn't vary per call. Future M6.7 could add them.
- **Q4:** Cost-ceiling check timing: should moderation errors count toward the per-tenant rolling-window cost?
  - _Current direction:_ Moderation errors emit `usage_final` before throwing (per M2.9.8/M2.X.6 design); the existing `recordUsage` path captures the cost. Operators see moderation-blocked spend as real spend (which it is — the model processed the tokens before the block).
- **Q5:** Should the router emit a structured observability event when moderation triggers?
  - _Current direction:_ Out of scope. Future M8 observability hook can subscribe to a `router.events` channel.
- **Q6:** What about partial-stream moderation: text was emitted before the moderation event fired — should the router yield those chunks to the consumer before throwing?
  - _Current direction:_ The provider's streaming generator already yields text chunks first + throws at `usage_final` (per M2.9.8 / M2.X.6 design). The router relays them transparently. The consumer sees the partial text + then catches the moderation error.
- **Q7:** A `RouterEvent` discriminated union for typed event consumption (start / chunk / error / complete / moderation_blocked)?
  - _Current direction:_ Out of scope. The current chunk-stream + thrown-error pattern is the API. Future M8 could ship a separate event bus.
