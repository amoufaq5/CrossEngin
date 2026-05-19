# ADR-0087: Cross-provider moderation helper (Phase 2 M2.X.6.x)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0086 (M2.X.6 OpenAI + Anthropic moderation), ADR-0085 (M2.9.8.x per-request guardrail override), ADR-0084 (M2.9.8 Bedrock Guardrails) |

## Context

M2.9.8 (Bedrock Guardrails) + M2.X.6 (OpenAI + Anthropic moderation) shipped typed error classes for content moderation events across all three real LLM providers:

- `BedrockGuardrailViolationError` (kinds: `guardrail_intervened` | `content_filtered`)
- `OpenAIContentFilteredError` (kind: `content_filtered`)
- `AnthropicRefusalError` (kind: `refusal`)

Each class extends its provider's base error class. Each is non-retryable. Each surfaces post-`usage_final` in streaming mode so cost accounting flows.

ADR-0084 Q7 and ADR-0086 Q3 noted the missing abstraction: operators using the router (or any code that interacts with multiple providers) want a single discriminator that says "is this a moderation event?" without doing three `instanceof` checks. M2.X.6.x ships that helper.

Three design directions were viable:

1. **Marker interface.** Each error class implements `ContentModerationError { kind: string }`. Requires updating all three classes to declare the interface. Cross-package coupling.
2. **Shared kinds tuple + predicate.** Define the union of moderation kinds in `@crossengin/ai-providers` (the kernel package); ship a duck-typing predicate that inspects `err.kind` against the tuple. No changes to provider classes — they already have `.kind` of the right string values.
3. **Kernel base class.** A `ContentModerationError` in `@crossengin/ai-providers` that all three providers extend. Requires reshaping the inheritance hierarchy.

The simplest + least intrusive option is #2. All three provider error classes have `.kind` typed correctly post-M2.X.6; the kernel just needs to know the union of moderation kinds and offer a predicate that operates on the shared shape.

## Decision

One new module + one new predicate + index exports + tests.

### 1. New `moderation.ts` in `@crossengin/ai-providers`

```ts
export const MODERATION_ERROR_KINDS = [
  "guardrail_intervened",
  "content_filtered",
  "refusal",
] as const;
export type ModerationErrorKind = (typeof MODERATION_ERROR_KINDS)[number];

export interface ModerationDiscriminator {
  readonly kind: string;
}

export function isModerationErrorKind(value: string): value is ModerationErrorKind {
  return (MODERATION_ERROR_KINDS as readonly string[]).includes(value);
}

export function isModerationError(
  err: unknown,
): err is Error & { readonly kind: ModerationErrorKind } {
  if (err === null || typeof err !== "object") return false;
  const candidate = err as Record<string, unknown>;
  const kind = candidate["kind"];
  if (typeof kind !== "string") return false;
  return isModerationErrorKind(kind);
}
```

### 2. Cross-provider semantics

The kinds tuple is the union of what all three provider error classes' `kind` field can carry for moderation events:

| Provider | Class | `.kind` value(s) |
|---|---|---|
| Bedrock | `BedrockGuardrailViolationError` | `guardrail_intervened`, `content_filtered` |
| OpenAI | `OpenAIContentFilteredError` | `content_filtered` |
| Anthropic | `AnthropicRefusalError` | `refusal` |

The shared `content_filtered` between Bedrock + OpenAI is intentional — operators classifying logs by `error.kind === "content_filtered"` get matching coverage. The union has three distinct values: `guardrail_intervened`, `content_filtered`, `refusal`.

### 3. Duck-typing rationale

`isModerationError` doesn't require `instanceof` checks against three different classes from three different packages. It inspects `err.kind` and uses the shared tuple. This works because:

- All three provider error classes set `.kind` on construction.
- `.kind` is typed as a narrow string literal union per provider.
- The kernel's `MODERATION_ERROR_KINDS` is exactly the moderation slice of those unions.

