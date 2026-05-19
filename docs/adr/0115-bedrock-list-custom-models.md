# ADR-0115: Bedrock listCustomModels — fifth control-plane enumeration (Phase 2 M2.X.5.aa.z.13)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0113 (M2.X.5.aa.z.11 listImportedModels), ADR-0105 (M2.X.5.aa.z.3 listBatches) |

## Context

Bedrock distinguishes two ways customers can ship non-foundation models:

- **Imported models** (M2.X.5.aa.z.11/.12) — externally trained models uploaded from S3 via `CreateModelImportJob`. The model artifacts are operator-owned.
- **Custom models** — fine-tunes / continued-pretrains / distillations of an AWS-supported foundation model produced via `CreateModelCustomizationJob`. The customization process runs INSIDE Bedrock.

The two surfaces are operationally adjacent but technically distinct, and AWS exposes them through separate API endpoints (`/imported-models` vs `/custom-models`). M2.X.5.aa.z.13 ships `listCustomModels()` — the fifth paginated control-plane enumeration after listBatches / listGuardrails / listInferenceProfiles / listImportedModels.

Demand surfaces:

1. **Customization-job inventory.** "Show every fine-tune / continued-pretrain / distillation result attributed to this account."
2. **Base-model audit.** Filter by `baseModelArnEquals` to find "every fine-tune of Claude 3 Haiku" — useful for compliance reviews.
3. **Cross-account discovery.** Custom models can be shared across accounts; `isOwned=false` surfaces shared-in models, `isOwned=true` surfaces account-local models.
4. **Status filtering.** `modelStatus=Failed` enumerates broken customizations for cleanup; `modelStatus=Creating` surfaces in-flight work.

## Decision

One new module + one new provider method, structurally identical to M2.X.5.aa.z.11 with two extensions:

### 1. `custom-models-api.ts`

Boundary-validation constants and a 3-value status tuple (NEW vs imported models — AWS exposes a status field here):
- `BEDROCK_CUSTOM_MODEL_STATUSES` — `["Active", "Creating", "Failed"]`. Mixed-case (AWS preserves this verbatim — unlike `BEDROCK_GUARDRAIL_STATUSES` which is uppercase). Discriminator + tuple.
- `BEDROCK_CUSTOM_MODEL_LIST_MAX_RESULTS_MIN/MAX` (1 / 1000).
- `BEDROCK_CUSTOM_MODEL_NAME_CONTAINS_MIN/MAX_LEN` (1 / 63).
- `BEDROCK_CUSTOM_MODEL_SORT_BY_VALUES` (`["CreationTime"]`).
- `BEDROCK_CUSTOM_MODEL_SORT_ORDER_VALUES` (`["Ascending", "Descending"]`).

`BedrockCustomModelSummary`:
- Required: `modelArn`, `modelName`, `creationTime`, `baseModelArn`.
- Optional: `baseModelName`, `customizationType` (string — AWS extends quarterly: FINE_TUNING / CONTINUED_PRE_TRAINING / DISTILLATION / future), `ownerAccountId`, `modelStatus` (validated against tuple when present).

`buildCustomModelListQuery(options)` — pure boundary-validator with TWO extensions over `buildImportedModelListQuery`:
- `baseModelArnEquals` (non-empty string) — filter by base model.
- `foundationModelArnEquals` (non-empty string) — filter by foundation model.
- `isOwned` boolean — serialized as `"true"` / `"false"` for the HTTP query.
- `modelStatus` validated against the tuple.

`parseCustomModelListResponse(raw)` + `parseCustomModelSummary(raw)` — strict parsers.

### 2. `BedrockProvider.listCustomModels(options?)`

```ts
async listCustomModels(options: BedrockListCustomModelsOptions = {}): Promise<BedrockCustomModelListResponse>;
```

Reuses `signedControlPlaneGet` rail. Same shape as the other four paginated enumerations.

### 3. modelStatus is OPTIONAL in summaries

AWS's `ListCustomModels` response omits `modelStatus` for some legacy entries. The parser handles this gracefully — `modelStatus` is parsed when present, omitted when absent. This differs from `BedrockImportedModelSummary` where `instructSupported` is required.

The asymmetry is AWS-documented; the kernel mirrors it.

### 4. customizationType preserved as a string

AWS documents `FINE_TUNING`, `CONTINUED_PRE_TRAINING`, `DISTILLATION`. They added DISTILLATION recently; future additions are likely. The kernel preserves the raw string — same forward-compat stance as `modelArchitecture` in `BedrockImportedModelSummary`.

## Cross-cutting invariants enforced

- **Mechanical reuse of the M2.X.5.aa.z.3 transport rail.** Fifth enumeration. The pattern is now extremely stable.
- **Strict status tuple discriminator.** `Active | Creating | Failed` — case-sensitive validation throws on `ACTIVE` / `active`.
- **customizationType as string.** Forward-compat against AWS additions.
- **Two new filter params (baseModelArnEquals + foundationModelArnEquals).** Operators can filter by which base model the customizations came from.
- **Boolean serialization.** `isOwned` becomes `"true"` / `"false"` in the query string per AWS convention.
- **Boundary validation BEFORE network.** All eight optional parameters fail fast on bad input.
- **No kernel changes.** `LlmProvider` interface unchanged.
- **Backwards compat preserved.** No prior tests changed; only additions.

