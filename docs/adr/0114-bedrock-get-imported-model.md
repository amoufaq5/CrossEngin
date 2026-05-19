# ADR-0114: Bedrock getImportedModel with data-source provenance (Phase 2 M2.X.5.aa.z.12)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0106 (M2.X.5.aa.z.4 getBatch), ADR-0110 (M2.X.5.aa.z.8 getGuardrail), ADR-0112 (M2.X.5.aa.z.10 getInferenceProfile), ADR-0113 (M2.X.5.aa.z.11 listImportedModels) |

## Context

M2.X.5.aa.z.11 shipped `listImportedModels` returning shallow summaries (modelArn, modelName, creationTime, instructSupported, modelArchitecture). The summary is enough for inventory + architecture-aware routing, but operators need MORE for three workflows:

1. **Provenance verification.** Compliance teams need to verify "this model was imported from S3 URI X by job Y" — required for model-lineage audits.
2. **KMS-key audits.** Operators encrypting model artifacts with customer-managed KMS keys need to verify the `modelKmsKeyArn` matches their policy.
3. **Import-job correlation.** Operators tracking ModelImportJob progress (via separate `GetModelImportJob` — out of scope this milestone) need the `jobArn` to link the finished model back to its import job.

`GetImportedModel` is the AWS endpoint. Unlike `GetInferenceProfile` (where get returns the same shape as list), `GetImportedModel` returns a substantively richer shape — adds 4 fields the summary lacks: `jobName`, `jobArn`, `modelDataSource.s3DataSource.s3Uri`, and optional `modelKmsKeyArn`.

This is structurally analogous to M2.X.5.aa.z.8's `getGuardrail` — a thin GET with a rich response that needs its own type + parser.

## Decision

One new provider method + extended typed model in `imported-models-api.ts`.

### 1. `BedrockProvider.getImportedModel(modelIdentifier)`

```ts
async getImportedModel(modelIdentifier: string): Promise<BedrockImportedModelDetail>;
```

- Validates `modelIdentifier` non-empty BEFORE the fetch.
- URI-encodes the identifier (handles ARN colons → `%3A`).
- GETs `/imported-models/{encoded}` via the existing `signedControlPlaneGet` helper.
- Parses via `parseImportedModelDetail`.

### 2. Extended typed model

`BedrockImportedModelDetail` is NOT a type alias for `BedrockImportedModelSummary`. It explicitly carries the 5 summary fields PLUS:

```ts
export interface BedrockImportedModelDetail {
  readonly modelArn: string;
  readonly modelName: string;
  readonly creationTime: string;
  readonly instructSupported: boolean;
  readonly modelArchitecture: string;
  readonly jobName: string;
  readonly jobArn: string;
  readonly modelDataSource: BedrockImportedModelDataSource;
  readonly modelKmsKeyArn?: string;
}

export interface BedrockImportedModelDataSource {
  readonly s3DataSource: BedrockImportedModelS3DataSource;
}

export interface BedrockImportedModelS3DataSource {
  readonly s3Uri: string;
}
```

The 3-level nesting (`modelDataSource.s3DataSource.s3Uri`) is preserved verbatim from AWS — operators reading the shape see exactly the AWS contract.

### 3. `parseImportedModelDetail(raw)`

Strict parser:
- 7 required top-level fields throw `BedrockError api_error` on missing / wrong-type.
- `modelDataSource` parsed via `parseModelDataSource`; nested `s3DataSource.s3Uri` validated.
- `modelKmsKeyArn` optional; preserved when present + non-empty.

### 4. Why a separate detail type vs the M2.X.5.aa.z.10 alias pattern

Two patterns now coexist in the Bedrock package:

- **Type alias** — `BedrockBatchJobDetail = BedrockBatchJobSummary`, `BedrockInferenceProfileDetail = BedrockInferenceProfileSummary`. Used when AWS returns IDENTICAL shapes for list + get.
- **Extended type** — `BedrockGuardrailDetail` (M2.X.5.aa.z.8) + `BedrockImportedModelDetail` (this ADR). Used when get returns substantively richer fields.

The choice is dictated by AWS's response shape, not by kernel preference.

## Cross-cutting invariants enforced

- **Reuse the M2.X.5.aa.z.3 transport rail.** `signedControlPlaneGet` called unchanged.
- **Reuse the boundary-validation discipline.** Empty identifier fast-fails.
- **Strict nested parsing.** `modelDataSource.s3DataSource.s3Uri` validated at all three levels.
- **Preserve AWS field names verbatim.** Three-level nesting kept; not flattened.
- **No kernel changes.** `LlmProvider` interface unchanged.
- **Backwards compat preserved.** No M2.X.5.aa.z.11 tests changed; only additions.

