# ADR-0127: not_found_error kernel kind + isNotFoundError cross-provider classifier (Phase 2 M2.X.13)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0087 (M2.X.6.x isModerationError), ADR-0090 (M2.X.7 isRetryableError), ADR-0095 (M2.X.9 isInputTooLargeError), ADR-0118 (M2.X.12 isConflictError) |

## Context

Four cross-provider error classifiers exist in `@crossengin/ai-providers` today:

- **M2.X.6.x** — `isModerationError` (`guardrail_intervened | content_filtered | refusal`).
- **M2.X.7** — `isRetryableError` (`rate_limit_error | overloaded_error | network_error | timeout_error | api_error | model_stream_error`).
- **M2.X.9** — `isInputTooLargeError` (`request_too_large`).
- **M2.X.12** — `isConflictError` (`conflict_error`).

All four follow the same shape: KINDS tuple + discriminator + duck-typed predicate on `.kind`. The convention is: when ≥2 providers emit a semantically-equivalent error class, lift the classifier to the kernel.

**The fifth class crosses that threshold easily.** All three providers (Anthropic, OpenAI, Bedrock) already emit `not_found_error` from their respective `classifyHttpStatus(404)` paths. The kernel kind exists; what's missing is the cross-provider classifier helper that operators write once and reuse everywhere.

Operators reach for `isNotFoundError` in three workflow types:

1. **Cross-provider Files API enumeration.** Listing files on Anthropic returns 404 when a file_id doesn't exist; OpenAI returns 404 similarly. Operators auditing file inventories across providers want a single `catch` that handles both surfaces.
2. **Polling / lookup flows on Bedrock control plane.** `getBatch` / `getGuardrail` / `getInferenceProfile` / `getImportedModel` / `getCustomModel` / `getModelImportJob` / `getModelCustomizationJob` — seven Bedrock single-resource lookups — all surface 404. Workflows discovering stale resource references want to treat all of them uniformly.
3. **Idempotent cleanup workflows.** Deleting a resource that's already deleted should be a no-op, not an error. `catch (err) { if (!isNotFoundError(err)) throw err }` is the standard pattern; the classifier makes it portable across providers.

## Decision

One new kernel module. No provider changes (the kind is already wired everywhere).

### `@crossengin/ai-providers/not-found.ts`

```ts
export const NOT_FOUND_ERROR_KINDS = ["not_found_error"] as const;
export type NotFoundErrorKind = (typeof NOT_FOUND_ERROR_KINDS)[number];

export interface NotFoundDiscriminator {
  readonly kind: string;
}

export function isNotFoundErrorKind(value: string): value is NotFoundErrorKind {
  return (NOT_FOUND_ERROR_KINDS as readonly string[]).includes(value);
}

export function isNotFoundError(
  err: unknown,
): err is Error & { readonly kind: NotFoundErrorKind } {
  if (err === null || typeof err !== "object") return false;
  const candidate = err as Record<string, unknown>;
  const kind = candidate["kind"];
  if (typeof kind !== "string") return false;
  return isNotFoundErrorKind(kind);
}
```

Structurally identical to `conflict.ts` (M2.X.12 / ADR-0118) and `input-too-large.ts` (M2.X.9). Single-kind tuple. Future variants (e.g., `model_not_found_error`, `resource_not_found_error` distinctions) extend the tuple additively.

### No provider changes

All three providers already classify HTTP 404 → `not_found_error`:

| Provider | classifyHttpStatus(404) | error-table mapping |
|---|---|---|
| `ai-providers-anthropic` | `not_found_error` | n/a (HTTP-status driven) |
| `ai-providers-openai` | `not_found_error` | n/a (HTTP-status driven) |
| `ai-providers-bedrock` | `not_found_error` | `ResourceNotFoundException` |

The classifier just makes the kind accessible at the kernel-level predicate.

## Cross-cutting invariants enforced

- **Same shape as the prior four classifiers.** KINDS tuple + predicate + discriminator. Operators learning one know all five.
- **Duck-typed on `.kind`.** No provider class dependency.
- **not_found_error is NOT retryable.** Resource absence is terminal; retrying with the same identifier never succeeds. (Edge case: AWS eventual consistency on freshly-created resources — operators with that workflow add their own wait+retry layer.)
- **not_found_error is NOT a moderation kind.**
- **not_found_error is NOT an input-too-large kind.**
- **not_found_error is NOT invalid_request_error.** Request shape vs resource absence are distinct categories.
- **not_found_error is NOT permission_error.** Adjacent but distinct: 403 means you can't access something that exists; 404 means it doesn't.
- **not_found_error is NOT conflict_error.** 409 means the resource exists in a conflicting state; 404 means it doesn't exist at all.
- **Single-kind tuple today.** Future sub-types extend the tuple without breaking call sites.

## End-to-end semantic