Consumers using the kernel helper don't take a dependency on any specific provider package — they only need `@crossengin/ai-providers`. The router, which already depends on the kernel, picks up the helper for free.

### 4. Type narrowing

```ts
function handle(err: unknown) {
  if (isModerationError(err)) {
    // err is now Error & { readonly kind: "guardrail_intervened" | "content_filtered" | "refusal" }
    auditModeration(err.kind);
    return;
  }
  throw err;
}
```

Tested explicitly: a TS assignment to `"guardrail_intervened" | "content_filtered" | "refusal"` compiles inside the narrowed branch.

### 5. Index exports

`@crossengin/ai-providers/src/index.ts` re-exports the new `moderation.js` module. `MODERATION_ERROR_KINDS`, `ModerationErrorKind`, `isModerationErrorKind`, `isModerationError`, and `ModerationDiscriminator` are public.

### 6. Cross-package integration tests

Each provider's existing moderation test gets one additional case: instantiate the provider-specific error class, pass it to the kernel `isModerationError`, expect `true`. This verifies the duck-typing predicate works against the real classes (not just synthetic test objects).

## Cross-cutting invariants enforced

- **No changes to provider error classes.** `BedrockGuardrailViolationError`, `OpenAIContentFilteredError`, `AnthropicRefusalError` are byte-identical to M2.9.8 / M2.X.6.
- **No new kernel error types.** `isModerationError` is a predicate; no new class extends `Error` at the kernel layer.
- **`MODERATION_ERROR_KINDS` is the source of truth.** Adding a new moderation kind for a future provider means adding it here; downstream code automatically picks up the new kind via the predicate.
- **Robust against non-Error inputs.** `null`, `undefined`, primitives, and plain objects without a `kind` field all return `false`. Verified by test.
- **Type narrowing works as expected.** Inside the predicate's true branch, `err.kind` narrows to `ModerationErrorKind`. Verified by a TS assignment test that would fail to compile if narrowing were broken.

## End-to-end semantic

```ts
import { isModerationError } from "@crossengin/ai-providers";

try {
  for await (const chunk of router.complete(req)) {
    handleChunk(chunk);
  }
} catch (err) {
  if (isModerationError(err)) {
    // err.kind is "guardrail_intervened" | "content_filtered" | "refusal"
    auditViolation(err.kind);
    return;
  }
  throw err;
}
```

Works uniformly whether the router routed to Bedrock, OpenAI, or Anthropic. Operators using the router catch ONE error shape instead of three.

## Alternatives considered

- **Marker interface approach.**
  - **Considered.** Each provider class implements `ContentModerationError { kind: string }`.
  - **Cons.** Cross-package interface dependency (every provider package imports the kernel interface). Doesn't add value over duck typing because the implementations would only set the kind field (which they already do).
  - **Decision.** Duck typing. Same outcome, less coupling.

- **Kernel base class `ContentModerationError`.**
  - **Considered.** All three provider error classes extend a new `ContentModerationError extends Error` from `@crossengin/ai-providers`.
  - **Cons.** Reshapes the inheritance hierarchy. Each provider class would have to choose: extend `ContentModerationError` (loses `extends BedrockError` /  `extends OpenAIError` / `extends AnthropicError`) or use multiple inheritance (not supported in JS). Not worth the disruption.
  - **Decision.** Predicate over inheritance.

- **Use `Symbol.hasInstance` so `err instanceof ContentModerationError` works without inheritance.**
  - **Considered.** Clever; one global Symbol-based check.
  - **Cons.** Surprising. Most JS code reading `instanceof X` expects an inheritance chain. The custom `hasInstance` would mislead readers. `isModerationError(err)` is a clearer name + clearer behavior.
  - **Decision.** Function predicate. No `Symbol.hasInstance`.

