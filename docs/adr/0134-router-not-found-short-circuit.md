# ADR-0134: ai-router special-cases isNotFoundError for retry chain short-circuit (Phase 2 M6.6.y)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0091 (M6.6 router moderation early-exit), ADR-0127 (M2.X.13 not_found_error classifier), ADR-0133 (M6.6.x router conflict short-circuit) |

## Context

`@crossengin/ai-router` already short-circuits the retry / fallback chain on moderation events (ADR-0091 / M6.6) and conflict events (ADR-0133 / M6.6.x). The pattern is now familiar:

> Terminal events — never retry, never fall over to fallback providers. The cause lives outside the provider's availability, so switching providers can't help.

The same logic applies to `not_found_error` (HTTP 404). When AWS Bedrock's `getModelCustomizationJob` returns 404 ResourceNotFoundException because the ARN doesn't exist, retrying the same request always fails the same way. Switching to a different provider doesn't help either: identifiers are provider-scoped. An OpenAI `file_id` is not an Anthropic file ID is not a Bedrock ARN. Fallback would re-issue the same identifier against a different provider that doesn't know it.

ADR-0133 (M6.6.x) lined this up as Q1:

> Q1: Should `isNotFoundError` get the same short-circuit?
> _Current direction:_ Probably. Identifier mismatches don't get better with fallback. Defer to a follow-up with its own ADR.

M6.6.y closes that.

## Decision

One-line extension to `isRouterRetryable` in `@crossengin/ai-router/src/router.ts`.

### Before

```ts
function isRouterRetryable(err: unknown): boolean {
  if (err instanceof CostCeilingExceededError) return false;
  if (err instanceof ProviderResolutionError) return false;
  if (err instanceof AllProvidersExhaustedError) return false;
  if (isModerationError(err)) return false;
  if (isConflictError(err)) return false;
  return isRetryableError(err);
}
```

### After

```ts
function isRouterRetryable(err: unknown): boolean {
  if (err instanceof CostCeilingExceededError) return false;
  if (err instanceof ProviderResolutionError) return false;
  if (err instanceof AllProvidersExhaustedError) return false;
  if (isModerationError(err)) return false;
  if (isConflictError(err)) return false;
  if (isNotFoundError(err)) return false;  // NEW
  return isRetryableError(err);
}
```

### Import widening

```ts
import {
  contentToText,
  isConflictError,
  isModerationError,
  isNotFoundError,  // NEW
} from "@crossengin/ai-providers";
```

That's the entire code change. Five new tests + a code comment explaining the semantics.

## Cross-cutting invariants enforced

- **Same shape as M6.6 (moderation) and M6.6.x (conflict).** Operators learning one early-exit pattern know all.
- **Terminal semantic.** Not-found means "identifier doesn't resolve (or this principal can't see it)" — retrying with the same identifier always fails the same way.
- **No fallback either.** Identifiers are provider-scoped. An OpenAI `file_id` is not an Anthropic file ID is not a Bedrock ARN. Re-issuing against a different provider can't succeed.
- **Preserves the original error.** The router rejects with the verbatim not_found error (including `.status === 404`).
- **Doesn't affect other classifiers.** rate_limit_error still falls over; invalid_request_error still propagates as before; moderation and conflict still early-exit separately.
- **Backwards compat preserved.** Pre-M6.6.y rate_limit + moderation + conflict + retryable paths unchanged.

## End-to-end semantic

```ts
import { isNotFoundError } from "@crossengin/ai-providers";

const router = buildRouter({
  providers: new Map([
    ["anthropic", anthropicProvider],
    ["openai", openaiProvider],
  ]),
});

// Anthropic primary throws not_found_error (e.g., file_id doesn't exist).
// Router does NOT fall over to OpenAI; propagates the 404.
try {
  for await (const chunk of router.complete(req)) { ... }
} catch (err) {
  if (isNotFoundError(err)) {
    // Operator handles the identifier-mismatch (re-upload, look up canonical ID, etc.).
    return rebuildIdentifier(err);
  }
  throw err;
}

// Compare: rate_limit_error continues to fall over.
// Anthropic throws rate_limit_error → router tries OpenAI → returns OpenAI output.
```

## Alternatives considered

