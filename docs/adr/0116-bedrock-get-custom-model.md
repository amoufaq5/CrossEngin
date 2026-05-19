# ADR-0116: Bedrock getCustomModel with training/validation detail (Phase 2 M2.X.5.aa.z.14)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0110 (M2.X.5.aa.z.8 getGuardrail), ADR-0114 (M2.X.5.aa.z.12 getImportedModel), ADR-0115 (M2.X.5.aa.z.13 listCustomModels) |

## Context

M2.X.5.aa.z.13 shipped `listCustomModels` returning summaries — enough for inventory + base-model audit but not enough for provenance, replay, or quality-of-training analysis. Compliance teams + ML-ops engineers need MORE:

1. **Training-data provenance.** "What dataset trained this model?" — `trainingDataConfig.s3Uri`.
2. **Validation-data provenance.** "What did we validate against?" — `validationDataConfig.validators[].s3Uri`.
3. **Output-artifact location.** "Where did the model artifacts land?" — `outputDataConfig.s3Uri`.
4. **Quality metrics.** "How well did training converge?" — `trainingMetrics.trainingLoss`, `validationMetrics[].validationLoss`.
5. **Hyperparameter reproducibility.** Reproducing or auditing a fine-tune requires the exact hyperparameters (`epochCount`, `learningRate`, `batchSize`, etc.) — `hyperParameters` map.
6. **Distillation lineage.** For DISTILLATION-type customizations: which teacher model was used? — `customizationConfig.distillationConfig.teacherModelConfig`.
7. **KMS-key audit.** Same compliance concern as imported models — `modelKmsKeyArn`.
8. **Customization-job correlation.** Link back to `CreateModelCustomizationJob` for full ML pipeline traceability — `jobArn`.

`GetCustomModel` is structurally analogous to `GetImportedModel` (M2.X.5.aa.z.12) — a rich detail response that extends the summary with provenance / metrics / hyperparameters. Following the extended-shape pattern (vs the type-alias pattern used for batch + inference profile).

## Decision

One new provider method + 8 new nested types in `custom-models-api.ts`.

### 1. `BedrockProvider.getCustomModel(modelIdentifier)`

```ts
async getCustomModel(modelIdentifier: string): Promise<BedrockCustomModelDetail>;
```

- Validates `modelIdentifier` non-empty BEFORE the fetch.
- URI-encodes the identifier (handles ARN colons → `%3A`).
- GETs `/custom-models/{encoded}` via the existing `signedControlPlaneGet` helper.
- Parses via `parseCustomModelDetail`.

### 2. Typed nested model

7 required top-level fields + 8 optional. Nested types model AWS's contract verbatim:

```ts
export interface BedrockCustomModelDetail {
  // required
  readonly modelArn: string;
  readonly modelName: string;
  readonly jobArn: string;
  readonly baseModelArn: string;
  readonly creationTime: string;
  readonly trainingDataConfig: BedrockCustomModelS3Config;
  readonly outputDataConfig: BedrockCustomModelS3Config;
  // optional
  readonly jobName?: string;
  readonly customizationType?: string;
  readonly modelKmsKeyArn?: string;
  readonly hyperParameters?: Readonly<Record<string, string>>;
  readonly validationDataConfig?: BedrockCustomModelValidationDataConfig;
  readonly trainingMetrics?: BedrockCustomModelTrainingMetrics;
  readonly validationMetrics?: readonly BedrockCustomModelValidationMetric[];
  readonly customizationConfig?: BedrockCustomModelCustomizationConfig;
}
```

