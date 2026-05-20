# ADR-0130: invalid_request_error kernel kind + isInvalidRequestError cross-provider classifier (Phase 2 M2.X.16)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0087 (isModerationError), ADR-0090 (isRetryableError), ADR-0095 (isInputTooLargeError), ADR-0118 (isConflictError), ADR-0127 (isNotFoundError), ADR-0128 (isAuthenticationError), ADR-0129 (isPermissionError) |

## Context

Seven cross-provider error classifiers exist in `@crossengin/ai-providers` today. M2.X.15 (ADR-0129) explicitly lined up the eighth — `isInvalidRequestError` — as Q1: "Eighth and final mechanical lift to complete the 4xx classifier sweep."

Demand surfaces in three workflow types:

1. **CI-driven kernel-validation tests.** Operators write integration tests that intentionally pass malformed requests (missing required fields, out-of-range values, mistyped parameters) and assert the provider responds with `isInvalidRequestError`. Today they discriminate on `err.status === 400` which is provider-leaked.
2. **Automated request-fix workflows.** When an `invalid_request_error` surfaces, an upstream code generator (LLM-authored requests) needs to know to re-prompt with the actual error message. Generic `try/catch` doesn't discriminate from genuine failures.
3. **User-facing error surfaces.** Multi-tenant SaaS frontends translate 4xx classes into structured user messages: invalid_request → "your input contained an error" (specific message preserved), permission → "no access" (generic message), authentication → "login expired", etc.

All three providers already emit `invalid_request_error`:
- `ai-providers-anthropic.classifyHttpStatus(400)` → `invalid_request_error`.
- `ai-providers-openai.classifyHttpStatus(400)` → `invalid_request_error` (+ `TYPE_TO_KIND["invalid_request_error"]` → `invalid_request_error`).
- `ai-providers-bedrock.classifyHttpStatus(400)` → `invalid_request_error` (+ `CODE_TO_KIND["ValidationException"]` → `invalid_request_error`).

The kernel kind exists everywhere; the predicate is the last missing piece.

## Decision

One new kernel module. No provider changes.

### `@crossengin/ai-providers/invalid-request.ts`

```ts
export const INVALID_REQUEST_ERROR_KINDS = ["invalid_request_error"] as const;
export type InvalidRequestErrorKind = (typeof INVALID_REQUEST_ERROR_KINDS)[number];

export function isInvalidRequestErrorKind(value: string): value is InvalidRequestErrorKind {
  return (INVALID_REQUEST_ERROR_KINDS as readonly string[]).includes(value);
}

export function isInvalidRequestError(
  err: unknown,
): err is Error & { readonly kind: InvalidRequestErrorKind } {
  if (err === null || typeof err !== "object") return false;
  const candidate = err as Record<string, unknown>;
  const kind = candidate["kind"];
  if (typeof kind !== "string") return false;
  return isInvalidRequestErrorKind(kind);
}
```

Structurally identical to `permission.ts` (M2.X.15) and `authentication.ts` (M2.X.14).

### Distinct from `request_too_large` (HTTP 413)

Both are "your request is wrong" categories but operationally distinct:
- `invalid_request_error` (400): structural problem — missing field, bad type, out-of-range. Operator fixes the request shape.
- `request_too_large` (413): correct shape but oversized payload. Operator reduces the input.

Operators wanting "any client-side request problem" compose:
```ts
if (isInvalidRequestError(err) || isInputTooLargeError(err)) { ... }
```

### Canonical 4xx classifier sweep complete

| HTTP | Kind | Classifier |
|---|---|---|
| 400 | `invalid_request_error` | `isInvalidRequestError` ← THIS MILESTONE |
| 401 | `authentication_error` | `isAuthenticationError` (M2.X.14) |
| 403 | `permission_error` | `isPermissionError` (M2.X.15) |
| 404 | `not_found_error` | `isNotFoundError` (M2.X.13) |
| 408 | `timeout_error` | covered by `isRetryableError` (M2.X.7) |
| 409 | `conflict_error` | `isConflictError` (M2.X.12) |
| 413 | `request_too_large` | `isInputTooLargeError` (M2.X.9) |
| 429 | `rate_limit_error` | covered by `isRetryableError` (M2.X.7) |
| 503/529 | `overloaded_error` | covered by `isRetryableError` (M2.X.7) |
| ≥500 | `api_error` | covered by `isRetryableError` (M2.X.7) |

Moderation-specific (`guardrail_intervened`, `content_filtered`, `refusal`) covered by `isModerationError` (M2.X.6.x).

Network-layer (`network_error`, `timeout_error`) covered by `isRetryableError` (M2.X.7).

**Coverage is now complete.** Every documented kernel error kind across all three providers maps to at least one of the eight classifiers (with retryable + moderation being multi-kind).

### No provider changes

All three providers already classify HTTP 400 → `invalid_request_error`. Adding this milestone is purely the kernel-side lift.

## Cross-cutting invariants enforced

- **Same shape as the prior seven classifiers.** KINDS tuple + predicate + discriminator.
- **Duck-typed on `.kind`.** No provider class dependency.
- **invalid_request_error is NOT retryable.** Same input always fails the same way.
- **invalid_request_error is NOT input-too-large.** 400 vs 413 distinction preserved.
- **invalid_request_error is NOT authentication / permission / not_found / conflict / moderation.** Strict mutual exclusivity validated by tests.
- **Single-kind tuple today.**

## End-to-end semantic