## End-to-end semantic

```ts
const provider = new BedrockProvider({ accessKeyId, secretAccessKey, region: "us-east-1" });

// Provenance audit.
const detail = await provider.getImportedModel("abc123def456");
console.log(
  `Model ${detail.modelName} was imported from ${detail.modelDataSource.s3DataSource.s3Uri} by job ${detail.jobName}`,
);
if (detail.modelKmsKeyArn !== undefined) {
  console.log(`KMS-encrypted with ${detail.modelKmsKeyArn}`);
}

// Roster-then-detail enumeration.
const roster = await provider.listImportedModels();
for (const summary of roster.modelSummaries) {
  const detail = await provider.getImportedModel(summary.modelArn);
  await auditRecord(detail);
}

// KMS-policy enforcement check.
async function verifyKmsKey(modelArn: string, expectedKey: string): Promise<boolean> {
  const detail = await provider.getImportedModel(modelArn);
  return detail.modelKmsKeyArn === expectedKey;
}
```

## Alternatives considered

- **Make `BedrockImportedModelDetail` extend `BedrockImportedModelSummary`.**
  - **Considered.** Cleaner type relationship — "detail is summary + extras."
  - **Cons.** TypeScript inheritance with `readonly` arrays + `interface extends` has subtle covariance pitfalls. Flat explicit fields are clearer for operators reading the type.
  - **Decision.** Independent type with duplicated common fields. ~5 lines of duplication vs subtle inheritance gotchas.

- **Flatten `modelDataSource.s3DataSource.s3Uri` to a top-level `s3DataSourceUri` field.**
  - **Considered.** Operators almost always want just the URI; the wrappers add no info.
  - **Cons.** If AWS ever adds non-S3 data sources (HuggingFace direct, Git LFS, etc.), the nested shape gives them a place to land without breaking the kernel. The wrappers ARE meaningful as future-compat.
  - **Decision.** Preserve AWS's nesting.

- **Validate `s3Uri` format strictly (`^s3://.../`).**
  - **Considered.** Catch malformed data at parse time.
  - **Cons.** AWS-side validation already enforces this; client-side regex would just duplicate the check. The kernel preserves the verbatim string.
  - **Decision.** Non-empty validation only.

- **Cache the detail for a short TTL.**
  - **Considered.** Provenance audits poll frequently.
  - **Cons.** Caching policy is operator-specific.
  - **Decision.** No provider-layer caching.

- **Auto-call `listImportedModels` if `getImportedModel` returns 404 (suggest alternatives).**
  - **Considered.** Better DX on typos.
  - **Cons.** Hidden network calls + cost.
  - **Decision.** Surface 404 verbatim.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 7,097 tests** (+16 from M2.X.5.aa.z.12: 8 imported-models-api detail + 8 provider). All green, zero type errors.
- **Bedrock control-plane surface now has 10 of N operations.** listBatches + getBatch + stopBatch + createBatch + listGuardrails + getGuardrail + listInferenceProfiles + getInferenceProfile + listImportedModels + getImportedModel.
- **Provenance audit workflows unblocked.** Operators can trace any imported model back to its S3 source + import job.
- **KMS-key compliance workflows unblocked.** Per-model encryption-key verification supported.
- **Import-job correlation supported.** Operators can link finished models back to their `ModelImportJob` records.
- **Two get-shape patterns now distinct.** Type-alias (batch + inference-profile) vs extended-type (guardrail + imported-model). The choice follows AWS's response shape, not kernel preference.
- **Bedrock module count: 13 (unchanged).** All additions live in the existing `imported-models-api.ts`.

## Open questions

- **Q1:** `listModelImportJobs` + `getModelImportJob` — the import-job surface.
  - _Current direction:_ Pairs naturally with `jobArn` in the detail response. Likely next if Bedrock depth continues.
- **Q2:** `deleteImportedModel`?
  - _Current direction:_ Wait for operator demand. Tenant-cleanup workflows would benefit but other deletion endpoints are also missing.
- **Q3:** `createModelImportJob`?
  - _Current direction:_ Largest lift in the imported-model surface. Body shape includes model artifacts S3 source, role ARN, KMS key, vpcConfig. Defer until authoring workflows demand it.
- **Q4:** Should the parser preserve unknown fields for forward-compat?
  - _Current direction:_ Strict on known fields; tolerates unknown at JSON level.
- **Q5:** Helper to derive `modelArchitecture` capabilities (chat vs completion vs embedding)?
  - _Current direction:_ Out of scope. `instructSupported` already surfaces the chat-vs-completion distinction.
- **Q6:** Validate the `jobArn` shape against an IAM-ARN-like regex?
  - _Current direction:_ Non-empty string only. AWS-side validation suffices.