Nested types:
- `BedrockCustomModelS3Config` — `{s3Uri}`. Shared shape for `trainingDataConfig` + `outputDataConfig`.
- `BedrockCustomModelValidator` — `{s3Uri}`. Wrapped by `BedrockCustomModelValidationDataConfig.validators[]` since AWS expects an array (operators can validate against multiple datasets).
- `BedrockCustomModelTrainingMetrics` — `{trainingLoss?: number}`. AWS may add `trainingMetrics.<future>` fields.
- `BedrockCustomModelValidationMetric` — `{validationLoss?: number}`. One entry per validator.
- `BedrockCustomModelTeacherModelConfig` — `{teacherModelIdentifier, maxResponseLengthForInference?}`. Only present for DISTILLATION customizations.
- `BedrockCustomModelDistillationConfig` — `{teacherModelConfig}`.
- `BedrockCustomModelCustomizationConfig` — `{distillationConfig?}`. Wraps distillation-specific config so AWS can add future customization-type-specific configs (Adapter? RLHF?) without breaking the kernel.

### 3. `hyperParameters` as `Record<string, string>`

AWS documents `hyperParameters` as a map of string→string. Operators may pass numeric values, but AWS serializes them as strings on the wire. The parser enforces this: non-string values throw `api_error`. Operators wanting numeric semantics parse `parseFloat` / `parseInt` at the application layer.

### 4. Strict finite-number validation on losses

`trainingLoss` + `validationLoss` are parsed as `number` and validated via `Number.isFinite`. NaN / Infinity throw `api_error` — AWS shouldn't emit those, and if they do, downstream code shouldn't have to defensively handle them.

### 5. Why extended-shape pattern (not type-alias)

Two patterns coexist in the Bedrock package for `getX`:
- **Type alias** — `BedrockBatchJobDetail = BedrockBatchJobSummary`, `BedrockInferenceProfileDetail = BedrockInferenceProfileSummary`.
- **Extended type** — `BedrockGuardrailDetail`, `BedrockImportedModelDetail`, `BedrockCustomModelDetail` (this ADR).

GetCustomModel's response shape is dramatically richer than the summary (15 fields vs 8, with nested S3 configs + metrics + hyperparameters + distillation lineage). Aliasing would silently drop those fields. Extended-shape it is.

## Cross-cutting invariants enforced

- **Reuse the M2.X.5.aa.z.3 transport rail.** No transport changes.
- **Boundary validation BEFORE network.** Empty identifier fast-fails.
- **Strict nested parsing.** Each sub-object validates independently — missing s3Uri in any S3 config throws with a localized error message.
- **Forward-compat for AWS additions.** `customizationConfig` wrapper means new customization-type-specific configs land cleanly. `hyperParameters` is open-keyed.
- **No kernel changes.** `LlmProvider` interface unchanged.
- **Backwards compat preserved.** No M2.X.5.aa.z.13 tests changed; only additions.

## End-to-end semantic

```ts
const provider = new BedrockProvider({ accessKeyId, secretAccessKey, region: "us-east-1" });

// Compliance audit: dump training + validation provenance.
const detail = await provider.getCustomModel("abc123");
console.log(`Model ${detail.modelName} trained on ${detail.trainingDataConfig.s3Uri}`);
if (detail.validationDataConfig !== undefined) {
  for (const v of detail.validationDataConfig.validators) {
    console.log(`  validated against ${v.s3Uri}`);
  }
}
console.log(`  output: ${detail.outputDataConfig.s3Uri}`);
if (detail.trainingMetrics?.trainingLoss !== undefined) {
  console.log(`  training loss: ${detail.trainingMetrics.trainingLoss.toString()}`);
}

// Hyperparameter audit for reproducibility.
for (const [k, v] of Object.entries(detail.hyperParameters ?? {})) {
  console.log(`  ${k}=${v}`);
}

// Distillation lineage.
const teacher =
  detail.customizationConfig?.distillationConfig?.teacherModelConfig;
if (teacher !== undefined) {
  console.log(`Distilled from teacher ${teacher.teacherModelIdentifier}`);
}

// Replay: extract training config to reproduce the model.
async function replayConfig(modelId: string): Promise<unknown> {
  const d = await provider.getCustomModel(modelId);
  return {
    baseModelArn: d.baseModelArn,
    trainingData: d.trainingDataConfig.s3Uri,
    validationData: d.validationDataConfig?.validators.map((v) => v.s3Uri),
    hyperParameters: d.hyperParameters,
  };
}
```

## Alternatives considered