- **Expose a TypeScript type guard against a discriminated union of all three error classes.**
  - **Considered.** `function isModerationError(err: unknown): err is BedrockGuardrailViolationError | OpenAIContentFilteredError | AnthropicRefusalError`.
  - **Cons.** The kernel would have to import all three provider packages, creating an awkward dependency direction (kernel → provider packages, when normally provider packages depend on the kernel). The narrower kind-based type guard is sufficient for downstream consumers.
  - **Decision.** Predicate narrows to the structural type, not the nominal classes.

- **Ship moderation kinds in a separate `@crossengin/ai-moderation` package.**
  - **Considered.** Separation of concerns.
  - **Cons.** Premature factoring. The moderation kinds are a small slice of the kernel's contract surface; a separate package adds workspace + import overhead. Revisit when the kernel surface grows significantly.
  - **Decision.** Keep in `@crossengin/ai-providers`.

- **Have `isModerationError` automatically log to a future audit channel.**
  - **Considered.** Predicate side-effects.
  - **Cons.** Predicates should be pure. Audit logging is a separate concern; future M5.x / M8 observability work would slot in alongside.
  - **Decision.** Pure predicate. Audit is the consumer's call.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,588 tests** (+21 from M2.X.6.x: 17 in ai-providers kernel + 4 cross-package integration). All green, zero type errors.
- **ADR-0084 Q7 + ADR-0086 Q3 closed.** Operators have a single catch site for moderation events across all three providers.
- **No churn on provider error classes.** Pre-M2.X.6.x consumer code using `instanceof BedrockGuardrailViolationError` / `OpenAIContentFilteredError` / `AnthropicRefusalError` continues to work. New code uses `isModerationError` for cross-provider parity.
- **Pattern set for future kernel-level cross-provider helpers.** Retryability classification could be lifted similarly (`isRetryableError(err)` checking shared retryable kinds). Token-limit detection (`isTokenLimitError`) likewise.
- **The router doesn't need to learn about moderation.** Catch-and-classify happens at the consumer (chat substrate, application code), not the router. The router just propagates errors.
- **Forward-compatible.** Adding a fourth provider with a novel moderation kind (e.g. Gemini's safety attributes) means appending to `MODERATION_ERROR_KINDS`. No consumer code change needed.

## Open questions

- **Q1:** Should `MODERATION_ERROR_KINDS` be exposed as a Set rather than a tuple for O(1) lookups?
  - _Current direction:_ The tuple has 3 entries; `Array.includes` is fine. If the tuple grows to 10+, revisit.
- **Q2:** Should the helper also accept a stop-reason / finish-reason string directly (`isModerationStopReason(reason: string)`)?
  - _Current direction:_ Each provider has its own already (`isGuardrailInterventionResponse`, `isContentFilteredResponse`, `isRefusalResponse`). Cross-provider stop-reason detection has no clear use case — operators inspect responses provider-specifically.
- **Q3:** Should we lift the `isRetryable()` method to a kernel-level `RETRYABLE_ERROR_KINDS` + `isRetryableError` predicate?
  - _Current direction:_ Each provider has its own `RETRYABLE_KINDS` set. They overlap but aren't identical. Future M2.X.7 could ship the lift if the overlap stabilizes.
- **Q4:** Should `isModerationError` also check `err instanceof Error`?
  - _Current direction:_ The return type already includes `Error &` but the runtime check only inspects `kind`. Operators throwing non-Error objects with a `kind` field would pass — that's intentional flexibility. Strict-mode operators add `err instanceof Error &&` before the predicate.
- **Q5:** A typed union of the three provider error class instances for stricter type narrowing?
  - _Current direction:_ Out of scope. Would require kernel → provider package dependencies. The structural type is sufficient.
- **Q6:** Documentation hook — auto-generate a "moderation surfaces" doc from the kinds tuple?
  - _Current direction:_ Out of scope. ADR-0086 + ADR-0087 + each provider's module-level docs are sufficient.
