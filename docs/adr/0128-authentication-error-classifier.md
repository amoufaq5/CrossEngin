# ADR-0128: authentication_error kernel kind + isAuthenticationError cross-provider classifier (Phase 2 M2.X.14)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0087 (isModerationError), ADR-0090 (isRetryableError), ADR-0095 (isInputTooLargeError), ADR-0118 (isConflictError), ADR-0127 (isNotFoundError) |

## Context

Five cross-provider error classifiers exist in `@crossengin/ai-providers` today, all following the same shape: KINDS tuple + discriminator + duck-typed predicate on `.kind`. M2.X.13 (ADR-0127) explicitly lined up the sixth — `isAuthenticationError` — as Q1: "Wait for actual operator catch-block need. The pattern is mature; mechanical lifts when demand surfaces."

Demand surfaces in three workflows:

1. **Credential rotation**. AWS SDK with rotated access keys, OpenAI API key revoked, Anthropic key expired — all surface as HTTP 401. Operators want a single `catch` that triggers credential refresh + retry without retry-on-other-errors.
2. **Multi-tenant key management**. SaaS platforms storing per-tenant API keys need to handle "tenant's key is invalid" cleanly — surface a structured "key invalid, please re-enter" message to the tenant, not a generic stack trace.
3. **CI / pipeline credential checks**. Boot-time validation: try a minimal request; if `isAuthenticationError(err)`, fail loud with "credentials missing or wrong" rather than burying in a generic exception.

All three providers (Anthropic, OpenAI, Bedrock) already emit `authentication_error` from `classifyHttpStatus(401)`. Bedrock additionally maps `ExpiredTokenException` / `InvalidSignatureException` / `MissingAuthenticationTokenException` / `UnrecognizedClientException` via its CODE_TO_KIND table. The kernel kind exists; the classifier predicate is what's missing.

## Decision

One new kernel module. No provider changes.

### `@crossengin/ai-providers/authentication.ts`

```ts
export const AUTHENTICATION_ERROR_KINDS = ["authentication_error"] as const;
export type AuthenticationErrorKind = (typeof AUTHENTICATION_ERROR_KINDS)[number];

export function isAuthenticationErrorKind(value: string): value is AuthenticationErrorKind {
  return (AUTHENTICATION_ERROR_KINDS as readonly string[]).includes(value);
}

export function isAuthenticationError(
  err: unknown,
): err is Error & { readonly kind: AuthenticationErrorKind } {
  if (err === null || typeof err !== "object") return false;
  const candidate = err as Record<string, unknown>;
  const kind = candidate["kind"];
  if (typeof kind !== "string") return false;
  return isAuthenticationErrorKind(kind);
}
```

Structurally identical to `not-found.ts` (M2.X.13 / ADR-0127). Single-kind tuple.

### Distinct from `permission_error` (HTTP 403)

`authentication_error` (HTTP 401): credentials missing, expired, or wrong. Operator action: rotate / refresh / re-enter credentials.

`permission_error` (HTTP 403): credentials are valid but the principal lacks access to this resource. Operator action: grant the principal access or use a different principal.

These are operationally distinct — conflating them leads to wrong remediation. Operators wanting "any auth-related issue" compose:

```ts
if (isAuthenticationError(err) || isPermissionError(err)) { ... }
```

`isPermissionError` is the next mechanical lift (deferred Q1 here).

### No provider changes

All three providers already classify HTTP 401 → `authentication_error`:

| Provider | classifyHttpStatus(401) | typed-code mapping |
|---|---|---|
| `ai-providers-anthropic` | `authentication_error` | n/a (HTTP-status driven) |
| `ai-providers-openai` | `authentication_error` | `TYPE_TO_KIND["authentication_error"]` → `authentication_error` |
| `ai-providers-bedrock` | `authentication_error` (401 or 403; broad) | `ExpiredTokenException` / `InvalidSignatureException` / `MissingAuthenticationTokenException` / `UnrecognizedClientException` |

Note Bedrock's `classifyHttpStatus(401 || 403)` collapses both to `authentication_error` — a wider mapping than Anthropic / OpenAI. Operators with Bedrock-only code should not assume `authentication_error` strictly implies 401; the typed-code table provides finer detail when AWS includes a `__type` field.

## Cross-cutting invariants enforced

- **Same shape as the prior five classifiers.** KINDS tuple + predicate + discriminator. Operators learning one know all six.
- **Duck-typed on `.kind`.** No provider class dependency.
- **authentication_error is NOT retryable.** Same input + same bad credentials always fails.
- **authentication_error is NOT permission_error.** Distinct categories per HTTP semantics; operators wanting both compose.
- **authentication_error is NOT moderation_error.**
- **authentication_error is NOT input-too-large.**
- **authentication_error is NOT not_found_error.**
- **authentication_error is NOT conflict_error.**
- **authentication_error is NOT invalid_request_error.** Request shape vs credential validity are distinct.
- **Single-kind tuple today.** Future variants (e.g., `token_expired_error`, `signature_mismatch_error`) extend the tuple additively if a provider distinguishes.

## End-to-end semantic