- **Use type alias to share `BedrockCustomModelSummary` fields.**
  - **Considered.** Cleaner type relationship.
  - **Cons.** Detail has 15 fields; summary has 8. Inheriting / aliasing would obscure the 7 new fields.
  - **Decision.** Independent type.

- **Parse `hyperParameters` values as numbers when they look numeric.**
  - **Considered.** Operator convenience.
  - **Cons.** AWS contract is string→string. Inferring types loses information (a hyperparameter that's "10" as a string vs the integer 10).
  - **Decision.** Preserve AWS's contract; operators parse at the application layer.

- **Validate `s3Uri` format strictly (`s3://...`).**
  - **Considered.** Catch typos at parse time.
  - **Cons.** AWS-side validation already enforces this.
  - **Decision.** Non-empty validation only.

- **Tolerate NaN/Infinity for loss values.**
  - **Considered.** Some pre-trained models report Infinity for first-step losses.
  - **Cons.** AWS documents losses as finite numbers. If they emit Infinity, that's API drift the operator should know about.
  - **Decision.** Strict finite validation.

- **Cache the detail.**
  - **Considered.** Provenance dashboards re-fetch frequently.
  - **Cons.** Caching policy is operator-specific.
  - **Decision.** No provider-layer caching.

- **Flatten `customizationConfig.distillationConfig.teacherModelConfig` into `teacherModelIdentifier` at the top level.**
  - **Considered.** Operators almost always want just the identifier.
  - **Cons.** AWS uses the wrapping for future-compat (adapter configs, RLHF configs, etc.). Flattening would lock the kernel into the current AWS shape.
  - **Decision.** Preserve AWS's nesting.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 7,157 tests** (+22 from M2.X.5.aa.z.14: 13 custom-models-api detail + 9 provider). All green, zero type errors.
- **Bedrock control-plane surface now has 12 of N operations.** listBatches + getBatch + stopBatch + createBatch + listGuardrails + getGuardrail + listInferenceProfiles + getInferenceProfile + listImportedModels + getImportedModel + listCustomModels + getCustomModel.
- **Compliance / replay / ML-ops workflows fully unblocked on custom models.** Training data, validation data, output artifacts, metrics, hyperparameters, distillation lineage — all surfaced.
- **Third extended-shape detail pattern instance.** Guardrail + ImportedModel + CustomModel. The choice between type-alias and extended-shape is consistent: AWS's response dictates.
- **Eight new typed sub-shapes in `custom-models-api.ts`.** S3Config, Validator, ValidationDataConfig, TrainingMetrics, ValidationMetric, TeacherModelConfig, DistillationConfig, CustomizationConfig.
- **Bedrock module count: 14 (unchanged).** All additions in the existing `custom-models-api.ts`.

## Open questions

- **Q1:** `deleteCustomModel`?
  - _Current direction:_ Wait for operator demand.
- **Q2:** `createModelCustomizationJob` — programmatic fine-tunes?
  - _Current direction:_ Substantial body shape. Defer.
- **Q3:** Should the kernel surface `trainingLoss` history (multi-step)?
  - _Current direction:_ AWS only exposes final loss values. Multi-step training curves are in CloudWatch Metrics, not the Bedrock API.
- **Q4:** Should there be a `replayCustomModel(provider, modelId, overrides)` helper that diffs hyperparameters + reissues a customization job?
  - _Current direction:_ Out of scope. Pure config dump is enough; reissue is operator-side.
- **Q5:** Should `hyperParameters` accept arbitrary `unknown` values to handle AWS API drift?
  - _Current direction:_ No. Strict string→string matches AWS's documented contract; drift surfaces as an error.
- **Q6:** Should the parser auto-derive customization type from presence of `customizationConfig.distillationConfig`?
  - _Current direction:_ No. `customizationType` is the authoritative source; nested config is informational.
- **Q7:** Cross-account model sharing — does the detail surface `ownerAccountId` for shared-in models?
  - _Current direction:_ AWS doesn't return `ownerAccountId` in `GetCustomModel` (it's in `ListCustomModels`). Operators correlate via the list call.
