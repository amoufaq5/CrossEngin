# ADR-0090: Cross-provider retryable helper (Phase 2 M2.X.7)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0087 (M2.X.6.x cross-provider moderation helper), ADR-0086 (M2.X.6 OpenAI + Anthropic moderation), ADR-0084 (M2.9.8 Bedrock Guardrails), ADR-0059 (M6.5 ai-router) |

## Context

M2.X.6.x shipped the first kernel-level cross-provider error helper: `isModerationError(err)`. The pattern proved valuable — operators using the router catch one error shape across all three providers instead of three. ADR-0087 Q3 noted the natural follow-on: the same shape should work for retryability classification.

Today, each provider's error class has an `isRetryable()` method that consults a local `RETRYABLE_KINDS` set:

- **Bedrock** (`@crossengin/ai-providers-bedrock`): `rate_limit_error`, `overloaded_error`, `network_error`, `timeout_error`, `api_error`, `model_stream_error`
- **OpenAI** (`@crossengin/ai-providers-openai`): `rate_limit_error`, `overloaded_error`, `network_error`, `timeout_error`, `api_error`
- **Anthropic** (`@crossengin/ai-providers-anthropic`): `rate_limit_error`, `overloaded_error`, `network_error`, `timeout_error`, `api_error`

Five of six kinds are shared across all three. `model_stream_error` is Bedrock-specific (the binary event-stream parser detects mid-stream errors).

The router (`@crossengin/ai-router`) calls `err.isRetryable()` to classify failures. That works because each provider returns its own typed error. But for code outside the router — generic error-handling middleware, observability layers, custom orchestration — calling `instanceof BedrockError ? err.isRetryable() : instanceof OpenAIError ? err.isRetryable() : ...` is awkward. M2.X.7 closes that with a kernel-level predicate.

The design constraints (matching M2.X.6.x):

- **Duck-typing on `.kind`.** No `instanceof` checks against three different classes from three different packages.
- **No changes to provider error classes.** Each class's `isRetryable()` method continues to work.
- **Shared kinds tuple is the union, not intersection.** If ANY provider considers a kind retryable, the kernel signals retryable. The five universal kinds + Bedrock's `model_stream_error` = 6 total.

## Decision

One new module + one new predicate + index exports + tests.

### 1. New `retryable.ts` in `@crossengin/ai-providers`

```ts
export const RETRYABLE_ERROR_KINDS = [
  "rate_limit_error",
  "overloaded_error",
  "network_error",
  "timeout_error",
  "api_error",
  "model_stream_error",
] as const;
export type RetryableErrorKind = (typeof RETRYABLE_ERROR_KINDS)[number];

export interface RetryableDiscriminator {
  readonly kind: string;
}

export function isRetryableErrorKind(value: string): value is RetryableErrorKind {
  return (RETRYABLE_ERROR_KINDS as readonly string[]).includes(value);
}

export function isRetryableError(
  err: unknown,
): err is Error & { readonly kind: RetryableErrorKind } {
  if (err === null || typeof err !== "object") return false;
  const candidate = err as Record<string, unknown>;
  const kind = candidate["kind"];
  if (typeof kind !== "string") return false;
  return isRetryableErrorKind(kind);
}
```

Identical shape to `isModerationError` — same duck-typing approach, same robustness against non-Error inputs, same type narrowing in TS.

### 2. Index exports

`@crossengin/ai-providers/src/index.ts` re-exports the new `retryable.js` module alongside `moderation.js`. `RETRYABLE_ERROR_KINDS`, `RetryableErrorKind`, `isRetryableErrorKind`, `isRetryableError`, and `RetryableDiscriminator` are public.

### 3. Symmetric API surface

Operators catching errors across providers now have parallel discriminators:

