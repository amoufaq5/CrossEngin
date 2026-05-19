# ADR-0095: Cross-provider input-too-large helper (Phase 2 M2.X.9)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0090 (M2.X.7 retryable helper), ADR-0087 (M2.X.6.x moderation helper), ADR-0091 (M6.6 router uses kernel helpers) |

## Context

M2.X.6.x shipped `isModerationError` (terminal moderation events). M2.X.7 shipped `isRetryableError` (recoverable transient failures). The third cross-cutting error category that operators handle distinctly is **input-too-large** — errors that signal the request exceeded a size or token limit. These are:

- Not retryable (the request itself is too big; retrying the same request fails again)
- Not moderation events (no policy violation; just a quantitative limit)
- Actionable in a specific way: reduce the input (truncate history, shorten prompts, split into multiple calls)

All three real providers map HTTP 413 to `kind: "request_too_large"` via their `classifyHttpStatus` functions. The kind is uniformly emitted; the kernel just needs to expose a discriminator.

This is the third helper in the M2.X.6.x / M2.X.7 family, matching the same duck-typing-on-`.kind` shape.

## Decision

One new module + one new predicate + index exports + tests.

### 1. New `input-too-large.ts` in `@crossengin/ai-providers`

```ts
export const INPUT_TOO_LARGE_ERROR_KINDS = [
  "request_too_large",
] as const;
export type InputTooLargeErrorKind = (typeof INPUT_TOO_LARGE_ERROR_KINDS)[number];

export interface InputTooLargeDiscriminator {
  readonly kind: string;
}

export function isInputTooLargeErrorKind(value: string): value is InputTooLargeErrorKind {
  return (INPUT_TOO_LARGE_ERROR_KINDS as readonly string[]).includes(value);
}

export function isInputTooLargeError(
  err: unknown,
): err is Error & { readonly kind: InputTooLargeErrorKind } {
  if (err === null || typeof err !== "object") return false;
  const candidate = err as Record<string, unknown>;
  const kind = candidate["kind"];
  if (typeof kind !== "string") return false;
  return isInputTooLargeErrorKind(kind);
}
```

Identical shape to `isModerationError` + `isRetryableError`. Same robustness against non-Error inputs. Same TS type narrowing inside the true branch.

### 2. Single-kind tuple today

The tuple has one entry: `"request_too_large"`. Future expansions:

- A provider that emits a distinct `"context_length_exceeded"` kind (not via the `.code` field but at the `.kind` level) would append.
- A provider that emits `"token_limit_exceeded"` would append.

Right now, all three providers' HTTP 413 paths map to `"request_too_large"`, so the union is a singleton.

### 3. Index exports

`@crossengin/ai-providers/src/index.ts` re-exports the new `input-too-large.js` module alongside `moderation.js` + `retryable.js`. All four exports are public: `INPUT_TOO_LARGE_ERROR_KINDS`, `InputTooLargeErrorKind`, `isInputTooLargeErrorKind`, `isInputTooLargeError`, `InputTooLargeDiscriminator`.

### 4. Cross-package integration tests

Each provider's `errors.test.ts` gets a small block:
- Construct `<Provider>Error({kind: "request_too_large"})`.
- Assert `isInputTooLargeError(err) === true`.
- Assert `err.isRetryable() === false` (cross-checks that retryable + input-too-large are mutually exclusive).
- Assert `isInputTooLargeError(<other-kind>) === false` (rate_limit, content_filtered/refusal/guardrail_intervened).

### Symmetric API surface

Operators catching errors across providers now have THREE parallel discriminators:

```ts
import { isModerationError, isRetryableError, isInputTooLargeError } from "@crossengin/ai-providers";

try {
  await router.complete(req);
} catch (err) {
  if (isModerationError(err)) return auditViolation(err.kind);
  if (isInputTooLargeError(err)) return splitAndRetry(err);
  if (isRetryableError(err)) return scheduleRetry(err);
  throw err;
}
```

Each predicate narrows `err.kind` to its respective tuple's union. None require provider-package imports.

### Mutual exclusivity

`request_too_large` is NOT in `RETRYABLE_ERROR_KINDS` (M2.X.7) or `MODERATION_ERROR_KINDS` (M2.X.6.x). The three sets partition the error space:

- **Retryable** (`rate_limit_error`, `network_error`, `timeout_error`, `api_error`, `overloaded_error`, `model_stream_error`): try again with backoff.
- **Moderation** (`guardrail_intervened`, `content_filtered`, `refusal`): terminal; audit the violation.
- **Input-too-large** (`request_too_large`): terminal; reduce the request size.
- **Other** (auth, permission, not_found, invalid_request, unknown): terminal; surface to the user / operator.

The partitioning is verified by tests — each predicate returns `false` for kinds in the other two categories.

## Cross-cutting invariants enforced

- **All three providers emit `kind: "request_too_large"` for HTTP 413.** Verified by cross-package tests.
- **Input-too-large is non-retryable.** Each provider's `RETRYABLE_KINDS` excludes it; the kernel `isRetryableError` returns false.
- **Input-too-large is not a moderation event.** `isModerationError` returns false.
- **Predicate is robust against non-Error inputs.** null / undefined / primitives / objects without `kind` / non-string `kind` all return false.
- **Type narrowing works.** Inside the predicate's true branch, `err.kind` narrows to `"request_too_large"` (a 1-member union today).
- **No changes to provider error classes.** Pre-M2.X.9 code using `instanceof <ProviderError>` + `err.kind === "request_too_large"` continues to work.

## End-to-end semantics

