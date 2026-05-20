# ADR-0121: Bedrock getModelImportJob with import-job detail (Phase 2 M2.X.5.aa.z.16)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0114 (M2.X.5.aa.z.12 getImportedModel), ADR-0116 (M2.X.5.aa.z.14 getCustomModel), ADR-0117 (M2.X.5.aa.z.15 listModelImportJobs) |

## Context

M2.X.5.aa.z.15 shipped `listModelImportJobs` returning shallow summaries — enough for pipeline-health monitoring + failure triage at the roster level, but not enough for the actual diagnostic step. When a Failed import surfaces in the roster, operators need to look up the specific job to read:

1. **`failureMessage`** — AWS's typed reason ("role does not have s3:GetObject", "modelArchitecture inference failed", etc.).
2. **`modelDataSource.s3DataSource.s3Uri`** — the S3 source path; verify the bucket is accessible.
3. **`roleArn`** — the IAM role AWS used; verify it has the right policies.
4. **`importedModelKmsKeyArn`** — for KMS-encrypted artifacts, verify the operator's KMS policy.
5. **`vpcConfig`** — for VPC-scoped imports, verify subnet + security-group routing.

`GetModelImportJob` is the AWS endpoint. Structurally analogous to `GetCustomModel` (M2.X.5.aa.z.14) and `GetImportedModel` (M2.X.5.aa.z.12) — both extended-shape detail companions to their list endpoints.

## Decision

One new provider method + four new typed nested types in `model-import-jobs-api.ts`.

### 1. `BedrockProvider.getModelImportJob(jobIdentifier)`

```ts
async getModelImportJob(jobIdentifier: string): Promise<BedrockModelImportJobDetail>;
```

- Validates `jobIdentifier` non-empty BEFORE the fetch.
- URI-encodes the identifier (handles ARN colons → `%3A`).
- GETs `/model-import-jobs/{encoded}` via the existing `signedControlPlaneGet` helper.
- Parses via `parseModelImportJobDetail`.

### 2. Typed nested model

5 required top-level fields + 8 optional. Nested types model AWS's contract verbatim:

```ts
export interface BedrockModelImportJobDetail {
  // required
  readonly jobArn: string;
  readonly jobName: string;
  readonly roleArn: string;
  readonly status: BedrockModelImportJobStatus;
  readonly creationTime: string;
  readonly modelDataSource: BedrockModelImportJobDataSource;
  // optional
  readonly importedModelName?: string;
  readonly importedModelArn?: string;
  readonly failureMessage?: string;
  readonly lastModifiedTime?: string;
  readonly endTime?: string;
  readonly vpcConfig?: BedrockModelImportJobVpcConfig;
  readonly importedModelKmsKeyArn?: string;
}

export interface BedrockModelImportJobDataSource {
  readonly s3DataSource: { readonly s3Uri: string };
}

export interface BedrockModelImportJobVpcConfig {
  readonly subnetIds: readonly string[];
  readonly securityGroupIds: readonly string[];
}
```

### 3. `parseModelImportJobDetail(raw)`

Strict parser:
- 5 required top-level fields throw `BedrockError api_error` on missing/wrong-type.
- `status` validated against the M2.X.5.aa.z.15 3-value tuple (mixed-case `InProgress|Completed|Failed`).
- `modelDataSource` parsed via nested helper; `s3DataSource.s3Uri` required.
- Optional fields parsed only when present + non-empty.
- `vpcConfig.subnetIds` + `vpcConfig.securityGroupIds` validated as `string[]` (non-string entries throw).
- Reuses M2.X.5.aa.z.15's `isBedrockModelImportJobStatus` discriminator.

### 4. Asymmetry with summary preserved

`BedrockModelImportJobSummary` has `importedModelArn` + `importedModelName` as optional (populated only post-success). `BedrockModelImportJobDetail` also marks them optional — same AWS semantics. The detail adds: `roleArn` (required, missing from summary), `failureMessage` (optional, only on Failed), `modelDataSource` (required), `vpcConfig` (optional), `importedModelKmsKeyArn` (optional).

This is the fourth extended-shape detail instance in the Bedrock package after Guardrail (M2.X.5.aa.z.8), ImportedModel (M2.X.5.aa.z.12), and CustomModel (M2.X.5.aa.z.14). The pattern is fully stable.

## Cross-cutting invariants enforced

- **Reuse the M2.X.5.aa.z.3 transport rail.** No transport changes.
- **Boundary validation BEFORE network.** Empty identifier fast-fails.
- **Strict nested parsing.** Each sub-object validates independently — missing `s3Uri` in `modelDataSource.s3DataSource` throws with a localized error message.
- **VPC array validation.** Non-string entries in `subnetIds` / `securityGroupIds` reject at parse time (catches AWS API drift early).
- **Reuses M2.X.5.aa.z.15 status tuple.** Single source of truth for valid status values.
- **No kernel changes.** `LlmProvider` interface unchanged.
- **Backwards compat preserved.** No M2.X.5.aa.z.15 tests changed; only additions.

## End-to-end semantic