```ts
import { isModerationError, isRetryableError } from "@crossengin/ai-providers";

try {
  await router.complete(req);
} catch (err) {
  if (isModerationError(err)) return auditViolation(err.kind);
  if (isRetryableError(err)) return scheduleRetry(err);
  throw err;
}
```

Both predicates narrow `err.kind` to the relevant union. Both work uniformly across Bedrock + OpenAI + Anthropic. Neither requires provider-package imports.

### 4. Cross-package integration tests

Each provider's `errors.test.ts` gets two additional cases:

- Loop through the kinds the kernel considers retryable; for each, construct a provider-native error instance, assert `isRetryableError(err) === true` AND `err.isRetryable() === true` (both should agree).
- Assert moderation kinds + auth_error → `isRetryableError(err) === false`.

This verifies the kernel helper agrees with each provider's local `isRetryable()` method for the kinds they share. Bedrock additionally tests `model_stream_error`, which only Bedrock declares retryable but the kernel agrees with.

## Cross-cutting invariants enforced

- **`RETRYABLE_ERROR_KINDS` is the union of all providers' retryable sets.** Verified by enumerating each kind + checking against the source provider's `RETRYABLE_KINDS`.
- **No moderation kind is retryable.** Verified by test: `guardrail_intervened`, `content_filtered`, `refusal` all return `false`.
- **No auth / permission / not_found / invalid_request kind is retryable.** Verified by test.
- **Kernel `isRetryableError` agrees with each provider's `isRetryable()` method** for the shared kinds. Verified by cross-package test.
- **Robust against non-Error inputs.** `null`, `undefined`, primitives, objects without `kind`, objects with non-string `kind` all return `false`.
- **Type narrowing works.** Inside the predicate's true branch, `err.kind` narrows to `RetryableErrorKind` (a 6-member union).
- **No changes to provider error classes.** Pre-M2.X.7 code using `instanceof BedrockError` + `err.isRetryable()` continues to work.

## End-to-end semantics

```ts
import { isModerationError, isRetryableError } from "@crossengin/ai-providers";

async function callWithRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (isModerationError(err)) throw err;      // terminal — never retry
      if (!isRetryableError(err)) throw err;       // terminal — never retry
      // err.kind narrows to RetryableErrorKind here
      await delay(backoff(i, err.kind));
    }
  }
  throw lastErr;
}
```

Works uniformly whether `fn` calls Bedrock, OpenAI, or Anthropic. The custom retry layer doesn't need provider-specific imports or `instanceof` checks.

## Alternatives considered

- **Compute the kernel set as the INTERSECTION (only kinds all 3 providers consider retryable).**
  - **Considered.** More conservative — a kind retryable in the kernel sense is universally retryable.
  - **Cons.** Bedrock's `model_stream_error` would drop out of the kernel tuple even though Bedrock explicitly classifies it retryable. Operators handling Bedrock errors via the kernel helper would get a wrong answer.
  - **Decision.** Union. The kernel's "is this retryable?" reflects ANY provider's classification; per-provider semantics still flow through the local `isRetryable()` method.

- **Make `isRetryableError(err)` delegate to `err.isRetryable()` via duck typing.**
  - **Considered.** `if (typeof err.isRetryable === "function") return err.isRetryable()`.
  - **Cons.** Loses the discriminator pattern — operators with non-class-shaped errors (structured objects with a `kind` field) wouldn't work. The tuple-based approach handles both class instances + plain objects.
  - **Decision.** Inspect `.kind` against the shared tuple.

- **Merge `isModerationError` + `isRetryableError` into a single tagged classifier `classifyError(err): "moderation" | "retryable" | "terminal" | "unknown"`.**
  - **Considered.** One function, multiple outputs.
  - **Cons.** Forces a string-tag check at every call site. The two-predicate shape composes better with early-return code (the example above).
  - **Decision.** Two separate predicates. The classifier could be a thin convenience wrapper later if demand surfaces.