```ts
import { isNotFoundError } from "@crossengin/ai-providers";

// Idempotent file-delete across providers.
async function safeDelete(
  provider: AnthropicProvider | OpenAIProvider,
  fileId: string,
): Promise<void> {
  try {
    await provider.deleteFile(fileId);
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    // Already deleted — safe to ignore.
  }
}

// Drift detection across multiple Bedrock get* endpoints.
async function verifyResourcesExist(
  provider: BedrockProvider,
  refs: ReadonlyArray<{ kind: "guardrail" | "inference-profile" | "custom-model"; id: string }>,
): Promise<{ missing: string[] }> {
  const missing: string[] = [];
  for (const ref of refs) {
    try {
      if (ref.kind === "guardrail") await provider.getGuardrail(ref.id);
      else if (ref.kind === "inference-profile") await provider.getInferenceProfile(ref.id);
      else await provider.getCustomModel(ref.id);
    } catch (err) {
      if (isNotFoundError(err)) {
        missing.push(`${ref.kind}:${ref.id}`);
      } else {
        throw err;
      }
    }
  }
  return { missing };
}

// Combine with existing classifiers for full error space partitioning.
import { isNotFoundError, isConflictError, isRetryableError, isModerationError } from "@crossengin/ai-providers";

async function dispatch<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isNotFoundError(err)) {
      return handleMissingResource(err);
    }
    if (isConflictError(err)) {
      return reconcileState(err);
    }
    if (isModerationError(err)) {
      return surfaceToUser(err);
    }
    if (isRetryableError(err)) {
      await sleep(1000);
      return dispatch(fn);
    }
    throw err;
  }
}
```

## Alternatives considered

- **Add `not_found_error` to RETRYABLE_KINDS for eventual-consistency workflows.**
  - **Considered.** Some AWS resources have a brief window where freshly-created entities aren't visible to GET endpoints.
  - **Cons.** Conflating "doesn't exist" with "may exist soon" leads to infinite-loop bugs. AWS doesn't document eventual consistency for Bedrock control-plane resources; the eventual-consistency case is operator-specific.
  - **Decision.** Not retryable. Operators with eventual-consistency workflows wrap with their own wait+retry.

- **Use a multi-kind tuple from the start (e.g., `not_found_error`, `model_not_found`, `resource_not_found`).**
  - **Considered.** Finer-grained classification.
  - **Cons.** YAGNI — providers don't currently distinguish. Adding speculative kinds pollutes the API.
  - **Decision.** Single kind. Add more when providers distinguish.

- **Merge into a single "terminal_error" classifier with conflict + not_found + auth + invalid_request.**
  - **Considered.** Operators often just want "did the request fail terminally?"
  - **Cons.** Each category requires different handling. `not_found` is recoverable via "delete the dangling reference"; `auth` is recoverable via re-auth; `invalid_request` is recoverable via fixing the code. Merging loses information.
  - **Decision.** Separate classifier.

- **Skip the kernel module; have operators write `err.kind === "not_found_error"` inline.**
  - **Considered.** Less code.
  - **Cons.** Operators write fragile, untyped checks. Type narrowing via predicate is the established pattern.
  - **Decision.** Kernel module.

- **Wire into `@crossengin/ai-router` for special-case retry behavior.**
  - **Considered.** The router already special-cases moderation + retryable + input-too-large.
  - **Cons.** `not_found_error` is unambiguously terminal — there's no retry / fallback / continuation behavior that makes sense. Router doesn't need to special-case it (the default "non-retryable error → propagate" already handles it correctly).
  - **Decision.** Classifier only. No router integration needed.

## Consequences

- **55 packages + 1 app, 120 meta-schema tables, 7,430 tests** (+23 from M2.X.13: all in `not-found.test.ts`). All green, zero type errors.
- **Fifth cross-provider error classifier in the kernel.** `isModerationError`, `isRetryableError`, `isInputTooLargeError`, `isConflictError`, `isNotFoundError` — operators have a comprehensive toolkit.
- **Zero provider changes.** The kind was already wired across all three providers; this milestone just lifts the predicate to the kernel.
- **Pattern fully mature.** Five classifiers, identical shape. Future cross-provider kinds (perhaps `isAuthenticationError`, `isPermissionError`) follow the same shape mechanically.
- **Backwards compat fully preserved.** All pre-M2.X.13 tests pass without modification.
- **Idempotent cleanup workflows unblocked.** `catch (err) { if (!isNotFoundError(err)) throw err }` is now the documented pattern across all providers.

## Open questions

- **Q1:** Should `isAuthenticationError` / `isPermissionError` be lifted next?
  - _Current direction:_ Wait for actual operator catch-block need. The pattern is mature; mechanical lifts when demand surfaces.
- **Q2:** Multi-kind variant (`model_not_found` vs `resource_not_found` vs `file_not_found`)?
  - _Current direction:_ No provider distinguishes today. Defer.
- **Q3:** Should `isNotFoundError` accept HTTP status codes for cases where operators have raw fetch responses?
  - _Current direction:_ No. The kernel classifier surface stays focused on `.kind`. Operators with raw responses should construct typed errors first.
- **Q4:** Composite helper `isTerminalError(err)` that returns true for not_found OR conflict OR auth OR invalid_request OR moderation?
  - _Current direction:_ Operators chain `if (isNotFoundError(err) || isConflictError(err) || ...)` themselves. Composite would obscure the dispatch.
- **Q5:** Should the predicate also accept `Error & { name: string }` shape (no kind field)?
  - _Current direction:_ No. The classifier IS the `.kind`-based duck-typing convention. Operators with non-kernel errors handle them separately.
- **Q6:** Eventual-consistency retry helper for AWS Bedrock control-plane creates?
  - _Current direction:_ Out of scope. AWS doesn't document EC behavior on Bedrock control-plane reads; if/when they do, a dedicated `withCreationRetry` helper in `@crossengin/ai-router` would handle it.