```ts
const provider = new BedrockProvider({ accessKeyId, secretAccessKey, region: "us-east-1" });

// Failure triage workflow.
const failedJobs = await provider.listModelImportJobs({ statusEquals: "Failed" });
for (const summary of failedJobs.modelImportJobSummaries) {
  const detail = await provider.getModelImportJob(summary.jobArn);
  console.error(
    `${detail.jobName}: ${detail.failureMessage ?? "no reason given"}`,
  );
  console.error(`  source: ${detail.modelDataSource.s3DataSource.s3Uri}`);
  console.error(`  role:   ${detail.roleArn}`);
}

// Completed-job audit: verify KMS + VPC compliance.
const completed = await provider.listModelImportJobs({ statusEquals: "Completed" });
for (const summary of completed.modelImportJobSummaries) {
  const detail = await provider.getModelImportJob(summary.jobArn);
  if (
    detail.importedModelKmsKeyArn === undefined ||
    detail.vpcConfig === undefined
  ) {
    flagComplianceGap(detail.jobArn);
  }
}

// In-progress monitoring — poll a specific job.
async function awaitImport(jobId: string): Promise<BedrockModelImportJobDetail> {
  while (true) {
    const detail = await provider.getModelImportJob(jobId);
    if (detail.status !== "InProgress") return detail;
    await new Promise((r) => setTimeout(r, 30_000));
  }
}
```

## Alternatives considered

- **Make `BedrockModelImportJobDetail` extend `BedrockModelImportJobSummary`.**
  - **Considered.** Cleaner type relationship — "detail is summary + extras."
  - **Cons.** TypeScript inheritance with readonly arrays + interface extends has subtle covariance pitfalls. Flat explicit fields are clearer for operators reading the type. Same decision as M2.X.5.aa.z.12 / M2.X.5.aa.z.14.
  - **Decision.** Independent type with duplicated common fields.

- **Auto-resolve the importedModelArn into a `BedrockImportedModelDetail` via cross-method call.**
  - **Considered.** Operators frequently want the full model after the job completes.
  - **Cons.** Hidden network call + cost. Operators chain `getModelImportJob` → `getImportedModel(arn)` explicitly when they need it.
  - **Decision.** No auto-resolve.

- **Validate `s3Uri` format strictly (`s3://...`).**
  - **Considered.** Catch typos at parse time.
  - **Cons.** AWS-side validation already enforces this.
  - **Decision.** Non-empty validation only.

- **Tolerate missing `roleArn` (mark optional).**
  - **Considered.** Older AWS responses might omit it.
  - **Cons.** AWS documents it as required. Strict parsing surfaces drift early.
  - **Decision.** Required.

- **Add a `failureMessage` parser that splits structured error codes.**
  - **Considered.** AWS sometimes embeds codes like "INSUFFICIENT_PERMISSIONS: ..." at the start.
  - **Cons.** Format is operator-supplied + AWS-shaped; over-fitting to one structure rejects others.
  - **Decision.** Preserve as raw string.

- **Cache detail responses.**
  - **Considered.** Failure-triage workflows re-fetch frequently.
  - **Cons.** Caching policy is operator-specific; in-progress jobs need fresh reads.
  - **Decision.** No provider-layer caching.

- **Helper `awaitImportJobCompletion(provider, jobId)` for polling.**
  - **Considered.** Common workflow.
  - **Cons.** Polling cadence + retry policy is operator-specific.
  - **Decision.** Operators write the 8-line polling loop themselves.

## Consequences

- **55 packages + 1 app, 120 meta-schema tables, 7,303 tests** (+20 from M2.X.5.aa.z.16: 11 model-import-jobs-api detail + 9 provider). All green, zero type errors.
- **Bedrock control-plane surface now has 14 of N operations.** listBatches + getBatch + stopBatch + createBatch + listGuardrails + getGuardrail + listInferenceProfiles + getInferenceProfile + listImportedModels + getImportedModel + listCustomModels + getCustomModel + listModelImportJobs + getModelImportJob.
- **Import-job triage workflows fully unblocked.** Failure messages, S3 source, role ARN, KMS, VPC config — all surfaced.
- **Four extended-shape detail instances now in the Bedrock package** (Guardrail, ImportedModel, CustomModel, ModelImportJob). Pattern is fully stable across this many AWS resource types.
- **Bedrock module count: 15 (unchanged).** All additions live in the existing `model-import-jobs-api.ts`.
- **Import-job read story complete.** Both enumeration + single-job lookup work.

## Open questions

- **Q1:** `listModelCustomizationJobs` + `getModelCustomizationJob` (the customization-job surface paralleling import jobs)?
  - _Current direction:_ Both are likely candidates. customization-jobs are richer (include hyperParameters + metrics in their response, similar to GetCustomModel).
- **Q2:** `createModelImportJob` for programmatic imports?
  - _Current direction:_ Substantial body shape (S3 source, role ARN, KMS, vpcConfig, tags). Defer until authoring workflows demand it.
- **Q3:** Should the parser surface a typed error category derived from `failureMessage`?
  - _Current direction:_ No. AWS's failureMessage format isn't documented as machine-parseable.
- **Q4:** Should `getModelImportJob` accept either the jobArn OR the modelArn (cross-key resolution)?
  - _Current direction:_ No. AWS treats them as separate identifiers; cross-key resolution would obscure that contract.
- **Q5:** Add an `OpenTelemetry`-style span helper for polling loops?
  - _Current direction:_ Out of scope. Operators wire their own observability.
- **Q6:** Should `BedrockModelImportJobDataSource` be hoisted to a shared type with `BedrockImportedModelDataSource` (M2.X.5.aa.z.12)?
  - _Current direction:_ Structurally identical today. If they diverge in a future AWS revision, the duplication is one ADR away from being reconciled. Keep separate for now.
