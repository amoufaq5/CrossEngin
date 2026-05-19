# ADR-0117: Bedrock listModelImportJobs — sixth control-plane enumeration (Phase 2 M2.X.5.aa.z.15)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0113 (M2.X.5.aa.z.11 listImportedModels), ADR-0114 (M2.X.5.aa.z.12 getImportedModel) |

## Context

`BedrockImportedModelDetail` (M2.X.5.aa.z.12) surfaces a `jobArn` field pointing to the ModelImportJob that produced the model. Operators tracking import-pipeline health have NO way to enumerate those jobs without dropping to the AWS SDK / console — they can only look one up by ARN if they already have it.

Three workflows demand enumeration:

1. **Pipeline health monitoring.** "How many import jobs are InProgress / Completed / Failed right now?"
2. **Failure triage.** `statusEquals=Failed` enumerates broken imports for re-running or cleanup.
3. **Pipeline throughput analysis.** Time-range filters + status filtering surface "we processed N successful imports last week."

M2.X.5.aa.z.15 ships `listModelImportJobs()` — the sixth paginated control-plane enumeration. Structurally identical to `listImportedModels` with the addition of an enumerated status filter.

## Decision

One new module + one new provider method.

### 1. `model-import-jobs-api.ts`

- `BEDROCK_MODEL_IMPORT_JOB_STATUSES` — 3-value tuple matching AWS verbatim: `["InProgress", "Completed", "Failed"]`. Mixed-case (NOT all-caps like guardrails). Case-sensitive discriminator.
- 4 boundary-validation constants (maxResults bounds, nameContains length bounds).
- `BEDROCK_MODEL_IMPORT_JOB_SORT_BY_VALUES` — `["CreationTime"]`.
- `BEDROCK_MODEL_IMPORT_JOB_SORT_ORDER_VALUES` — `["Ascending", "Descending"]`.
- `BedrockModelImportJobSummary` — 4 required fields (jobArn, jobName, status, creationTime) + 4 optional (lastModifiedTime, endTime, importedModelArn, importedModelName).
- `BedrockModelImportJobListResponse` — `{modelImportJobSummaries, nextToken?}`.
- `buildModelImportJobListQuery(options)` — pure boundary-validator. Validates 8 optional parameters.
- `parseModelImportJobListResponse(raw)` + `parseModelImportJobSummary(raw)` — strict parsers.

### 2. `BedrockProvider.listModelImportJobs(options?)`

```ts
async listModelImportJobs(options: BedrockListModelImportJobsOptions = {}): Promise<BedrockModelImportJobListResponse>;
```

- Validates options via `buildModelImportJobListQuery`.
- GETs `/model-import-jobs?...` via the existing `signedControlPlaneGet` helper.
- Parses JSON via `parseModelImportJobListResponse`.

### 3. importedModelArn + importedModelName are OPTIONAL in summaries

AWS only populates these fields when the job succeeded (status = `Completed`). InProgress / Failed jobs return summaries WITHOUT them. The kernel mirrors this — optional fields, parsed when present.

This is the second AWS asymmetry the kernel preserves verbatim: `BedrockCustomModelSummary.modelStatus` was similarly optional (M2.X.5.aa.z.13).

## Cross-cutting invariants enforced

- **Sixth enumeration on the same rail.** `signedControlPlaneGet` unchanged.
- **Mixed-case status tuple preserved verbatim.** `InProgress | Completed | Failed` — case-sensitive validation.
- **Conditional-presence optional fields.** `importedModelArn` / `importedModelName` only populated post-success; kernel parses both correctly.
- **Boundary validation BEFORE network.** Eight optional parameters validated upfront.
- **Provider-native pagination.** AWS's opaque `nextToken` preserved as-is.
- **No kernel changes.** `LlmProvider` interface unchanged.
- **Backwards compat preserved.** No prior tests changed; only additions.

## End-to-end semantic