```ts
import {
  isInvalidRequestError,
  isInputTooLargeError,
  isAuthenticationError,
  isPermissionError,
  isNotFoundError,
  isConflictError,
  isRetryableError,
  isModerationError,
} from "@crossengin/ai-providers";

// User-facing error translation.
async function withUserError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isInvalidRequestError(err)) {
      throw new UserMessageError(
        "Your input contained an error",
        { detail: err instanceof Error ? err.message : "", cause: err },
      );
    }
    if (isInputTooLargeError(err)) {
      throw new UserMessageError("Your input was too long — shorten and retry", { cause: err });
    }
    if (isAuthenticationError(err)) {
      throw new UserMessageError("Login expired — please reauthenticate", { cause: err });
    }
    if (isPermissionError(err)) {
      throw new UserMessageError("You don't have access to this", { cause: err });
    }
    if (isNotFoundError(err)) {
      throw new UserMessageError("Resource not found", { cause: err });
    }
    if (isConflictError(err)) {
      throw new UserMessageError("Resource is in an incompatible state", { cause: err });
    }
    if (isModerationError(err)) {
      throw new UserMessageError("Request was blocked by safety policies", { cause: err });
    }
    if (isRetryableError(err)) {
      throw new UserMessageError("Temporary problem — please retry", { cause: err });
    }
    throw new UserMessageError("Unexpected error", { cause: err });
  }
}

// Auto-fix workflow for LLM-generated requests.
async function withAutoFix<T>(
  fn: () => Promise<T>,
  fix: (errMsg: string) => Promise<CompletionRequest>,
  maxAttempts = 3,
): Promise<T> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isInvalidRequestError(err) || i === maxAttempts - 1) throw err;
      const errMsg = err instanceof Error ? err.message : "unknown";
      await fix(errMsg);  // re-generate via LLM with error feedback
    }
  }
  throw new Error("withAutoFix: exceeded maxAttempts");
}
```

## Alternatives considered

- **Merge `invalid_request_error` + `request_too_large` into one tuple.**
  - **Considered.** Both are "client-side request problem."
  - **Cons.** Different remediation — 400 fixes structure; 413 reduces size. Merging hides the dispatch.
  - **Decision.** Separate.

- **Multi-kind variant (`missing_field_error`, `bad_type_error`, `out_of_range_error`).**
  - **Considered.** Operators sometimes want to distinguish.
  - **Cons.** Providers don't distinguish today; AWS's `ValidationException` carries a free-text message. Operators with finer needs parse `.message`.
  - **Decision.** Single kind.

- **Composite `isClientError(err)` that ORs all 4xx classifiers.**
  - **Considered.** Common operator need.
  - **Cons.** Different remediation per case. Composite obscures the dispatch.
  - **Decision.** Operators compose inline when needed.

- **Make this the final 4xx classifier and freeze the suite.**
  - **Considered.** Stop adding classifiers; let `invalid_request_error` close the sweep.
  - **Cons.** No new classifier is forced; operators can still lift sub-kinds (e.g., `timeout_error` separate from `isRetryableError`) if demand surfaces.
  - **Decision.** This completes the canonical sweep but the pattern remains open.

## Consequences

- **55 packages + 1 app, 120 meta-schema tables, 7,503 tests** (+24 from M2.X.16: all in `invalid-request.test.ts`). All green, zero type errors.
- **Eighth cross-provider error classifier in the kernel.** `isModerationError`, `isRetryableError`, `isInputTooLargeError`, `isConflictError`, `isNotFoundError`, `isAuthenticationError`, `isPermissionError`, `isInvalidRequestError`.
- **Canonical 4xx/5xx classifier sweep complete.** Every documented kernel error kind across all three providers has a kernel classifier.
- **Mutual exclusivity validated.** New test case asserts an `invalid_request_error` matches exactly one of the eight classifiers (itself).
- **Zero provider changes.**
- **Backwards compat fully preserved.**
- **Pattern fully mature.** Eight classifiers, identical shape.
- **Documented translation pattern.** User-facing error surfaces now have an 8-way dispatch documented in `end-to-end semantic` above.

## Open questions

- **Q1:** Should the classifier suite be frozen after M2.X.16?
  - _Current direction:_ Open. If a provider ships a new error class (e.g., Anthropic's hypothetical `model_overloaded_error`), the pattern handles it mechanically.
- **Q2:** Composite helper modules (`isClientError`, `isServerError`, `isAuthRelated`)?
  - _Current direction:_ Operators compose inline. Composites would obscure the per-error dispatch.
- **Q3:** Should `@crossengin/ai-router` use the classifier suite to drive sophisticated retry/fallback dispatch?
  - _Current direction:_ Router already uses `isRetryableError` + `isModerationError` for short-circuit. The other six classifiers are operator-side.
- **Q4:** Should a user-facing error-translation utility ship in a future milestone?
  - _Current direction:_ Out of scope — different operators want different user-message vocabularies + i18n needs.
- **Q5:** Documentation milestone consolidating all 8 classifiers into a single "Error Handling" guide?
  - _Current direction:_ Operators can read the 8 ADRs (0087/0090/0095/0118/0127/0128/0129/0130). Consolidation can land if needed.
- **Q6:** Should the kernel surface a `kindFromHttpStatus(status)` helper for cases where operators have raw HTTP responses?
  - _Current direction:_ Provider-specific `classifyHttpStatus` already handles this. Operators should construct typed errors first.
