# ADR-0131: Bedrock createModelCustomizationJob — programmatic fine-tunes (Phase 2 M2.X.5.aa.z.20)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0108 (M2.X.5.aa.z.6 createBatch), ADR-0122 (M2.X.5.aa.z.17 listModelCustomizationJobs), ADR-0123 (M2.X.5.aa.z.18 getModelCustomizationJob), ADR-0124 (M2.X.5.aa.z.19 stopModelCustomizationJob) |

## Context

After M2.X.5.aa.z.19, the model-customization-job surface had list + get + stop but no create. Operators submitting fine-tune jobs programmatically had to drop down to AWS SDK / console. M2.X.5.aa.z.20 closes the gap — `BedrockProvider.createModelCustomizationJob(input)` completes the customization-job CRUD.

This is the **largest write surface** on Bedrock's control plane. The body shape includes:

- 7 required fields: `jobName`, `customModelName`, `roleArn`, `baseModelIdentifier`, `trainingDataConfig`, `outputDataConfig`, `hyperParameters`.
- 8 optional fields: `clientRequestToken`, `customizationType`, `customModelKmsKeyId` (note: AWS uses `KmsKeyId` here, not `KmsKeyArn` — preserving AWS contract verbatim), `customModelTags`, `jobTags`, `validationDataConfig`, `vpcConfig`, `customizationConfig` (for DISTILLATION).
- 12 documented validation rules.

Structurally identical to `createBatch` (M2.X.5.aa.z.6) with fine-tune-specific extensions: separate jobTags + customModelTags arrays, validators array (max 10), customizationConfig for DISTILLATION teacher-model lineage.

## Decision

One new provider method + extensive boundary-validation in the existing `model-customization-jobs-api.ts` module.

### 1. `BedrockProvider.createModelCustomizationJob(input)`

```ts
async createModelCustomizationJob(
  input: BedrockCreateModelCustomizationJobInput,
): Promise<BedrockCreateModelCustomizationJobResponse>;
```

- Validates `input` via `buildCreateModelCustomizationJobBody` (throws `BedrockError invalid_request_error` BEFORE the fetch on any rule violation).
- POSTs the validated JSON body via `signedControlPlanePost` to `/model-customization-jobs`.
- Parses via `parseCreateModelCustomizationJobResponse` (returns `{jobArn}`).

### 2. `BedrockCreateModelCustomizationJobInput` shape

```ts
export interface BedrockCreateModelCustomizationJobInput {
  // required (7)
  readonly jobName: string;
  readonly customModelName: string;
  readonly roleArn: string;
  readonly baseModelIdentifier: string;
  readonly trainingDataConfig: BedrockModelCustomizationJobS3Config;
  readonly outputDataConfig: BedrockModelCustomizationJobS3Config;
  readonly hyperParameters: Readonly<Record<string, string>>;
  // optional (8)
  readonly clientRequestToken?: string;
  readonly customizationType?: string;
  readonly customModelKmsKeyId?: string;
  readonly customModelTags?: ReadonlyArray<BedrockModelCustomizationJobTag>;
  readonly jobTags?: ReadonlyArray<BedrockModelCustomizationJobTag>;
  readonly validationDataConfig?: BedrockModelCustomizationJobValidationDataConfig;
  readonly vpcConfig?: BedrockModelCustomizationJobVpcConfig;
  readonly customizationConfig?: BedrockModelCustomizationJobCustomizationConfig;
}
```

