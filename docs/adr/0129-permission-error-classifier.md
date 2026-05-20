# ADR-0129: permission_error kernel kind + isPermissionError cross-provider classifier (Phase 2 M2.X.15)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0087 (isModerationError), ADR-0090 (isRetryableError), ADR-0095 (isInputTooLargeError), ADR-0118 (isConflictError), ADR-0127 (isNotFoundError), ADR-0128 (isAuthenticationError) |

## Context

Six cross-provider error classifiers exist in `@crossengin/ai-providers` today. M2.X.14 (ADR-0128) explicitly lined up the seventh — `isPermissionError` — as Q1: "Companion classifier. Next mechanical lift. Same shape as this milestone; ~30 lines of code + 24 tests."

Demand pairs with M2.X.14's `isAuthenticationError`:

1. **Cross-account / cross-tenant access denials.** AWS Bedrock returns 403 `AccessDeniedException` when the IAM role lacks `bedrock:*` permissions for a specific operation. OpenAI returns 403 when an API key lacks access to a specific model. Anthropic returns 403 for tier-restricted endpoints.
2. **Multi-region access policies.** Inference profile routing through a region the operator lacks access to surfaces 403.
3. **Resource-scoped access.** Guardrail / custom-model / inference-profile created in account A is 403 to account B.

All three providers already emit `permission_error`:
- `ai-providers-anthropic.classifyHttpStatus(403)` → `permission_error`.
- `ai-providers-openai.classifyHttpStatus(403)` → `permission_error`.
- `ai-providers-bedrock` `CODE_TO_KIND["AccessDeniedException"]` → `permission_error` (Bedrock's `classifyHttpStatus(401 || 403)` collapses both to `authentication_error` broadly, but the typed-exception path provides finer detail).

The kernel kind exists everywhere; what's missing is the predicate.

## Decision

One new kernel module. No provider changes.

### `@crossengin/ai-providers/permission.ts`

```ts
export const PERMISSION_ERROR_KINDS = ["permission_error"] as const;
export type PermissionErrorKind = (typeof PERMISSION_ERROR_KINDS)[number];

export function isPermissionErrorKind(value: string): value is PermissionErrorKind {
  return (PERMISSION_ERROR_KINDS as readonly string[]).includes(value);
}

export function isPermissionError(
  err: unknown,
): err is Error & { readonly kind: PermissionErrorKind } {
  if (err === null || typeof err !== "object") return false;
  const candidate = err as Record<string, unknown>;
  const kind = candidate["kind"];
  if (typeof kind !== "string") return false;
  return isPermissionErrorKind(kind);
}
```

Structurally identical to `authentication.ts` (M2.X.14 / ADR-0128) and `not-found.ts` (M2.X.13 / ADR-0127).

### Distinct from `authentication_error`

| Kind | HTTP | Cause | Remediation |
|---|---|---|---|
| `authentication_error` | 401 | Bad / missing / expired credentials | Rotate / refresh / re-enter |
| `permission_error` | 403 | Valid credentials, principal lacks access | Grant access or use different principal |

Operators wanting "any auth-related issue" compose:

```ts
if (isAuthenticationError(err) || isPermissionError(err)) { ... }
```

### Bedrock's broad classifyHttpStatus

Bedrock's `classifyHttpStatus` maps both `401` and `403` to `authentication_error` (broad fallback). The provider-specific `CODE_TO_KIND` table provides finer detail when AWS supplies `__type: "AccessDeniedException"` — then `permission_error` is the resolved kind. Operators discriminating on `isAuthenticationError` vs `isPermissionError` get the right bucket as long as AWS includes the typed exception name (it does, for documented error responses).

For HTTP 403 responses WITHOUT `__type` (rare, undocumented), Bedrock falls back to `authentication_error`. Operators with finer needs inspect `.status === 403` or `.code === "AccessDeniedException"`.

## Cross-cutting invariants enforced

- **Same shape as the prior six classifiers.** KINDS tuple + predicate + discriminator.
- **Duck-typed on `.kind`.** No provider class dependency.
- **permission_error is NOT retryable.** Same principal + same resource always fails.
- **permission_error is NOT authentication_error.** Distinct HTTP semantics; distinct remediation.
- **permission_error is NOT not_found_error.** 403 implies the resource exists but is inaccessible; 404 implies it doesn't exist (or the principal can't see it).
- **permission_error is NOT conflict_error.**
- **permission_error is NOT moderation_error.**
- **permission_error is NOT input-too-large.**
- **permission_error is NOT invalid_request_error.**
- **Single-kind tuple today.** Future variants (e.g., `resource_access_denied_error`, `region_access_denied_error`) extend additively if a provider distinguishes.

## End-to-end semantic