```ts
const provider = new BedrockProvider({ accessKeyId, secretAccessKey, region: "us-east-1" });

// Pipeline health: count jobs by status.
const counts: Record<string, number> = { InProgress: 0, Completed: 0, Failed: 0 };
let cursor: string | undefined;
do {
  const page = await provider.listModelImportJobs({
    maxResults: 100,
    ...(cursor !== undefined ? { nextToken: cursor } : {}),
  });
  for (const job of page.modelImportJobSummaries) {
    counts[job.status] = (counts[job.status] ?? 0) + 1;
  }
  cursor = page.nextToken;
} while (cursor !== undefined);

// Failure triage: enumerate broken imports.
const failed = await provider.listModelImportJobs({
  statusEquals: "Failed",
  sortBy: "CreationTime",
  sortOrder: "Descending",
});
for (const job of failed.modelImportJobSummaries) {
  console.log(`Failed import: ${job.jobName} at ${job.creationTime}`);
}

// Successful imports last week → list the resulting imported models.
const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
const recent = await provider.listModelImportJobs({
  statusEquals: "Completed",
  creationTimeAfter: since,
});
const newModels = recent.modelImportJobSummaries
  .map((j) => j.importedModelArn)
  .filter((arn): arn is string => arn !== undefined);
```

## Alternatives considered

- **Combine with listImportedModels into a single method that returns both jobs + models.**
  - **Considered.** Operators often want both.
  - **Cons.** Different AWS endpoints, different filter parameters, different cost classes. Combining hides those.
  - **Decision.** Two methods. Operators compose.

- **Auto-cross-reference: when a job summary has `importedModelArn`, eagerly fetch the imported model detail.**
  - **Considered.** Convenience.
  - **Cons.** Hidden network calls + cost. Operators making bulk lists shouldn't pay for N detail calls they didn't request.
  - **Decision.** Plain summary list. Operators call `getImportedModel(arn)` explicitly when needed.

- **Auto-poll a specific job until terminal.**
  - **Considered.** Common operator workflow.
  - **Cons.** Polling cadence + retry policy is operator-specific. The plain list is composable.
  - **Decision.** No polling helper.

- **Enumerate `Stopped` / `Stopping` as additional valid statuses (for forward-compat).**
  - **Considered.** Maybe AWS will add them.
  - **Cons.** AWS currently documents only 3 statuses. Enumerating speculative future values pollutes the API.
  - **Decision.** Three documented values only. Add more when AWS does.

- **Validate that `importedModelArn` is present iff `status === "Completed"`.**
  - **Considered.** Catch AWS API drift at parse time.
  - **Cons.** AWS might populate `importedModelArn` for in-progress jobs in the future. Conservative parsing accepts what AWS sends.
  - **Decision.** Optional fields parsed independently.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 7,192 tests** (+35 from M2.X.5.aa.z.15: 27 model-import-jobs-api + 8 provider). All green, zero type errors.
- **Bedrock control-plane surface now has 13 of N operations.** listBatches + getBatch + stopBatch + createBatch + listGuardrails + getGuardrail + listInferenceProfiles + getInferenceProfile + listImportedModels + getImportedModel + listCustomModels + getCustomModel + listModelImportJobs.
- **Bedrock module count: 15.** `model-import-jobs-api.ts` added.
- **Pipeline-health monitoring unblocked.** Status-bucketed counts now derivable.
- **Failure-triage workflows enabled.** `statusEquals=Failed` filter surfaces broken imports.
- **Throughput analysis enabled.** Time-range + status filters compose.
- **Sixth paginated enumeration with identical shape.** The boundary-validator + strict-parser pattern is now extremely stable.

## Open questions

- **Q1:** `getModelImportJob(jobIdentifier)` — detail companion?
  - _Current direction:_ Likely next. AWS's `GetModelImportJob` returns richer fields (modelDataSource.s3DataSource.s3Uri, importedModelKmsKeyArn, jobTags, roleArn, modelKmsKeyArn, vpcConfig, failureMessage). Follows extended-shape pattern.
- **Q2:** `createModelImportJob` for programmatic imports?
  - _Current direction:_ Substantial body shape (S3 source, role ARN, KMS key, VPC config, tags). Defer.
- **Q3:** Should the `failureMessage` be threaded through the list summary?
  - _Current direction:_ AWS only includes it in `GetModelImportJob`. Kernel mirrors AWS.
- **Q4:** Helper to enumerate jobs THEN their resulting models?
  - _Current direction:_ Out of scope. `listModelImportJobs` + map → `getImportedModel` per non-null `importedModelArn` is one operator-side loop.
- **Q5:** Should there be a unified `listAllJobs` across model-import-jobs + model-customization-jobs (proposed M2.X.5.aa.z.16) + model-invocation-jobs (batches)?
  - _Current direction:_ No. AWS keeps them separate; operators compose.
- **Q6:** Should the parser preserve unknown statuses (forward-compat)?
  - _Current direction:_ Strict tuple validation. AWS adds rarely; strict matches our model.
