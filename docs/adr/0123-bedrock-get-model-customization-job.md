# ADR-0123: Bedrock getModelCustomizationJob with training/validation detail (Phase 2 M2.X.5.aa.z.18)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0116 (M2.X.5.aa.z.14 getCustomModel), ADR-0121 (M2.X.5.aa.z.16 getModelImportJob), ADR-0122 (M2.X.5.aa.z.17 listModelCustomizationJobs) |

## Context

M2.X.5.aa.z.17 shipped `listModelCustomizationJobs` returning summaries — enough for pipeline-health monitoring + failure triage at the roster level, but not enough for the actual diagnostic step. The customization job is structurally the richest write surface on Bedrock's control plane: it carries training data, validation data, output location, hyperparameters, metrics, IAM role, KMS key, VPC config, and distillation lineage (for DISTILLATION jobs).

Operators reaching for `getModelCustomizationJob` are doing one of:

1. **Reproducibility audit.** Extract hyperParameters + training data S3 URI to replay a fine-tune.
2. **Failure triage.** Read `failureMessage` to understand why a fine-tune broke.
3. **Compliance review.** Verify `outputModelKmsKeyArn` + `vpcConfig` match policy.
4. **Cost review.** Compute training duration (`creationTime` → `endTime`).
5. **Distillation lineage.** For DISTILLATION jobs, identify the teacher model + max response length.

`GetModelCustomizationJob` is the AWS endpoint. Structurally analogous to `GetCustomModel` (M2.X.5.aa.z.14) — same nested sub-shapes (S3Config, ValidationDataConfig, TrainingMetrics, ValidationMetric, TeacherModelConfig, DistillationConfig, CustomizationConfig, VpcConfig).

## Decision

One new provider method + 8 new typed sub-shapes in `model-customization-jobs-api.ts`.

### 1. `BedrockProvider.getModelCustomizationJob(jobIdentifier)`

```ts
async getModelCustomizationJob(
  jobIdentifier: string,
): Promise<BedrockModelCustomizationJobDetail>;
```

- Validates `jobIdentifier` non-empty BEFORE the fetch.
- URI-encodes the identifier (handles ARN colons → `%3A`).
- GETs `/model-customization-jobs/{encoded}` via the existing `signedControlPlaneGet` helper.
- Parses via `parseModelCustomizationJobDetail`.

### 2. Typed nested model

`BedrockModelCustomizationJobDetail` has 9 required top-level fields + 13 optional. Nested types model AWS's contract verbatim:

```ts
export interface BedrockModelCustomizationJobDetail {
  // required (9)
  readonly jobArn: string;
  readonly jobName: string;
  readonly outputModelName: string;
  readonly roleArn: string;
  readonly status: BedrockModelCustomizationJobStatus;
  readonly creationTime: string;
  readonly baseModelArn: string;
  readonly trainingDataConfig: BedrockModelCustomizationJobS3Config;
  readonly outputDataConfig: BedrockModelCustomizationJobS3Config;
  // optional (13)
  readonly outputModelArn?: string;
  readonly clientRequestToken?: string;
  readonly failureMessage?: string;
  readonly lastModifiedTime?: string;
  readonly endTime?: string;
  readonly hyperParameters?: Readonly<Record<string, string>>;
  readonly validationDataConfig?: BedrockModelCustomizationJobValidationDataConfig;
  readonly customizationType?: string;
  readonly outputModelKmsKeyArn?: string;
  readonly trainingMetrics?: BedrockModelCustomizationJobTrainingMetrics;
  readonly validationMetrics?: readonly BedrockModelCustomizationJobValidationMetric[];
  readonly vpcConfig?: BedrockModelCustomizationJobVpcConfig;
  readonly customizationConfig?: BedrockModelCustomizationJobCustomizationConfig;
}
```

### 3. Field naming asymmetry vs summary preserved

| Concept | Summary (list) | Detail (get) |
|---|---|---|
| Resulting custom model ARN | `customModelArn` | `outputModelArn` |
| Resulting custom model name | `customModelName` | `outputModelName` |