```ts
import { isAuthenticationError, isPermissionError, isNotFoundError } from "@crossengin/ai-providers";

// Cross-account/cross-tenant access denial handling.
async function dispatchForTenant(tenant: TenantContext, req: CompletionRequest) {
  try {
    return await provider.complete(req);
  } catch (err) {
    if (isAuthenticationError(err)) {
      throw new TenantKeyInvalidError(tenant.id, { cause: err });
    }
    if (isPermissionError(err)) {
      throw new TenantAccessDeniedError(tenant.id, {
        message: `Tenant ${tenant.id} lacks access to model ${req.model ?? "default"}. Check IAM / API key scope.`,
        cause: err,
      });
    }
    if (isNotFoundError(err)) {
      throw new ResourceMissingError(req.model ?? "unknown", { cause: err });
    }
    throw err;
  }
}

// Composite "any auth-related" via inline OR.
function isAnyAuthIssue(err: unknown): boolean {
  return isAuthenticationError(err) || isPermissionError(err);
}

// Cross-account inference profile audit.
async function verifyProfileAccess(provider: BedrockProvider, profileArn: string): Promise<boolean> {
  try {
    await provider.getInferenceProfile(profileArn);
    return true;
  } catch (err) {
    if (isPermissionError(err)) {
      return false; // profile exists but inaccessible — report to operator
    }
    if (isNotFoundError(err)) {
      return false; // profile doesn't exist
    }
    throw err; // genuine unexpected error
  }
}
```

## Alternatives considered

- **Merge `permission_error` into `authentication_error`.**
  - **Considered.** Operators sometimes want unified "any auth issue."
  - **Cons.** Different remediation. 401 = credentials problem; 403 = policy problem. Merging hides the dispatch decision.
  - **Decision.** Separate.

- **Add `permission_error` to RETRYABLE_KINDS for "eventual policy propagation."**
  - **Considered.** IAM policy updates have ~5s propagation delay.
  - **Cons.** Same principal + same resource almost always fails the same way. The IAM-propagation case is rare + operator-specific.
  - **Decision.** Not retryable.

- **Multi-kind variant (`resource_access_denied`, `region_access_denied`, `tier_access_denied`).**
  - **Considered.** Finer-grained classification.
  - **Cons.** Providers don't distinguish today. AWS's `__type` field provides finer detail via `.code` when needed.
  - **Decision.** Single kind.

- **Composite helper `isAuthOrPermissionError(err)`.**
  - **Considered.** Common operator need.
  - **Cons.** Different remediation per case — operators wanting the composite check almost always need to discriminate. Composite would obscure the dispatch.
  - **Decision.** Operators compose two predicates inline.

- **Special-case in `@crossengin/ai-router` for "abort retry chain on permission error."**
  - **Considered.** Like input-too-large special case.
  - **Cons.** Default "non-retryable → propagate" already handles this.
  - **Decision.** No router integration.

## Consequences

- **55 packages + 1 app, 120 meta-schema tables, 7,479 tests** (+25 from M2.X.15: all in `permission.test.ts`). All green, zero type errors.
- **Seventh cross-provider error classifier in the kernel.** `isModerationError`, `isRetryableError`, `isInputTooLargeError`, `isConflictError`, `isNotFoundError`, `isAuthenticationError`, `isPermissionError` — the canonical 4xx/5xx classifier suite is now complete except for `invalid_request_error`.
- **Zero provider changes.**
- **Backwards compat fully preserved.**
- **Pattern fully mature.** Seven classifiers, identical shape. ADR-0128 Q1 closed mechanically.
- **Cross-account / cross-tenant / cross-region access denial workflows now have a documented cross-provider pattern.**

## Open questions

- **Q1:** `isInvalidRequestError` (HTTP 400 — bad request shape)?
  - _Current direction:_ Eighth and final mechanical lift to complete the 4xx classifier sweep. All three providers emit `invalid_request_error`. ~30 lines + 24 tests.
- **Q2:** Composite `isAuthRelatedError(err)` for auth + permission?
  - _Current direction:_ Operators chain inline. No composite helper.
- **Q3:** Sub-types for AWS-specific permission denials (e.g., `kms_access_denied`)?
  - _Current direction:_ Operators access `.code` field for AWS exception names.
- **Q4:** Should the router emit a structured metrics counter on permission_error detection?
  - _Current direction:_ Out of scope; operators wire observability per ADR-0120.
- **Q5:** Bedrock's HTTP 403 → `authentication_error` broad fallback when no `__type` is set — should the kernel surface a warning?
  - _Current direction:_ No. AWS surfaces `__type` for all documented errors. Operators encountering the rare typed-less 403 inspect `.status === 403` directly.
