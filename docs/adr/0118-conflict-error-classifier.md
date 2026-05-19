# ADR-0118: conflict_error kernel kind + isConflictError cross-provider classifier (Phase 2 M2.X.12)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0086 (M2.X.6.x moderation classifier), ADR-0090 (M2.X.7 retryable classifier), ADR-0095 (M2.X.9 input-too-large classifier), ADR-0107 (M2.X.5.aa.z.5 stopBatch — first 409 source), ADR-0108 (M2.X.5.aa.z.6 createBatch — second 409 source) |

## Context

Three cross-provider error classifiers exist in `@crossengin/ai-providers` today:
- **M2.X.6.x** — `isModerationError` (`guardrail_intervened | content_filtered | refusal`).
- **M2.X.7** — `isRetryableError` (`rate_limit_error | overloaded_error | network_error | timeout_error | api_error | model_stream_error`).
- **M2.X.9** — `isInputTooLargeError` (`request_too_large`).

All three sit at the kernel layer (no provider dependencies); all three duck-type on `.kind`. The convention is: when ≥2 providers emit a semantically-equivalent error class, lift the classifier to the kernel so operators can write provider-agnostic catch logic.

**The fourth class is now justified.** Two Bedrock endpoints emit HTTP 409 ConflictException:
- `stopBatch` (M2.X.5.aa.z.5) — job already in terminal state.
- `createBatch` (M2.X.5.aa.z.6) — jobName already exists OR clientRequestToken reused with different body.

OpenAI's Assistants / Files / Fine-tuning APIs also emit 409 conflicts (e.g., trying to modify a run that's already in a terminal state, filename conflicts on uploads). Anthropic's documented surface doesn't currently emit 409 but the kernel kind future-compats their addition.

Both M2.X.5.aa.z.5 and M2.X.5.aa.z.6 ADRs explicitly deferred this work ("dedicated conflict_error kernel kind deferred until a second 409-emitting endpoint lands"). That trigger is met; this milestone delivers it.

## Decision

One new kernel module + three provider error-table extensions.

### 1. `@crossengin/ai-providers/conflict.ts`

```ts
export const CONFLICT_ERROR_KINDS = ["conflict_error"] as const;
export type ConflictErrorKind = (typeof CONFLICT_ERROR_KINDS)[number];

export function isConflictErrorKind(value: string): value is ConflictErrorKind {
  return (CONFLICT_ERROR_KINDS as readonly string[]).includes(value);
}

export function isConflictError(
  err: unknown,
): err is Error & { readonly kind: ConflictErrorKind } {
  if (err === null || typeof err !== "object") return false;
  const candidate = err as Record<string, unknown>;
  const kind = candidate["kind"];
  if (typeof kind !== "string") return false;
  return isConflictErrorKind(kind);
}
```

Structurally identical to `input-too-large.ts` (M2.X.9). Single-kind tuple for now; the module future-compats if AWS / OpenAI / Anthropic introduce semantically-equivalent kinds (e.g., `state_conflict_error`, `idempotency_conflict_error`).

### 2. Bedrock — `BedrockError` extensions

- Added `conflict_error` to `BEDROCK_ERROR_KINDS`.
- `classifyHttpStatus(409)` now returns `conflict_error` (was `unknown_error`).
- `CODE_TO_KIND["ConflictException"] = "conflict_error"`.
- `conflict_error` is **NOT** in `RETRYABLE_KINDS` — state conflicts are terminal; operator must reconcile state.

### 3. OpenAI + Anthropic — error-table extensions

Same pattern as Bedrock but lighter-touch:
- Added `conflict_error` to `OPENAI_ERROR_KINDS` + `ANTHROPIC_ERROR_KINDS`.
- `classifyHttpStatus(409)` returns `conflict_error` on both.
- No code-to-kind map updates (OpenAI's typed `error.type` doesn't currently include `conflict_error`; Anthropic's typed `error.type` doesn't either; the HTTP-status mapping carries them).
- Neither provider currently includes `conflict_error` in their RETRYABLE_KINDS sets.