This is AWS's contract — preserved verbatim. The summary's `customModelName` is populated post-success; the detail's `outputModelName` is the operator's requested name from job creation (required) and `outputModelArn` is populated post-success. Operators map between them at the application layer.

### 4. Nested types live under `BedrockModelCustomizationJob*` prefix

The 8 new sub-shapes structurally mirror M2.X.5.aa.z.14's `BedrockCustomModel*` types but are NOT shared:
- `BedrockModelCustomizationJobS3Config`, Validator, ValidationDataConfig, TrainingMetrics, ValidationMetric, VpcConfig, TeacherModelConfig, DistillationConfig, CustomizationConfig.

Same trade-off as ADR-0121 Q6: preserving AWS's API contract verbatim avoids cross-coupling. If AWS diverges these shapes in a future revision, the kernel doesn't have to refactor a shared type.

### 5. `parseModelCustomizationJobDetail(raw)`

Strict parser:
- 9 required top-level fields throw `BedrockError api_error` on missing/wrong-type.
- `status` validated against M2.X.5.aa.z.17's 5-value tuple (mixed-case `InProgress|Completed|Failed|Stopping|Stopped`).
- Each sub-object parsed via its own helper; missing required nested fields throw with localized error messages.
- `hyperParameters` enforced as `Record<string, string>` matching AWS wire contract.
- `trainingLoss` + `validationLoss` validated finite-number (NaN/Infinity throw).
- `vpcConfig.subnetIds` + `vpcConfig.securityGroupIds` validated as `string[]`.

## Cross-cutting invariants enforced

- **Fifth extended-shape detail instance.** Follows Guardrail (M2.X.5.aa.z.8), ImportedModel (M2.X.5.aa.z.12), CustomModel (M2.X.5.aa.z.14), ModelImportJob (M2.X.5.aa.z.16). Pattern fully stable.
- **Reuses M2.X.5.aa.z.3 transport rail.** No transport changes.
- **Reuses M2.X.5.aa.z.17 status tuple.** Single source of truth for valid status values.
- **Boundary validation BEFORE network.** Empty identifier fast-fails.
- **Strict nested parsing.** Each sub-object validates independently.
- **Forward-compat preserved.** `customizationType` stays string; `customizationConfig` wraps distillation-specific config so AWS can add adapter / RLHF configs without breaking the kernel.
- **No kernel changes.** `LlmProvider` interface unchanged.
- **Backwards compat preserved.** No M2.X.5.aa.z.17 tests changed; only additions.

## End-to-end semantic

```ts
const provider = new BedrockProvider({ accessKeyId, secretAccessKey, region: "us-east-1" });

// Reproducibility audit.
const detail = await provider.getModelCustomizationJob("abc");
const config = {
  baseModelArn: detail.baseModelArn,
  trainingData: detail.trainingDataConfig.s3Uri,
  validationData: detail.validationDataConfig?.validators.map((v) => v.s3Uri),
  hyperParameters: detail.hyperParameters,
  customizationType: detail.customizationType,
};

// Failure triage.
const failed = await provider.listModelCustomizationJobs({ statusEquals: "Failed" });
for (const summary of failed.modelCustomizationJobSummaries) {
  const d = await provider.getModelCustomizationJob(summary.jobArn);
  console.error(`${d.jobName}: ${d.failureMessage ?? "no reason given"}`);
}

// Cost / duration review.
const completed = await provider.getModelCustomizationJob("xyz");
if (completed.endTime !== undefined) {
  const ms =
    new Date(completed.endTime).getTime() -
    new Date(completed.creationTime).getTime();
  console.log(`Training took ${(ms / 1000 / 60).toFixed(1)} minutes`);
}

// Distillation lineage.
if (
  detail.customizationConfig?.distillationConfig?.teacherModelConfig !== undefined
) {
  console.log(
    `Distilled from ${detail.customizationConfig.distillationConfig.teacherModelConfig.teacherModelIdentifier}`,
  );
}
```

## Alternatives considered