```ts
import { isInputTooLargeError } from "@crossengin/ai-providers";

async function callWithTruncation<T>(
  fn: (msgs: LlmMessage[]) => Promise<T>,
  msgs: LlmMessage[],
): Promise<T> {
  try {
    return await fn(msgs);
  } catch (err) {
    if (isInputTooLargeError(err)) {
      // Drop the oldest non-system turn + retry (one shot)
      const truncated = truncateOldestNonSystem(msgs);
      return await fn(truncated);
    }
    throw err;
  }
}
```

Works uniformly across Bedrock, OpenAI, and Anthropic. Operators implementing automatic truncation, message splitting, or fallback-to-smaller-context-model strategies use this predicate without provider imports.

## Alternatives considered

- **Include OpenAI's `context_length_exceeded` error code in the tuple.**
  - **Considered.** OpenAI returns `kind: "invalid_request_error"` + `code: "context_length_exceeded"` for context-window overflows that AREN'T HTTP 413.
  - **Cons.** The kernel duck-types on `.kind`, not `.code`. Operators wanting code-level detection write their own predicate. Adding the code path here would set a precedent for arbitrary code-based inspection.
  - **Decision.** Kind-only. Code-level discrimination is operator territory.

- **Merge with the retryable / moderation helpers into `classifyError(err): "moderation" | "retryable" | "input_too_large" | "terminal"`.**
  - **Considered.** Single classifier function.
  - **Cons.** Same rejection as M2.X.7 — three separate predicates compose better with early-return. The classifier could be a thin convenience wrapper later if call sites get noisy.
  - **Decision.** Three predicates. Add a wrapper if needed.

- **Singleton tuple is overkill — just export the constant + predicate.**
  - **Considered.** `export const REQUEST_TOO_LARGE = "request_too_large"; export function isRequestTooLargeError(err) {...}`.
  - **Cons.** Loses the extension shape. If a future provider emits a distinct kind, the tuple grows without breaking the signature. The 1-member tuple is forward-compatible.
  - **Decision.** Tuple + predicate.

- **Include router-side helpers** (e.g., `truncateForRetry(msgs, err): LlmMessage[]`).
  - **Considered.** Move the operator's truncation logic into the kernel.
  - **Cons.** Truncation policy is application-specific — operators might want to drop oldest, drop largest, summarize old turns, switch to a larger-context model, or refuse. The kernel just classifies; the operator decides.
  - **Decision.** Classifier only.

- **Expose a kernel-level `isTerminalError(err)` = `!isRetryableError(err)`.**
  - **Considered.** Convenience for catch handlers.
  - **Cons.** Encourages "any error I don't recognize is terminal" patterns that miss future kinds. Operators are better off explicitly partitioning known kinds.
  - **Decision.** Out of scope.

- **Ship in a separate `@crossengin/ai-errors` package alongside the other helpers.**
  - **Considered.** Same as M2.X.7's rejection — premature factoring.
  - **Decision.** Keep in `@crossengin/ai-providers`.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,750 tests** (+24 from M2.X.9: 18 kernel + 6 cross-package integration). All green, zero type errors.
- **Three-helper kernel surface.** `isModerationError` + `isRetryableError` + `isInputTooLargeError` cover the three big cross-cutting error categories.
- **Error space is partitioned.** Operators can classify any provider error into retryable / moderation / input-too-large / other with kernel-only helpers.
- **Router or chat substrate could add automatic truncation.** With the kernel classifier in place, a future M6.7 could ship router-side `onInputTooLarge` hooks; operators provide truncation policies.
- **Pattern continues to scale.** Adding a fourth kind (e.g., `"safety_filter"` if a provider ships one distinct from `content_filtered`) is an additive tuple expansion.
- **No provider-side changes needed today.** All three providers already map HTTP 413 to `request_too_large`. Future providers must do the same to be classified correctly.

## Open questions

- **Q1:** Should the kernel ship a higher-level `classifyError(err): "moderation" | "retryable" | "input_too_large" | "terminal"` wrapper?
  - _Current direction:_ Defer. Operators wanting it write a 5-line helper. Add to the kernel if multiple consumers ask.
- **Q2:** Should the helper inspect `.code` for OpenAI's `context_length_exceeded` even when `.kind === "invalid_request_error"`?
  - _Current direction:_ No. Kernel duck-types on `.kind` for consistency. Operators wanting code-level detection write a per-provider predicate.
- **Q3:** Should the router automatically truncate + retry on input-too-large?
  - _Current direction:_ Out of scope. Truncation policy is application-specific. Future M6.7 could add a configurable hook.
- **Q4:** A "soft-limit" predicate that triggers BEFORE the request is sent (based on `estimateRequestTokens`)?
  - _Current direction:_ Different concern — pre-flight estimation vs post-failure classification. Pre-flight checks live in `ai-router/router.ts`'s cost estimation; expanding to context-window estimation is a future M6.7.
- **Q5:** What about `embedding`-specific input-too-large (embed has its own input limits)?
  - _Current direction:_ Same `request_too_large` kind — embedding endpoints also map HTTP 413 to that kind via the same `classifyHttpStatus` path. The predicate works uniformly.
- **Q6:** Per-tenant input-size override (some tenants have higher limits)?
  - _Current direction:_ Out of scope. The kernel classifies the actual error; pre-flight limits are operator policy.
- **Q7:** Should we also classify "output too large" errors?
  - _Current direction:_ Out of scope. Output too large is generally signaled via `max_tokens` truncation (a `finish_reason` value, not an error). If a provider ships a distinct kind for output-too-large, add it then.