### 4. Existing test updates

Two M2.X.5.aa.z.5 / M2.X.5.aa.z.6 tests previously asserted `.code === "ConflictException"` without specifying `.kind` (because `kind` was `unknown_error` — the placeholder the ADRs called out). Both tests now also assert `kind: "conflict_error"`.

## Cross-cutting invariants enforced

- **Same shape as the prior three classifiers.** KINDS tuple + predicate + discriminator. Operators learning one know all four.
- **Duck-typed on `.kind`.** No provider class dependency at the kernel layer.
- **conflict_error is NOT retryable.** State conflicts indicate the operator's intent is incompatible with current resource state — retrying with the same input never succeeds.
- **conflict_error is NOT a moderation kind.** Distinct category.
- **conflict_error is NOT an input-too-large kind.** Distinct category.
- **conflict_error is NOT invalid_request_error.** State conflict ≠ structural request error. `invalid_request_error` means "your request was structurally wrong"; `conflict_error` means "your request was valid but the resource state forbids it."
- **conflict_error is NOT not_found_error.** Adjacent but distinct — 404 means the resource doesn't exist; 409 means it does but is in the wrong state.
- **Single-kind tuple today.** The module future-compats additional sub-types without breaking call sites.

## End-to-end semantic

```ts
import { isConflictError, isRetryableError } from "@crossengin/ai-providers";

// Operator's stopBatch wrapper that's robust to "job already terminal" races.
async function safeStop(provider: BedrockProvider, jobId: string): Promise<void> {
  try {
    await provider.stopBatch(jobId);
  } catch (err) {
    if (isConflictError(err)) {
      // Job became terminal between poll + stop — safe to ignore.
      return;
    }
    if (isRetryableError(err)) {
      // Backoff + retry.
      await sleep(1000);
      return safeStop(provider, jobId);
    }
    throw err;
  }
}

// Cross-provider createBatch wrapper that handles idempotency-token reuse cleanly.
async function createOrLookup(
  provider: BedrockProvider,
  input: BedrockCreateBatchInput,
): Promise<BedrockBatchJobDetail> {
  try {
    const { jobArn } = await provider.createBatch(input);
    return provider.getBatch(jobArn);
  } catch (err) {
    if (isConflictError(err)) {
      // Re-submitted same clientRequestToken with different body — find the prior job.
      const existing = await provider.listBatches({ nameContains: input.jobName });
      if (existing.invocationJobSummaries.length > 0) {
        return provider.getBatch(existing.invocationJobSummaries[0]!.jobArn);
      }
    }
    throw err;
  }
}
```

## Alternatives considered

- **Wait for a third 409-emitting endpoint before lifting to the kernel.**
  - **Considered.** ADR-0107 took this stance; ADR-0108 noted the trigger was now met but deferred to a dedicated milestone.
  - **Cons.** Two endpoints + active operator demand justifies the lift. Holding longer leaves operators discriminating on `.code === "ConflictException"` — brittle to AWS code-name changes.
  - **Decision.** Ship now.

- **Use a tuple with both `conflict_error` and `state_conflict_error` from the start.**
  - **Considered.** Forward-compat for finer-grained classifications.
  - **Cons.** YAGNI — no provider currently distinguishes "this is a state conflict" from "this is a uniqueness conflict" at the kind level. Adding speculative kinds pollutes the API.
  - **Decision.** Single kind. Add more when a provider distinguishes.

- **Add `conflict_error` to `RETRYABLE_KINDS`.**
  - **Considered.** Some idempotency-token reuse conflicts ARE transient (e.g., AWS internal-state race).
  - **Cons.** Conflating "you should retry this" with "you should reconcile state" leads operators into infinite-retry loops. Auto-retry on 409 masks legitimate "the job already exists" semantics.
  - **Decision.** Not retryable. Operators wanting "retry on transient 409" implement their own policy.