- **Move the per-provider `RETRYABLE_KINDS` sets into the kernel and have providers IMPORT them.**
  - **Considered.** Single source of truth.
  - **Cons.** Each provider's set has provider-specific kinds (Bedrock's `model_stream_error`). Centralizing would require either a superset everyone imports (with each provider filtering) or per-provider exports — neither is cleaner than the current arrangement.
  - **Decision.** Each provider keeps its own set; the kernel publishes the union for cross-provider classification.

- **Add a per-kind retry-policy lookup (`backoffForKind(kind): {minMs, maxMs, jitter}`).**
  - **Considered.** Operators want defaults like `rate_limit_error → 5s` vs `network_error → 1s`.
  - **Cons.** Out of scope. Backoff is a router concern; it already lives in `ai-router/retry.ts`. The kernel just classifies; the router decides.
  - **Decision.** Out of scope.

- **Ship in a separate `@crossengin/ai-errors` package.**
  - **Considered.** Separation of concerns.
  - **Cons.** Same rejection as ADR-0087 — premature factoring. The kernel surface for cross-provider helpers is small (~50 lines across both modules). Add a separate package only when it grows significantly.
  - **Decision.** Keep in `@crossengin/ai-providers`.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,668 tests** (+29 from M2.X.7: 19 kernel + 4 each per provider = 12 cross-package integration). All green, zero type errors.
- **ADR-0087 Q3 closed.** Kernel surface for cross-provider error handling now has parallel discriminators for the two big cross-cutting concerns.
- **Symmetric with M2.X.6.x.** `isModerationError` + `isRetryableError` follow the same duck-typing pattern + same kinds-tuple shape + same robustness against non-Error inputs.
- **Router could simplify.** The router's retry logic currently does `instanceof`-style checks on each provider's error. Future M6.6+ could collapse those to one `isRetryableError(err)` call. Out of scope for M2.X.7 (the router code isn't touched), but the path is open.
- **Pattern set for any third cross-provider concern.** If a future error category emerges (e.g., "input too large" — provider-specific but operationally cross-cutting), the same shape applies: kernel module + tuple + predicate + cross-package tests.

## Open questions

- **Q1:** Should `RETRYABLE_ERROR_KINDS` carry per-kind metadata (suggested backoff, max-attempts)?
  - _Current direction:_ Out of scope. Backoff policy is in `ai-router/retry.ts`. The kernel just classifies.
- **Q2:** Should `isRetryableError` also expose a complement helper `isTerminalError(err)`?
  - _Current direction:_ Operators write `!isRetryableError(err) && !isModerationError(err)`. A convenience wrapper would add a third helper for marginal value.
- **Q3:** What about idempotency-aware retryability — POST requests with idempotency keys vs ones without?
  - _Current direction:_ Out of scope. The retryable predicate classifies the ERROR; the operator's retry policy decides whether the OPERATION is safe to retry.
- **Q4:** Cross-provider unification of `unknown_error` — when one provider returns `unknown_error` from a 5xx, should the kernel infer retryable?
  - _Current direction:_ No. `unknown_error` means "we don't know what this is" — retrying is the operator's call. Conservative default: not in `RETRYABLE_ERROR_KINDS`.
- **Q5:** Per-tenant retryability override (some tenants might want stricter classification)?
  - _Current direction:_ Out of scope. Per-tenant policy belongs in the router or chat substrate, not the kernel predicate.
- **Q6:** Should the kernel ship a `classifyError(err): "moderation" | "retryable" | "terminal"` convenience function?
  - _Current direction:_ Deferred. Operators wanting it write a 3-line helper. Add to the kernel if call sites get noisy.
- **Q7:** What about a `RETRYABLE_NETWORK_KINDS` subset (just network + timeout, for distinguishing client-side from server-side retries)?
  - _Current direction:_ Out of scope. Operators distinguishing those cases inspect `err.kind` directly; the kernel's flat tuple is sufficient for the cross-provider need.