Reuses 5 sub-types defined in M2.X.5.aa.z.18 (`S3Config`, `ValidationDataConfig`, `VpcConfig`, `CustomizationConfig`, `Validator`). Adds one new type: `BedrockModelCustomizationJobTag = {key, value}` (parallel to M2.X.5.aa.z.6's `BedrockBatchTag`).

### 3. Boundary validation rules

| Field | Constraint | Constant |
|---|---|---|
| `jobName` length | `[1, 63]` | `BEDROCK_MODEL_CUSTOMIZATION_JOB_NAME_MAX_LEN` |
| `jobName` pattern | `^[a-zA-Z0-9](-*[a-zA-Z0-9])*$` | `BEDROCK_MODEL_CUSTOMIZATION_JOB_NAME_PATTERN` |
| `customModelName` length + pattern | same as jobName | shared constant |
| `roleArn` pattern | AWS-partition-aware IAM | `BEDROCK_MODEL_CUSTOMIZATION_ROLE_ARN_PATTERN` |
| `baseModelIdentifier` length | `[1, 2048]` | `BEDROCK_MODEL_CUSTOMIZATION_BASE_MODEL_ID_MAX_LEN` |
| `trainingDataConfig.s3Uri` pattern | `^s3://[a-z0-9.\-_]{1,255}/.*$` | `BEDROCK_MODEL_CUSTOMIZATION_S3_URI_PATTERN` |
| `outputDataConfig.s3Uri` pattern | same | shared constant |
| `hyperParameters` | object of `string → string` | enforced via per-value typeof check |
| `clientRequestToken` length | `[1, 256]` | `BEDROCK_MODEL_CUSTOMIZATION_CLIENT_REQUEST_TOKEN_MAX_LEN` |
| `clientRequestToken` pattern | same as jobName | shared constant |
| `customModelKmsKeyId` | non-empty when provided | n/a (any-shape) |
| `customModelTags` / `jobTags` count | `≤ 200` | `BEDROCK_MODEL_CUSTOMIZATION_MAX_TAGS` |
| `tag.key` length | `[1, 128]` | `BEDROCK_MODEL_CUSTOMIZATION_TAG_KEY_MAX_LEN` |
| `tag.value` length | `[0, 256]` | `BEDROCK_MODEL_CUSTOMIZATION_TAG_VALUE_MAX_LEN` |
| `validationDataConfig.validators` count | `≤ 10` | `BEDROCK_MODEL_CUSTOMIZATION_MAX_VALIDATORS` |
| validator `s3Uri` pattern | same as data configs | shared constant |
| `vpcConfig.subnetIds` count | `[1, 16]` | `BEDROCK_MODEL_CUSTOMIZATION_VPC_MAX_ENTRIES` |
| `vpcConfig.securityGroupIds` count | `[1, 16]` | shared constant |

All ARN patterns AWS-partition-aware (aws, aws-us-gov, aws-cn) per the M2.X.5.aa.z.4 convention.

### 4. AWS contract preservation

- `customModelKmsKeyId` (NOT `customModelKmsKeyArn`): AWS uses `KmsKeyId` in CreateModelCustomizationJob but `KmsKeyArn` in GetModelCustomizationJob. Kernel preserves both verbatim — operators map at the application layer.
- `customizationType` as string (forward-compat): AWS adds new types regularly (DISTILLATION was added recently).
- `outputModelName` from `getModelCustomizationJob` ≠ `customModelName` from `createModelCustomizationJob`: per ADR-0123, AWS field-naming asymmetry between create and get is preserved verbatim.

### 5. Response

`BedrockCreateModelCustomizationJobResponse = {jobArn}`. AWS returns just the ARN; operators wanting full state call `getModelCustomizationJob(arn)` immediately after.

## Cross-cutting invariants enforced

- **Boundary validation BEFORE network.** All 12+ validation rules fail-fast without burning a request.
- **AWS-partition-aware ARN regexes.** `roleArn` accepts the same three partitions as other write methods.
- **Body builder is pure + exported.** `buildCreateModelCustomizationJobBody` is unit-testable without spinning a provider.
- **Response parser is strict + exported.**
- **Reuses M2.X.5.aa.z.18 nested types.** `S3Config / ValidationDataConfig / VpcConfig / CustomizationConfig` typed once.
- **No kernel changes.** `LlmProvider` interface unchanged.
- **Backwards compat preserved.** No M2.X.5.aa.z.17 / .18 / .19 tests changed; only additions.

## End-to-end semantic

```ts
const provider = new BedrockProvider({ accessKeyId, secretAccessKey, region: "us-east-1" });

// Submit a fine-tune; poll to completion; surface the resulting custom model.
const { jobArn } = await provider.createModelCustomizationJob({
  jobName: "tenant-x-haiku-finetune-2026-05-19",
  customModelName: "tenant-x-haiku-claims-v1",
  roleArn: "arn:aws:iam::123456789012:role/BedrockFineTuneRole",
  baseModelIdentifier:
    "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0:200k",
  trainingDataConfig: { s3Uri: "s3://tenant-x-data/claims/train.jsonl" },
  outputDataConfig: { s3Uri: "s3://tenant-x-data/claims/output/" },
  hyperParameters: {
    epochCount: "10",
    learningRate: "0.0001",
    batchSize: "8",
  },
  validationDataConfig: {
    validators: [{ s3Uri: "s3://tenant-x-data/claims/val.jsonl" }],
  },
  customModelKmsKeyId: "arn:aws:kms:us-east-1:123:key/k1",
  customModelTags: [{ key: "tenant", value: "x" }, { key: "purpose", value: "claims" }],
  jobTags: [{ key: "tenant", value: "x" }],
  customizationType: "FINE_TUNING",
  clientRequestToken: "claims-finetune-2026-05-19",
});

// Poll via getModelCustomizationJob (M2.X.5.aa.z.18).
async function awaitCompletion(arn: string): Promise<BedrockModelCustomizationJobDetail> {
  while (true) {
    const detail = await provider.getModelCustomizationJob(arn);
    if (
      detail.status === "Completed" ||
      detail.status === "Failed" ||
      detail.status === "Stopped"
    ) {
      return detail;
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}
const result = await awaitCompletion(jobArn);
console.log(`Output model: ${result.outputModelArn ?? "n/a"}`);

// Distillation fine-tune.
await provider.createModelCustomizationJob({
  // ...required fields...
  customizationType: "DISTILLATION",
  customizationConfig: {
    distillationConfig: {
      teacherModelConfig: {
        teacherModelIdentifier:
          "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
        maxResponseLengthForInference: 4096,
      },
    },
  },
});
```

## Alternatives considered

- **Combine create + poll into a single `createAndAwaitCustomizationJob` helper.**
  - **Considered.** Polling is the common operator workflow.
  - **Cons.** Polling cadence + timeout policy is operator-specific. The plain `createModelCustomizationJob` + operator-side polling loop is composable.
  - **Decision.** Plain create. Operators write the 10-line polling loop.

- **Auto-populate `clientRequestToken` from a content hash.**
  - **Considered.** Operators want natural idempotency.
  - **Cons.** Hash strategy is operator-specific (full body? body sans timestamps? content-only?).
  - **Decision.** Operators set explicitly when they want idempotency.

- **Validate `hyperParameters` against known Bedrock fine-tune parameters.**
  - **Considered.** Catch typos at boundary.
  - **Cons.** Parameter set varies per base model (Claude vs Llama vs Mistral vs Titan); AWS doesn't expose a stable list.
  - **Decision.** String→string validation only.

- **Tighten `baseModelIdentifier` to a Bedrock model ARN regex.**
  - **Considered.** Catch typos.
  - **Cons.** AWS accepts foundation model IDs, ARNs, inference profile IDs. Permissive length-only is honest.
  - **Decision.** Length-only validation.

- **Map AWS field-naming inconsistencies to a unified kernel field.**
  - **Considered.** `customModelKmsKeyId` (create) vs `customModelKmsKeyArn` (get) is confusing.
  - **Cons.** Preserving AWS contract verbatim avoids translation surprises. Operators reading AWS docs find the same field names.
  - **Decision.** Preserve verbatim.

- **Validate `validationDataConfig.validators` count of EXACTLY one.**
  - **Considered.** Most fine-tunes use a single validation dataset.
  - **Cons.** AWS supports up to 10. Limiting to 1 forces operators wanting multiple to drop down to AWS SDK.
  - **Decision.** Match AWS's documented [0, 10] range.

- **Auto-throw on `customizationType: "DISTILLATION"` without `customizationConfig.distillationConfig`.**
  - **Considered.** Distillation jobs without teacher config will fail server-side.
  - **Cons.** AWS allows the create call (server validates); kernel forcing the relationship would block operators experimenting.
  - **Decision.** Pass through; AWS surfaces validation error if relationship breaks.

## Consequences

- **55 packages + 1 app, 120 meta-schema tables, 7,534 tests** (+31 from M2.X.5.aa.z.20: 21 builder/parser + 10 provider). All green, zero type errors.
- **Bedrock control-plane surface now has 17 of N operations.** (`createBatch` + `stopBatch` + `getBatch` + `listBatches` + 5 guardrail ops + 4 inference-profile + 7 model ops + 7 customization-job ops = mature feature set).
- **Customization-job CRUD complete.** list + get + stop + create — all four operations now have provider methods.
- **Largest Bedrock write surface complete.** No further `create*` endpoint remains for the customization workflow.
- **Three workflows unblocked.** Programmatic fine-tune submission (CI-driven training pipelines), automated retry-on-failure flows (catch + re-submit with adjusted hyperparameters), distillation lineage capture (teacher model + max response length recorded with the job).
- **Bedrock module count: 16 (unchanged).** All additions live in the existing `model-customization-jobs-api.ts`.

## Open questions

- **Q1:** `createBatchInferenceJob` for the batch inference surface (parallel to createModelCustomizationJob)?
  - _Current direction:_ Already shipped as `createBatch` in M2.X.5.aa.z.6. Different surface (model invocation jobs vs customization jobs).
- **Q2:** Helper `awaitFineTuneCompletion(provider, jobArn, opts)` in @crossengin/ai-router?
  - _Current direction:_ Out of scope. Operators write polling loops with their own cadence.
- **Q3:** Should `customizationType` validate against a tuple (FINE_TUNING / CONTINUED_PRE_TRAINING / DISTILLATION)?
  - _Current direction:_ String forward-compat (AWS extends quarterly). Operators check post-hoc.
- **Q4:** Tag conventions — should the kernel surface a `tenant_id` + `purpose` shape requirement?
  - _Current direction:_ Out of scope. Tag policy is operator-specific.
- **Q5:** Cost attribution via tags — should M6.7 (PostgresCostTracker) consume customization-job durations?
  - _Current direction:_ Yes. The `tenant` tag flows through to AWS Cost Explorer; M6.7's `META_LLM_COST_LEDGER` can join.
- **Q6:** Should `customizationConfig.distillationConfig.teacherModelConfig.teacherModelIdentifier` be validated against the available foundation models?
  - _Current direction:_ No. AWS server-side validates.
- **Q7:** Default hyperparameters per base model?
  - _Current direction:_ Out of scope. Operators reading AWS docs supply per-base-model defaults.