- **Merge `conflict_error` into `invalid_request_error`.**
  - **Considered.** Operators rarely need finer-grained classification.
  - **Cons.** A bad request body vs a state conflict require different operator responses — one's "fix your code", the other's "fix your data". Merging loses information.
  - **Decision.** Keep separate.

- **Skip the kernel module; have each provider expose its own `isXConflictError`.**
  - **Considered.** Localizes the classifier to its provider.
  - **Cons.** Defeats the purpose of cross-provider error classifiers — operators writing `catch (err)` blocks shouldn't need to import N functions to check one semantic category.
  - **Decision.** Kernel module.

- **Wire conflict-aware retry behavior into `@crossengin/ai-router`.**
  - **Considered.** The router already special-cases moderation + retryable + input-too-large.
  - **Cons.** Router behavior on 409 is per-operator (some want auto-resolve via listBatches, some want immediate failure). Build the classifier first; layer router policy on top later.
  - **Decision.** Classifier only. Router integration in a follow-up if demand surfaces.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 7,218 tests** (+26 from M2.X.12: 21 kernel `conflict.test.ts` + 5 Bedrock `errors.test.ts` `conflict_error` section). All green, zero type errors. Two existing M2.X.5.aa.z.5 / M2.X.5.aa.z.6 tests upgraded to assert the new classified kind.
- **Fourth cross-provider error classifier in the kernel.** `isModerationError`, `isRetryableError`, `isInputTooLargeError`, `isConflictError` — operators have a consistent toolkit.
- **Two existing Bedrock tests upgraded.** M2.X.5.aa.z.5 stopBatch + M2.X.5.aa.z.6 createBatch ConflictException tests now assert the classified kind (was placeholder `.code` check).
- **Bedrock RETRYABLE_KINDS unchanged.** `conflict_error` correctly excluded.
- **OpenAI + Anthropic future-compat.** Both providers can now surface 409s in the kernel-recognized shape when AWS-style state conflicts appear in their APIs.
- **Pattern set for future cross-provider classifiers.** A 5th classifier (e.g., `isNotFoundError`?) would follow the same shape if/when demand surfaces.

## Open questions

- **Q1:** Should `isNotFoundError` be lifted to the kernel next?
  - _Current direction:_ All three providers already use `not_found_error`. Lifting it to the kernel is mechanical. Add when an operator catch-block actually needs the cross-provider check.
- **Q2:** Should `@crossengin/ai-router` special-case `isConflictError` (e.g., short-circuit retry chain)?
  - _Current direction:_ Yes — same as the M6.6 special-casing for moderation errors. Deferred to a follow-up.
- **Q3:** Distinguish "uniqueness conflict" (createBatch jobName clash) from "state conflict" (stopBatch already-terminal)?
  - _Current direction:_ Both fit `conflict_error` semantically. AWS doesn't distinguish them in the `__type` field. If a third sub-class emerges (e.g., idempotency conflict), add a new kind.
- **Q4:** Should `OpenAIError.code` enumerate documented OpenAI conflict types (e.g., `assistants.run.conflict`)?
  - _Current direction:_ Watch the OpenAI API surface. The current kernel surface is HTTP-status-based; if OpenAI ships a typed `error.type: "conflict_error"` they'd auto-map via the existing `TYPE_TO_KIND` table.
- **Q5:** Should the M2.X.5.aa.z.5 / M2.X.5.aa.z.6 ADRs be retroactively updated to remove the "deferred until second 409-emitting endpoint" caveat?
  - _Current direction:_ No. Per ADR convention (`docs/adr/0118-...`), this ADR supersedes the deferral; old ADRs are not rewritten.
- **Q6:** Add a `conflict_error` to Anthropic's `TYPE_TO_KIND` discriminator?
  - _Current direction:_ No mapping needed yet — Anthropic doesn't emit `error.type: "conflict_error"`. The HTTP-status path covers them.
