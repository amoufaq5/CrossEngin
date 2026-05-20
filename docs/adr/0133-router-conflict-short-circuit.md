# ADR-0133: ai-router special-cases isConflictError for retry chain short-circuit (Phase 2 M6.6.x)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0091 (M6.6 router moderation early-exit), ADR-0118 (M2.X.12 conflict_error classifier) |

## Context

`@crossengin/ai-router` already short-circuits the retry / fallback chain on moderation events (ADR-0091 / M6.6). The pattern is documented:

> Moderation events are terminal — never retry, never fall over to fallback providers (the input itself triggered the moderation; switching providers won't help).

The same logic applies to `conflict_error` (HTTP 409). When AWS Bedrock's `stopBatch` returns 409 ConflictException because the job is already terminal, or `createBatch` returns 409 because the jobName already exists, retrying the same request always produces the same failure. Switching to a different provider doesn't help either — the conflict lives on the operator's resource state, not on the provider's availability.

ADR-0118 (M2.X.12) explicitly lined up this special-case as Q2:

> Q2: Should `@crossengin/ai-router` special-case `isConflictError` (e.g., short-circuit retry chain)?
> _Current direction:_ Yes — same as the M6.6 special-casing for moderation errors. Deferred to a follow-up.

M6.6.x closes that.

## Decision

One-line extension to `isRouterRetryable` in `@crossengin/ai-router/src/router.ts`.

### Before

```ts
function isRouterRetryable(err: unknown): boolean {
  if (err instanceof CostCeilingExceededError) return false;
  if (err instanceof ProviderResolutionError) return false;
  if (err instanceof AllProvidersExhaustedError) return false;
  if (isModerationError(err)) return false;
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
  if (isConflictError(err)) return false;  // NEW
  return isRetryableError(err);
}
```

### Import widening

```ts
import {
  contentToText,
  isConflictError,  // NEW
  isModerationError,
} from "@crossengin/ai-providers";
```

That's the entire code change. Five new tests + a code comment explaining the semantics.

## Cross-cutting invariants enforced

- **Same shape as M6.6's moderation short-circuit.** Operators learning one early-exit pattern know all.
- **Terminal semantic.** Conflict means "resource is in incompatible state" — retrying with the same input always fails.
- **No fallback either.** Switching providers doesn't help — the conflict is on operator state, not provider availability.
- **Preserves the original error.** The router rejects with the verbatim conflict error (including `.status === 409`, `.code === "ConflictException"`).
- **Doesn't affect other classifiers.** rate_limit_error still falls over; invalid_request_error still propagates as before; moderation still early-exits separately.
- **Backwards compat preserved.** Pre-M6.6.x rate_limit + moderation + retryable paths unchanged.

## End-to-end semantic

```ts
import { isConflictError } from "@crossengin/ai-providers";

const router = buildRouter({
  providers: new Map([
    ["anthropic", anthropicProvider],
    ["openai", openaiProvider],
  ]),
});

// Anthropic primary throws conflict_error (e.g., from a Files API uniqueness violation).
// Router does NOT fall over to OpenAI; propagates the conflict.
try {
  for await (const chunk of router.complete(req)) { ... }
} catch (err) {
  if (isConflictError(err)) {
    // Operator handles state reconciliation (look up existing resource, reuse, etc.).
    return reconcileState(err);
  }
  throw err;
}

// Compare: rate_limit_error continues to fall over.
// Anthropic throws rate_limit_error → router tries OpenAI → returns OpenAI output.
```

## Alternatives considered

- **Extend the short-circuit to all six non-retryable classifiers (not_found, authentication, permission, invalid_request, input_too_large, conflict).**
  - **Considered.** Comprehensive coverage.
  - **Cons.** Each has different semantics:
    - `not_found_error`: identifier was wrong; another provider can't fix it. **Short-circuit appropriate** — but lump-add risks over-engineering. Defer.
    - `authentication_error`: bad credentials. Operator might have different credentials per provider; falling over to a fallback with different valid credentials could work. **Fallback might help.**
    - `permission_error`: IAM policy issue on the primary. Different provider has different policy. **Fallback might help.**
    - `invalid_request_error`: structural problem. Different provider might tolerate the same input. **Fallback might help (in theory; in practice usually no).**
    - `input_too_large`: request exceeds context window. Different provider with larger context might accept. **Fallback often DOES help.**
  - **Decision.** Just conflict_error this milestone. Each future short-circuit gets its own ADR with documented semantics.

- **Add `isConflictError` to `isRetryableError`'s exclusion set (in the ai-providers package).**
  - **Considered.** Conflict_error explicitly excluded from RETRYABLE_KINDS in every provider's table.
  - **Cons.** It already is — every provider's RETRYABLE_KINDS set does not include conflict_error. The router's `isRetryableError(err)` returns false for conflict_error today. The problem isn't that the router retries; it's that the router falls over to the FALLBACK provider on retryable-false errors UNLESS the gate excludes them. The early-exit pattern is on top of `isRetryableError`, not inside it.
  - **Decision.** Router-side gate.

- **Auto-resolve 409 ConflictException via `listX` lookup (for createBatch, look up existing job with same name).**
  - **Considered.** Common operator workflow.
  - **Cons.** Provider-specific logic; not the router's concern. Operators wrap their own `createOrLookup` helper (as shown in M2.X.5.aa.z.6 ADR-0108).
  - **Decision.** Operators write their own reconciliation logic.

- **Add a `metrics:router_conflict_short_circuit` counter for observability.**
  - **Considered.** Operators want to know how often this fires.
  - **Cons.** The router doesn't emit metrics today; doing so for one classifier would be inconsistent.
  - **Decision.** Operators wire their own observability via the existing `isConflictError` predicate.

- **Make the short-circuit configurable (opt-out per-request).**
  - **Considered.** Some operators want "always try everything."
  - **Cons.** Terminal errors don't get better with retries. The opt-out would be a footgun.
  - **Decision.** Always short-circuit. Operators wanting different behavior catch and rethrow.

## Consequences

- **55 packages + 1 app, 120 meta-schema tables, 7,546 tests** (+5 from M6.6.x: all in `router.test.ts`). All green, zero type errors.
- **Conflict errors no longer waste fallback-provider attempts.** Operators avoid the silent surprise of "AWS Bedrock returned 409; OpenAI also got tried and returned 400; final error was unrelated."
- **M2.X.12 Q2 closed.** ADR-0118's deferred Q is now addressed.
- **Pattern set for future classifier short-circuits.** When operators ask for not_found / invalid_request short-circuit, the same `isRouterRetryable` pattern adds them in one line each.
- **Backwards compat preserved.** Pre-M6.6.x behavior on every other error class unchanged.

## Open questions

- **Q1:** Should `isNotFoundError` get the same short-circuit?
  - _Current direction:_ Probably. Identifier mismatches don't get better with fallback. Defer to a follow-up with its own ADR.
- **Q2:** Should `isInvalidRequestError` get the same short-circuit?
  - _Current direction:_ Less clear — different providers tolerate different schemas. Worth a follow-up ADR with empirical data.
- **Q3:** Should `isInputTooLargeError` short-circuit, or use the fallback to find a larger-context model?
  - _Current direction:_ Fallback is the natural answer here. Provider order matters: arrange small-context primary → large-context fallback for automatic upgrade.
- **Q4:** Should `isAuthenticationError` / `isPermissionError` short-circuit?
  - _Current direction:_ Bedrock with stale credentials should NOT trigger an OpenAI fallback if the operator's intent was a Bedrock call. But if the operator wired multiple providers expecting any-of-them to work, fallback IS desired. Operator-specific; no default change.
- **Q5:** A `metrics:router_short_circuit_reason` counter — emit "moderation" vs "conflict" vs other?
  - _Current direction:_ Out of scope. ADR-0120 instrumentation is workflow-scoped, not router-scoped. A router-scoped instrumentation interface would be a separate ADR.
- **Q6:** Composite helper `isTerminalRouterError(err)` that checks all short-circuit conditions?
  - _Current direction:_ Internal to the router (`isRouterRetryable`'s negation). Operators discriminate via the individual classifiers.