- **Share nested sub-shapes with `BedrockCustomModel*` (M2.X.5.aa.z.14).**
  - **Considered.** Sub-shapes are structurally identical.
  - **Cons.** Cross-coupling. If AWS diverges them in a future revision (e.g., adds a field to ValidationDataConfig only in GetModelCustomizationJob), the shared type breaks both call sites.
  - **Decision.** Independent types per AWS resource. Same trade-off as ADR-0121 Q6.

- **Auto-fetch the resulting custom model via `getCustomModel(outputModelArn)`.**
  - **Considered.** Operators often want both.
  - **Cons.** Hidden network calls.
  - **Decision.** Operators chain explicitly.

- **Strict validation of `outputModelKmsKeyArn` format (KMS ARN regex).**
  - **Considered.** Catch typos at parse time.
  - **Cons.** AWS-side validation already enforces this.
  - **Decision.** Non-empty validation only.

- **Tolerate non-finite training/validation losses.**
  - **Considered.** Some training runs report Infinity for initial losses.
  - **Cons.** AWS documents losses as finite. Strict matches the documented contract.
  - **Decision.** Strict finite-number validation.

- **Parse `hyperParameters` values as numbers where they look numeric.**
  - **Considered.** Operator convenience.
  - **Cons.** AWS contract is string→string. Inferring types loses information.
  - **Decision.** Preserve AWS's contract.

## Consequences

- **55 packages + 1 app, 120 meta-schema tables, 7,365 tests** (+26 from M2.X.5.aa.z.18: 17 model-customization-jobs-api detail + 9 provider). All green, zero type errors.
- **Bedrock control-plane surface now has 16 of N operations.** listBatches + getBatch + stopBatch + createBatch + listGuardrails + getGuardrail + listInferenceProfiles + getInferenceProfile + listImportedModels + getImportedModel + listCustomModels + getCustomModel + listModelImportJobs + getModelImportJob + listModelCustomizationJobs + getModelCustomizationJob.
- **Customization-job read story complete.** Both enumeration + single-job lookup work.
- **Fifth extended-shape detail instance.** Pattern is now extremely mature across 5 AWS resource types (Guardrail, ImportedModel, CustomModel, ModelImportJob, ModelCustomizationJob).
- **Reproducibility / failure-triage / cost-review / distillation-lineage workflows fully unblocked.** Operators tracking fine-tune pipelines have first-class kernel support.
- **Bedrock module count: 16 (unchanged).** All additions live in the existing `model-customization-jobs-api.ts`.

## Open questions

- **Q1:** `stopModelCustomizationJob(jobIdentifier)`?
  - _Current direction:_ Pairs naturally with the Stopping/Stopped statuses. POST endpoint; mirror of M2.X.5.aa.z.5's stopBatch. Likely next.
- **Q2:** `createModelCustomizationJob`?
  - _Current direction:_ Largest write surface remaining on Bedrock control plane. Substantial body shape (S3 training data, hyperParameters, role ARN, KMS, VPC, tags, customizationConfig for distillation). Defer until authoring workflows demand it.
- **Q3:** Helper `awaitCustomizationCompletion(provider, jobId)`?
  - _Current direction:_ Out of scope. Polling cadence is operator-specific.
- **Q4:** Should the parser unify the field-naming asymmetry (rename `outputModelArn` → `customModelArn` to match summary)?
  - _Current direction:_ No. Preserve AWS's contract verbatim. Operators map at the application layer.
- **Q5:** Cost-tracking integration (M6.7 PostgresCostTracker)?
  - _Current direction:_ Future M6.7 consumes `creationTime` → `endTime` deltas + hyperParameter epochCount for per-tenant fine-tune cost rollups.
- **Q6:** Should `BedrockModelCustomizationJob*` nested types be hoisted to a shared module across packages?
  - _Current direction:_ Watch for actual reuse. Three resources (CustomModel, ModelImportJob, ModelCustomizationJob) share VpcConfig + S3Config shapes; if a fourth surfaces, consider a `shared-sub-types.ts` consolidation.
- **Q7:** Status-aware polling helper (skip lookup if status is terminal)?
  - _Current direction:_ Operator-side workflow concern; kernel surface stays plain.