- **Extend the short-circuit to all five remaining non-retryable classifiers (authentication, permission, invalid_request, input_too_large) in one go.**
  - **Considered.** Bundles related work.
  - **Cons.** Each has different semantics:
    - `authentication_error`: bad credentials. Different provider has different credentials. **Fallback might help.**
    - `permission_error`: IAM policy issue. Different provider has different policy. **Fallback might help.**
    - `invalid_request_error`: structural problem with the payload. Different provider might tolerate same payload. **Fallback might help in theory.**
    - `input_too_large`: context-window overflow. Larger-context fallback often accepts. **Fallback often DOES help.**
  - **Decision.** Just not_found_error this milestone. Each future short-circuit gets its own ADR with documented semantics.

- **Auto-resolve 404 via lookup: on `getCustomModel(arn)` 404, fall back to a `listCustomModels` scan.**
  - **Considered.** Common operator workflow.
  - **Cons.** Provider-specific; not the router's concern. Operators wrap their own `getOrSearch` helper.
  - **Decision.** Operators write their own reconciliation logic.

- **Make the short-circuit configurable (opt-out per-request).**
  - **Considered.** Some operators want "always try everything."
  - **Cons.** Terminal errors don't get better with retries. The opt-out would be a footgun.
  - **Decision.** Always short-circuit. Operators wanting different behavior catch and rethrow.

- **Distinguish "404 because deleted" from "404 because never existed" before short-circuiting.**
  - **Considered.** Some classification fidelity.
  - **Cons.** No provider exposes that distinction reliably. Even if they did, the router action would be identical (short-circuit).
  - **Decision.** Treat them uniformly.

- **Special-case "404 from Files API" vs "404 from generic resource lookup" — the former might benefit from re-upload.**
  - **Considered.** Files API has known re-upload patterns.
  - **Cons.** Re-upload is operator workflow, not router transport. Same as the auto-resolve point.
  - **Decision.** Operators handle re-upload above the router.

## Consequences

- **55 packages + 1 app, 120 meta-schema tables, 7,551 tests** (+5 from M6.6.y: all in `router.test.ts`). All green, zero type errors.
- **Not-found errors no longer waste fallback-provider attempts.** Operators avoid the silent surprise of "Anthropic returned 404; OpenAI also got tried with the same Anthropic-scoped file_id and returned 400; final error was unrelated to the actual problem."
- **ADR-0133 Q1 closed.** Three classifiers now have router short-circuit (moderation, conflict, not_found).
- **Pattern set for future classifier short-circuits.** When operators ask for invalid_request short-circuit, the same `isRouterRetryable` pattern adds it in one line.
- **Backwards compat preserved.** Pre-M6.6.y behavior on every other error class unchanged.

## Open questions

- **Q1:** Should `isInvalidRequestError` get the same short-circuit?
  - _Current direction:_ Less clear — different providers tolerate different schemas. Worth a follow-up ADR with empirical data.
- **Q2:** Should `isInputTooLargeError` short-circuit, or use the fallback to find a larger-context model?
  - _Current direction:_ Fallback is the natural answer here. Provider order matters: arrange small-context primary → large-context fallback for automatic upgrade.
- **Q3:** Should `isAuthenticationError` / `isPermissionError` short-circuit?
  - _Current direction:_ Bedrock with stale credentials should NOT trigger an OpenAI fallback if the operator's intent was a Bedrock call. But if the operator wired multiple providers expecting any-of-them to work, fallback IS desired. Operator-specific; no default change.
- **Q4:** A `metrics:router_short_circuit_reason` counter — emit "moderation" vs "conflict" vs "not_found" vs other?
  - _Current direction:_ Out of scope. ADR-0120 instrumentation is workflow-scoped, not router-scoped. A router-scoped instrumentation interface would be a separate ADR.
- **Q5:** Composite helper `isTerminalRouterError(err)` that checks all short-circuit conditions?
  - _Current direction:_ Internal to the router (`isRouterRetryable`'s negation). Operators discriminate via the individual classifiers.
- **Q6:** Should the router emit a structured signal upstream when it short-circuits, vs swallowing the cause?
  - _Current direction:_ It already preserves the original error verbatim. Operators inspect via `isNotFoundError(err) && err.status === 404`. No structured signal needed.
