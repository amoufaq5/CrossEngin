# ADR-0122: Bedrock listModelCustomizationJobs — seventh control-plane enumeration (Phase 2 M2.X.5.aa.z.17)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0115 (M2.X.5.aa.z.13 listCustomModels), ADR-0116 (M2.X.5.aa.z.14 getCustomModel), ADR-0117 (M2.X.5.aa.z.15 listModelImportJobs) |

## Context

`BedrockCustomModelDetail` (M2.X.5.aa.z.14) surfaces a `jobArn` field pointing to the `ModelCustomizationJob` that produced the model. M2.X.5.aa.z.15 closed the same gap for `ModelImportJob` (the externally-trained import surface). M2.X.5.aa.z.17 closes the parallel gap for customization jobs (the AWS-native fine-tune / continued-pretrain / distillation surface).

Demand mirrors the import-jobs ADR (ADR-0117):

1. **Pipeline health monitoring.** "How many fine-tunes are InProgress / Completed / Failed / Stopping / Stopped right now?"
2. **Failure triage.** `statusEquals=Failed` enumerates broken customizations for re-running or cleanup.
3. **Throughput analysis.** Time-range + status filters surface "we completed N fine-tunes last week."
4. **Cost attribution.** Customization jobs accrue per-token training cost; enumeration is step one of per-tenant rollups.

Important asymmetry vs import jobs: customization jobs have a richer status vocabulary — they support graceful **Stopping** + **Stopped** (operators can issue `StopModelCustomizationJob` mid-training to abort an expensive fine-tune). Import jobs only have `InProgress | Completed | Failed`.

## Decision

One new module + one new provider method, structurally identical to `listModelImportJobs` (M2.X.5.aa.z.15) but with a 5-value status tuple.

### 1. `model-customization-jobs-api.ts`

- `BEDROCK_MODEL_CUSTOMIZATION_JOB_STATUSES` — 5-value tuple: `InProgress | Completed | Failed | Stopping | Stopped`. Mixed-case (matches AWS verbatim).
- 4 boundary-validation constants (maxResults bounds, nameContains length bounds).
- `BEDROCK_MODEL_CUSTOMIZATION_JOB_SORT_BY_VALUES` (`["CreationTime"]`) + `BEDROCK_MODEL_CUSTOMIZATION_JOB_SORT_ORDER_VALUES` (`["Ascending", "Descending"]`).
- `BedrockModelCustomizationJobSummary` — 5 required fields (jobArn, jobName, baseModelArn, status, creationTime) + 5 optional (lastModifiedTime, endTime, customModelArn, customModelName, customizationType).
- `BedrockModelCustomizationJobListResponse` — `{modelCustomizationJobSummaries, nextToken?}`.
- `buildModelCustomizationJobListQuery(options)` — pure boundary-validator validating 8 optional parameters.
- `parseModelCustomizationJobListResponse(raw)` + `parseModelCustomizationJobSummary(raw)` — strict parsers.

### 2. `BedrockProvider.listModelCustomizationJobs(options?)`

```ts
async listModelCustomizationJobs(options: BedrockListModelCustomizationJobsOptions = {}): Promise<BedrockModelCustomizationJobListResponse>;
```

- Validates options via `buildModelCustomizationJobListQuery`.
- GETs `/model-customization-jobs?...` via the existing `signedControlPlaneGet` helper.
- Parses JSON via `parseModelCustomizationJobListResponse`.

### 3. customizationType preserved as a string

Same forward-compat stance as `BedrockCustomModelSummary.customizationType` (M2.X.5.aa.z.13). AWS documents `FINE_TUNING | CONTINUED_PRE_TRAINING | DISTILLATION` today and ships new types periodically. Strict tuple would be perpetually stale.

### 4. AWS field-name parallelism preserved

`customModelArn` + `customModelName` parallel the `importedModelArn` + `importedModelName` fields on `BedrockModelImportJobSummary`. Both are optional in their respective summaries — populated only post-success per AWS docs. The kernel mirrors AWS verbatim; operators check for `undefined` before using.

## Cross-cutting invariants enforced

- **Seventh paginated enumeration on the same rail.** `signedControlPlaneGet` unchanged.
- **Mixed-case 5-value status tuple preserved verbatim.** Case-sensitive validation throws on `STOPPED` / `stopped`.
- **customizationType stays string.** Forward-compat against AWS additions.
- **Boundary validation BEFORE network.** Eight optional parameters validated upfront.
- **Provider-native pagination.** AWS's opaque `nextToken` preserved.
- **Backwards compat preserved.** No prior tests changed; only additions.

## End-to-end semantic