```ts
import { isAuthenticationError, isPermissionError } from "@crossengin/ai-providers";
// (isPermissionError not yet lifted; placeholder for future M2.X.15)

// Credential rotation flow.
async function withRotationRetry<T>(
  fn: () => Promise<T>,
  refreshCredentials: () => Promise<void>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isAuthenticationError(err)) {
      await refreshCredentials();
      return fn(); // single retry post-rotation
    }
    throw err;
  }
}

// Multi-tenant key validation at request boundary.
async function dispatchForTenant(tenant: TenantContext, req: CompletionRequest) {
  try {
    return await provider.complete(req);
  } catch (err) {
    if (isAuthenticationError(err)) {
      throw new TenantKeyInvalidError(tenant.id, {
        message: "API key for this tenant is invalid or expired. Please update credentials in tenant settings.",
        cause: err,
      });
    }
    throw err;
  }
}

// CI boot-time check.
async function validateCredentials(): Promise<void> {
  try {
    await provider.complete({ task: "planner", messages: [{ role: "user", content: "ping" }], tenantId: "ci", sessionId: "validate", maxTokens: 1 });
  } catch (err) {
    if (isAuthenticationError(err)) {
      console.error("FATAL: provider credentials missing or invalid. Check env variables.");
      process.exit(1);
    }
    throw err;
  }
}

// Composite "any auth-related failure" (until isPermissionError lifts).
function isAnyAuthIssue(err: unknown): boolean {
  if (isAuthenticationError(err)) return true;
  if (err !== null && typeof err === "object") {
    const kind = (err as Record<string, unknown>)["kind"];
    return kind === "permission_error";
  }
  return false;
}
```

## Alternatives considered

- **Include `permission_error` in the same tuple.**
  - **Considered.** Operators sometimes want "any 4xx auth-related" classification.
  - **Cons.** Conflates HTTP semantics. 401 → "fix your credentials"; 403 → "fix your IAM policy" or "use a different principal." Different remediation paths.
  - **Decision.** Separate classifiers. `isPermissionError` is Q1 here for a future milestone.

- **Add `authentication_error` to RETRYABLE_KINDS for short-lived token edge cases.**
  - **Considered.** STS tokens, JWT expiry mid-request.
  - **Cons.** Retrying with the same credentials produces the same failure. Operators with token-refresh workflows wrap explicitly.
  - **Decision.** Not retryable.

- **Multi-kind variant from the start (`token_expired_error`, `signature_invalid_error`, `key_missing_error`).**
  - **Considered.** Finer-grained classification.
  - **Cons.** Providers don't all distinguish these — Anthropic / OpenAI bundle them into `authentication_error`. Bedrock has typed AWS exception names but maps them all to the same kernel kind.
  - **Decision.** Single kind. AWS-specific subtypes accessible via `.code` field on `BedrockError`.

- **Composite `isAuthOrPermissionError(err)` helper.**
  - **Considered.** One-call check for "any auth-related issue."
  - **Cons.** Operators with different remediation per case need to discriminate anyway. Composite would obscure the dispatch.
  - **Decision.** Operators compose two predicates when they need the union.

- **Special-case in `@crossengin/ai-router` for "abort retry chain on auth error."**
  - **Considered.** Like the M2.X.9 input-too-large special case.
  - **Cons.** The router's default "non-retryable error → propagate" already handles this correctly. `authentication_error` is not in RETRYABLE_KINDS so retries don't trigger.
  - **Decision.** No router integration needed.

## Consequences

- **55 packages + 1 app, 120 meta-schema tables, 7,454 tests** (+24 from M2.X.14: all in `authentication.test.ts`). All green, zero type errors.
- **Sixth cross-provider error classifier in the kernel.** `isModerationError`, `isRetryableError`, `isInputTooLargeError`, `isConflictError`, `isNotFoundError`, `isAuthenticationError` — operators have a near-complete toolkit.
- **Zero provider changes.** The kind was already wired everywhere.
- **Backwards compat fully preserved.**
- **Pattern fully mature.** Six classifiers, identical shape. ADR-0127 Q1 mechanically advanced.
- **Credential-rotation + tenant-key-validation + CI-boot-check workflows now have documented cross-provider patterns.**

## Open questions

- **Q1:** `isPermissionError` (HTTP 403) — companion classifier.
  - _Current direction:_ Next mechanical lift. Same shape as this milestone; ~30 lines of code + 24 tests.
- **Q2:** `isInvalidRequestError` (HTTP 400 — bad request shape)?
  - _Current direction:_ All three providers emit `invalid_request_error`. Mechanical lift when demand surfaces.
- **Q3:** Multi-kind variant for AWS Bedrock-specific token edge cases?
  - _Current direction:_ Operators access `BedrockError.code` for AWS exception names (`ExpiredTokenException` etc.) when finer discrimination needed.
- **Q4:** Composite `isAuthRelatedError(err)` that ORs auth + permission?
  - _Current direction:_ Operators chain `isAuthenticationError(err) || isPermissionError(err)` (once isPermissionError lifts).
- **Q5:** Should the router emit a structured `metrics:authentication_failed` counter on detection?
  - _Current direction:_ Out of scope. Operators wire their own observability per ADR-0120 (workflow instrumentation pattern).
- **Q6:** Should `isAuthenticationError` also accept SDK-specific error shapes (e.g., `aws-sdk` errors)?
  - _Current direction:_ No. The classifier follows the kernel `.kind` convention. Operators with SDK-level errors translate via `fromHttpResponse` / `fromNetworkError` first.