## End-to-end semantic

```ts
const provider = new BedrockProvider({ accessKeyId, secretAccessKey, region: "us-east-1" });

// Customization inventory — show every fine-tune on the account.
const fineTunes: BedrockCustomModelSummary[] = [];
let cursor: string | undefined;
do {
  const page = await provider.listCustomModels({
    isOwned: true,
    modelStatus: "Active",
    sortBy: "CreationTime",
    sortOrder: "Descending",
    maxResults: 100,
    ...(cursor !== undefined ? { nextToken: cursor } : {}),
  });
  fineTunes.push(...page.modelSummaries);
  cursor = page.nextToken;
} while (cursor !== undefined);

// Base-model audit: find every customization of Claude 3 Haiku.
const haikuFineTunes = await provider.listCustomModels({
  baseModelArnEquals:
    "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0:200k",
});

// Cleanup: find failed customizations.
const failed = await provider.listCustomModels({ modelStatus: "Failed" });
for (const m of failed.modelSummaries) {
  console.log(`Failed: ${m.modelName} from ${m.creationTime}`);
}

// Shared-in models from another account.
const sharedIn = await provider.listCustomModels({ isOwned: false });
```

## Alternatives considered

- **Combine custom + imported models into a single `listModels` method.**
  - **Considered.** Both surface non-foundation models on the account.
  - **Cons.** AWS exposes them as separate endpoints with different filter parameters and different summary shapes. Combining would require lowest-common-denominator parameters and lose information.
  - **Decision.** Match AWS's surface 1:1.

- **Make `modelStatus` required in `BedrockCustomModelSummary`.**
  - **Considered.** Stronger type guarantees.
  - **Cons.** AWS sometimes omits the field for legacy entries. Strict parsing would reject otherwise-valid AWS responses.
  - **Decision.** Optional. Operators check for undefined.

- **Use UPPERCASE statuses (`ACTIVE / CREATING / FAILED`) for consistency with guardrails.**
  - **Considered.** Cross-surface uniformity.
  - **Cons.** AWS returns mixed-case (`Active`). Mismatching would corrupt comparisons.
  - **Decision.** Preserve AWS verbatim. Casing IS a stable AWS interface contract.

- **Enumerate customizationType values into a strict tuple.**
  - **Considered.** Better type safety.
  - **Cons.** AWS adds new types regularly (DISTILLATION was added recently). Strict enum would be perpetually stale.
  - **Decision.** Preserve as string.

- **Validate `baseModelArnEquals` against an ARN regex.**
  - **Considered.** Catch typos at boundary.
  - **Cons.** Foundation model ARNs span multiple AWS partitions + multiple model types. Regex would be brittle.
  - **Decision.** Non-empty validation only.

- **Auto-paginate.**
  - **Considered.** Operators don't want a single page in practice.
  - **Cons.** Hides `nextToken`; operators can't resume.
  - **Decision.** Plain page-at-a-time.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 7,135 tests** (+38 from M2.X.5.aa.z.13: 30 custom-models-api + 8 provider). All green, zero type errors.
- **Bedrock control-plane surface now has 11 of N operations.** listBatches + getBatch + stopBatch + createBatch + listGuardrails + getGuardrail + listInferenceProfiles + getInferenceProfile + listImportedModels + getImportedModel + listCustomModels.
- **Five paginated enumerations + six single-resource operations now cover the read surface for 5 AWS resource types.**
- **Bedrock module count: 14.** `custom-models-api.ts` added.
- **Customization-job inventory unblocked.** Operators can enumerate fine-tunes / continued-pretrains / distillations.
- **Base-model audit unblocked.** Filter by `baseModelArnEquals` for compliance reviews.
- **Cross-account discovery supported.** `isOwned=false` surfaces shared-in models.
- **Status-aware cleanup workflows.** `modelStatus=Failed` enumerates broken customizations.
- **First non-trivial filter set on a list endpoint.** Custom models is the first enumeration with 8 distinct optional parameters (vs batches' 7 and others' fewer). The boundary-validator pattern scales cleanly.

## Open questions

- **Q1:** `getCustomModel(modelIdentifier)` — detail companion?
  - _Current direction:_ Yes. AWS's `GetCustomModel` returns richer fields (modelKmsKeyArn, trainingDataConfig.s3Uri, validationDataConfig, outputDataConfig.s3Uri, trainingMetrics, validationMetrics, customizationType, jobArn, hyperParameters). Likely next.
- **Q2:** `deleteCustomModel`?
  - _Current direction:_ Wait for operator demand. Tenant cleanup is the primary motivation.
- **Q3:** `createModelCustomizationJob` for programmatic fine-tunes?
  - _Current direction:_ Substantial body shape; defer to a dedicated milestone if authoring workflows demand it.
- **Q4:** Should the kernel expose a unified "all non-foundation models" enumeration across custom + imported?
  - _Current direction:_ No. AWS keeps them separate; operators wanting unified views compose two calls.
- **Q5:** Cost tracking for custom models — should pricing module surface per-model-arn rates?
  - _Current direction:_ Custom-model pricing is capacity-based (per-instance / per-hour), not per-token. Out of scope for `BedrockPricing`.
- **Q6:** Should `customizationType` be promoted to an enum tuple once AWS stabilizes?
  - _Current direction:_ Watch AWS announcements. Today the list grows quarterly.
