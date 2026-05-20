# ADR-0124: Bedrock stopModelCustomizationJob (Phase 2 M2.X.5.aa.z.19)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0107 (M2.X.5.aa.z.5 stopBatch), ADR-0118 (M2.X.12 conflict_error), ADR-0122 (M2.X.5.aa.z.17 listModelCustomizationJobs), ADR-0123 (M2.X.5.aa.z.18 getModelCustomizationJob) |

## Context

M2.X.5.aa.z.17 / M2.X.5.aa.z.18 closed the customization-job READ surface (list + get). The 5-value status tuple includes `Stopping` + `Stopped` — operator-initiated mid-training aborts — but the kernel had no method to TRIGGER that state transition. Operators detecting a runaway fine-tune (wrong hyperparameters, wrong dataset, budget overrun) had to drop down to the AWS SDK / console.

`StopModelCustomizationJob` is AWS's POST endpoint. M2.X.5.aa.z.19 closes the gap.

Structurally identical to M2.X.5.aa.z.5's `stopBatch`:
- POST with empty body.
- No request parameters beyond the path identifier.
- 200 success returns empty body.
- 409 ConflictException for terminal-state jobs (operator polled too late).

The M2.X.12 `conflict_error` classifier (ADR-0118) is now load-bearing: this is the third Bedrock endpoint that emits 409 (after stopBatch + createBatch). Operators using `isConflictError(err)` get clean cross-provider state-conflict detection.

## Decision

One new provider method.

### `BedrockProvider.stopModelCustomizationJob(jobIdentifier)`

```ts
async stopModelCustomizationJob(jobIdentifier: string): Promise<void>;
```

- Validates `jobIdentifier` non-empty BEFORE the fetch.
- URI-encodes the identifier (handles ARN colons → `%3A`).
- POSTs an empty body to `/model-customization-jobs/{encoded}/stop` via the existing `signedControlPlanePost` helper from M2.X.5.aa.z.5.
- Returns `void` on success.

No new types, no new module, no new transport. Pure reuse of the established stopBatch shape.

### Error mapping

- `200 / empty body` → resolve void.
- `400 ValidationException` → `invalid_request_error`.
- `403 AccessDeniedException` → `permission_error`.
- `404 ResourceNotFoundException` → `not_found_error`.
- `409 ConflictException` (job already in terminal state) → `conflict_error` (via M2.X.12 mapping in `errors.ts` CODE_TO_KIND).
- `429 ThrottlingException` → `rate_limit_error`.
- Network → `network_error` / `timeout_error`.

## Cross-cutting invariants enforced

- **Pure reuse of established rails.** `signedControlPlanePost` (M2.X.5.aa.z.5) called unchanged; `isBedrockModelCustomizationJobStatus` tuple unchanged.
- **conflict_error classifier load-bearing.** Third Bedrock endpoint surfacing 409 — operators can write a single `catch (err) { if (isConflictError(err)) ignoreOrReconcile() }` block that handles stopBatch + createBatch + stopModelCustomizationJob uniformly.
- **Boundary validation BEFORE network.** Empty identifier fast-fails.
- **No kernel changes.** `LlmProvider` interface unchanged.
- **Backwards compat preserved.** No prior tests changed; only additions.

## End-to-end semantic

```ts
import { isConflictError } from "@crossengin/ai-providers";

const provider = new BedrockProvider({ accessKeyId, secretAccessKey, region: "us-east-1" });

// Cost-runaway kill switch for fine-tunes.
async function killIfRunaway(jobId: string, maxDurationMs: number): Promise<void> {
  const detail = await provider.getModelCustomizationJob(jobId);
  if (detail.status === "InProgress") {
    const elapsed = Date.now() - new Date(detail.creationTime).getTime();
    if (elapsed > maxDurationMs) {
      try {
        await provider.stopModelCustomizationJob(jobId);
        logger.warn({ jobId, elapsed }, "stopped runaway fine-tune");
      } catch (err) {
        if (isConflictError(err)) {
          // Job became terminal between get + stop — safe to ignore.
        } else {
          throw err;
        }
      }
    }
  }
}

// Tenant-offboarding sweep.
async function cancelTenantFineTunes(tenantPrefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await provider.listModelCustomizationJobs({
      nameContains: tenantPrefix,
      statusEquals: "InProgress",
      ...(cursor !== undefined ? { nextToken: cursor } : {}),
    });
    for (const job of page.modelCustomizationJobSummaries) {
      await provider.stopModelCustomizationJob(job.jobArn);
    }
    cursor = page.nextToken;
  } while (cursor !== undefined);
}
```