```ts
const provider = new BedrockProvider({ accessKeyId, secretAccessKey, region: "us-east-1" });

// Pipeline health: bucket by status.
const counts: Record<string, number> = {};
let cursor: string | undefined;
do {
  const page = await provider.listModelCustomizationJobs({
    maxResults: 100,
    ...(cursor !== undefined ? { nextToken: cursor } : {}),
  });
  for (const job of page.modelCustomizationJobSummaries) {
    counts[job.status] = (counts[job.status] ?? 0) + 1;
  }
  cursor = page.nextToken;
} while (cursor !== undefined);

// Failure triage with downstream getCustomModel lookup.
const failed = await provider.listModelCustomizationJobs({ statusEquals: "Failed" });
for (const job of failed.modelCustomizationJobSummaries) {
  // No custom-model exists for failed jobs — operator inspects the job itself.
  console.error(`Failed: ${job.jobName} at ${job.creationTime}`);
}

// Base-model audit: find every customization derived from Claude 3 Haiku.
const haikuRuns = await provider.listModelCustomizationJobs({
  sortBy: "CreationTime",
  sortOrder: "Descending",
});
const haiku = haikuRuns.modelCustomizationJobSummaries.filter(
  (j) => j.baseModelArn.includes("claude-3-haiku"),
);

// Stop-in-progress workflow (paired with future stopModelCustomizationJob).
const inFlight = await provider.listModelCustomizationJobs({ statusEquals: "InProgress" });
// ... iterate + call AWS SDK's StopModelCustomizationJob if kernel adds it.
```

## Alternatives considered

- **Combine `listModelImportJobs` + `listModelCustomizationJobs` into a unified `listJobs` method.**
  - **Considered.** Operators often want a job inventory across both surfaces.
  - **Cons.** Different AWS endpoints, different status vocabularies (3 vs 5 values), different summary shapes. Combining hides those.
  - **Decision.** Two methods. Operators compose if they want unified views.

- **Unify the `Stopping | Stopped` semantics with import jobs (treat as `Failed`).**
  - **Considered.** Cleaner cross-surface comparison.
  - **Cons.** Operator-stopped vs AWS-failed are operationally distinct: the former is intentional, the latter is unexpected. Conflating loses information.
  - **Decision.** Preserve AWS's 5-value vocabulary.

- **Auto-cross-reference: when a job summary has `customModelArn`, eagerly fetch the custom-model detail.**
  - **Considered.** Operators often want both.
  - **Cons.** Hidden network calls. Operators call `getCustomModel(arn)` explicitly when needed.
  - **Decision.** No auto-cross-reference.

- **Validate `baseModelArn` against a documented Bedrock foundation-model regex.**
  - **Considered.** Catch typos at parse time.
  - **Cons.** AWS adds new base models regularly; regex would be perpetually stale.
  - **Decision.** Non-empty validation only.

- **Tolerate missing `baseModelArn` for old jobs.**
  - **Considered.** Older AWS responses might omit it.
  - **Cons.** AWS documents it as required. Strict parsing surfaces drift early.
  - **Decision.** Required.

## Consequences

- **55 packages + 1 app, 120 meta-schema tables, 7,339 tests** (+36 from M2.X.5.aa.z.17: 28 model-customization-jobs-api + 8 provider). All green, zero type errors.
- **Bedrock control-plane surface now has 15 of N operations.** listBatches + getBatch + stopBatch + createBatch + listGuardrails + getGuardrail + listInferenceProfiles + getInferenceProfile + listImportedModels + getImportedModel + listCustomModels + getCustomModel + listModelImportJobs + getModelImportJob + listModelCustomizationJobs.
- **Bedrock module count: 15 → 16.** New `model-customization-jobs-api.ts` added.
- **Seven paginated enumerations now in place across 7 AWS resource types.** The boundary-validator + strict-parser pattern is mature.
- **Customization-job inventory + failure triage workflows fully unblocked.** Operators tracking fine-tune pipelines have first-class kernel support.
- **Stopping/Stopped state machine surfaced.** Operators using `StopModelCustomizationJob` (via AWS SDK or future kernel method) get clean visibility into in-flight cancellations.

## Open questions

- **Q1:** `getModelCustomizationJob(jobIdentifier)` — detail companion?
  - _Current direction:_ Yes, very likely next. AWS's `GetModelCustomizationJob` returns rich detail (includes hyperParameters, trainingDataConfig, validationDataConfig, outputDataConfig, trainingMetrics, validationMetrics — much like `GetCustomModel`). Follows extended-shape pattern.
- **Q2:** `stopModelCustomizationJob(jobIdentifier)`?
  - _Current direction:_ Pairs naturally with the Stopping/Stopped statuses. POST endpoint; mirror of M2.X.5.aa.z.5's stopBatch.
- **Q3:** `createModelCustomizationJob`?
  - _Current direction:_ Substantial body shape (S3 training data, hyperParameters, role ARN, KMS, VPC, tags, customizationConfig for distillation). Largest write surface remaining on Bedrock control plane.
- **Q4:** Cost-tracking integration — should customization-job duration roll up into per-tenant spend?
  - _Current direction:_ Out of scope here. M6.7 (PostgresCostTracker, proposed) would consume `creationTime` → `endTime` deltas for capacity-based billing.
- **Q5:** Should the parser preserve unknown statuses (forward-compat)?
  - _Current direction:_ Strict tuple validation. AWS adds new statuses rarely; strict matches our model and surfaces drift early.
- **Q6:** Add a `statusEqualsIn` filter (multi-status)?
  - _Current direction:_ AWS doesn't expose one. Operators run multiple list calls + merge.