## Alternatives considered

- **Add a `force` parameter that retries on 409.**
  - **Considered.** Some operators expect "stop or confirm stopped" semantics.
  - **Cons.** Hidden retry logic. Operators wanting idempotency wrap themselves (as in the example above).
  - **Decision.** No retry. Operators discriminate on `isConflictError`.

- **Return the post-stop status (poll + return).**
  - **Considered.** Confirms the transition succeeded.
  - **Cons.** AWS returns empty body. Polling for status is a separate operator concern.
  - **Decision.** Return `void`. Operators call `getModelCustomizationJob` if they want confirmation.

- **Add `stopAllCustomizationJobs({nameContains, statusEquals})` convenience.**
  - **Considered.** Tenant-offboarding is the primary use case.
  - **Cons.** The 10-line loop above is composable + reviewable. Convenience wrappers hide important error-handling decisions.
  - **Decision.** Operators write the loop.

- **Validate `jobIdentifier` against a Bedrock customization-job ARN regex.**
  - **Considered.** Catch typos at boundary.
  - **Cons.** AWS accepts both bare jobIdentifier strings and full ARNs. Regex would over-constrain.
  - **Decision.** Non-empty validation only. AWS surfaces 404 on bad identifiers.

- **Emit a `model_customization_stopped` event into the workflow instrumentation rail (M8).**
  - **Considered.** Cross-surface observability.
  - **Cons.** Mixing Bedrock provider events into workflow runtime instrumentation conflates two surfaces. Operators wanting cross-surface tracing wire their own observability shim.
  - **Decision.** No cross-surface event.

## Consequences

- **55 packages + 1 app, 120 meta-schema tables, 7,376 tests** (+11 from M2.X.5.aa.z.19: all in provider.test.ts). All green, zero type errors.
- **Bedrock control-plane surface now has 17 of N operations.** listBatches + getBatch + stopBatch + createBatch + listGuardrails + getGuardrail + listInferenceProfiles + getInferenceProfile + listImportedModels + getImportedModel + listCustomModels + getCustomModel + listModelImportJobs + getModelImportJob + listModelCustomizationJobs + getModelCustomizationJob + stopModelCustomizationJob.
- **Customization-job read + write surface now feature-equivalent to batch surface** (M2.X.5.aa.z.3–.6 shipped batch list/get/stop/create; this milestone closes the equivalent stop for customization jobs).
- **Third Bedrock 409-emitting endpoint live.** `isConflictError` (M2.X.12) now has three sources from a single provider; the cross-provider classifier earns its keep.
- **Three operational workflows unblocked.** Cost-runaway kill switches for fine-tunes (detect long-running InProgress → stop), tenant-offboarding fine-tune cancellation sweeps (paired with listModelCustomizationJobs({nameContains}) + status filter), compliance kill switches (new policy lands → stop in-flight fine-tunes that may violate it).

## Open questions

- **Q1:** `createModelCustomizationJob`?
  - _Current direction:_ Largest write surface remaining on Bedrock control plane. Substantial body shape (S3 training data, hyperParameters map, role ARN, KMS, VPC, tags, customizationConfig for distillation, jobName, baseModelIdentifier, customModelName, customModelKmsKeyArn, validationDataConfig). Defer until authoring workflows demand it.
- **Q2:** `deleteCustomModel` / `deleteImportedModel`?
  - _Current direction:_ Wait for operator demand. Tenant cleanup is the primary motivation; less urgent than the read + abort surface.
- **Q3:** Should the kernel surface a `cancelTenantCustomizationJobs(tenantPrefix)` helper?
  - _Current direction:_ No. 10-line operator loop is composable + reviewable.
- **Q4:** Cost-attribution integration — should stopped jobs report partial-cost accumulation?
  - _Current direction:_ Out of scope. AWS bills per training time; M6.7 (PostgresCostTracker, proposed) consumes creationTime → endTime deltas.
- **Q5:** Should there be parallel `stopModelImportJob` for import jobs?
  - _Current direction:_ AWS doesn't expose one — model import jobs are designed to be fast (minutes). If AWS ships StopModelImportJob, kernel adds it then.
- **Q6:** Should `stopModelCustomizationJob` be idempotent (return success on 409)?
  - _Current direction:_ No. Surface 409 verbatim so operators discriminate via `isConflictError`.
