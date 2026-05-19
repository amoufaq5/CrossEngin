# ADR-0113: Bedrock listImportedModels — fourth control-plane enumeration (Phase 2 M2.X.5.aa.z.11)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0105 (M2.X.5.aa.z.3 listBatches), ADR-0109 (M2.X.5.aa.z.7 listGuardrails), ADR-0111 (M2.X.5.aa.z.9 listInferenceProfiles) |

## Context

Bedrock Custom Model Import lets customers upload model artifacts (weights, tokenizer, config) from S3 and serve them through Bedrock's inference API alongside foundation models. This is how operators get fine-tuned Llama / Mistral / Flan / etc. models into Bedrock without re-implementing inference infrastructure.

Demand surfaces:

1. **Imported-model inventory.** "Which custom-imported models does this account have access to?" — required for cost attribution + capacity planning.
2. **Architecture-aware routing.** Operators routing to specific model architectures (LLAMA3, MISTRAL, FLAN, etc.) need the architecture label per model.
3. **Instruct-tuned discoverability.** The `instructSupported` boolean tells operators whether a model is chat-ready or completion-only — they filter dispatch accordingly.
4. **Tenant cleanup.** Tenant offboarding sweeps need to enumerate + tag tenant-owned imported models (via `nameContains` prefix) for deletion.

M2.X.5.aa.z.11 is the fourth paginated control-plane enumeration after listBatches / listGuardrails / listInferenceProfiles. Same `signedControlPlaneGet` rail; same pattern; this milestone reinforces the convention rather than extending it.

## Decision

One new module + one new provider method.

### 1. `imported-models-api.ts`

- 7 boundary-validation constants:
  - `BEDROCK_IMPORTED_MODEL_LIST_MAX_RESULTS_MIN/MAX` (1 / 1000).
  - `BEDROCK_IMPORTED_MODEL_NAME_CONTAINS_MIN/MAX_LEN` (1 / 63 per AWS docs).
  - `BEDROCK_IMPORTED_MODEL_SORT_BY_VALUES` (1-value tuple: `CreationTime`).
  - `BEDROCK_IMPORTED_MODEL_SORT_ORDER_VALUES` (2-value tuple: `Ascending | Descending`).
- `BedrockImportedModelSummary` — `modelArn`, `modelName`, `creationTime`, `instructSupported`, `modelArchitecture` all required.
- `BedrockImportedModelListResponse` — `{modelSummaries, nextToken?}`.
- `buildImportedModelListQuery(options)` — pure boundary-validator. Validates `creationTimeBefore` / `creationTimeAfter` (ISO 8601 parseable), `nameContains` length, `maxResults` integer in `[1, 1000]`, `nextToken` non-empty, `sortBy` against tuple, `sortOrder` against tuple. Throws `BedrockError invalid_request_error` BEFORE any fetch.
- `parseImportedModelListResponse(raw)` + `parseImportedModelSummary(raw)` — strict parsers.

### 2. `BedrockProvider.listImportedModels(options?)`

```ts
async listImportedModels(options: BedrockListImportedModelsOptions = {}): Promise<BedrockImportedModelListResponse>;
```

- Validates options via `buildImportedModelListQuery`.
- GETs `https://bedrock.{region}.amazonaws.com/imported-models?...` via existing `signedControlPlaneGet`.
- Parses JSON via `parseImportedModelListResponse`.

### 3. modelArchitecture preserved as a string

AWS documents specific architecture labels (`LLAMA2`, `LLAMA3`, `MISTRAL`, `FLAN`, etc.) but ships new ones whenever they add support for a new family. The kernel preserves the raw string — strict enum validation would be perpetually stale.

### 4. instructSupported strict boolean validation

`instructSupported` is documented as a strict boolean. The parser throws `api_error` if AWS sends a non-boolean — this catches API drift early.

## Cross-cutting invariants enforced

- **Mechanical reuse of the M2.X.5.aa.z.3 transport rail.** Fourth enumeration on `signedControlPlaneGet`. No transport changes.
- **Same boundary-validator + strict-parser shape as batches.** This is structurally identical to `buildBatchListQuery` + `parseBatchListResponse`. The pattern is now stable across four endpoints.
- **Sort + filter parameter parity with batches.** Imported models share batches' `creationTimeBefore/After` + `nameContains` filter set. Operators familiar with batch enumeration find the same controls here.
- **modelArchitecture stays string.** Future-compat without rebuilding the kernel.
- **No kernel changes.** `LlmProvider` interface unchanged.
- **Backwards compat preserved.** No prior tests changed; only additions.

## End-to-end semantic

```ts
const provider = new BedrockProvider({ accessKeyId, secretAccessKey, region: "us-east-1" });

// Inventory all imported models, group by architecture.
const all: BedrockImportedModelSummary[] = [];
let cursor: string | undefined;
do {
  const page = await provider.listImportedModels({
    maxResults: 100,
    sortBy: "CreationTime",
    sortOrder: "Descending",
    ...(cursor !== undefined ? { nextToken: cursor } : {}),
  });
  all.push(...page.modelSummaries);
  cursor = page.nextToken;
} while (cursor !== undefined);

const byArchitecture = new Map<string, BedrockImportedModelSummary[]>();
for (const m of all) {
  if (!byArchitecture.has(m.modelArchitecture)) {
    byArchitecture.set(m.modelArchitecture, []);
  }
  byArchitecture.get(m.modelArchitecture)!.push(m);
}

// Architecture-aware routing decision.
const instructLlama3 = all.filter(
  (m) => m.modelArchitecture === "LLAMA3" && m.instructSupported,
);

// Tenant cleanup sweep.
const tenantModels = await provider.listImportedModels({
  nameContains: "tenant-x-",
});
for (const m of tenantModels.modelSummaries) {
  await scheduleImportedModelDeletion(m.modelArn);
}
```

## Alternatives considered

- **Enumerate documented architectures into a string-literal union.**
  - **Considered.** Stronger type safety.
  - **Cons.** AWS adds new architectures whenever they expand Bedrock support. The union would be perpetually stale; operators using a recent Bedrock SDK would get type errors against an older kernel.
  - **Decision.** String preserved verbatim.

- **Validate `creationTimeBefore < creationTimeAfter` semantic ordering.**
  - **Considered.** Catch logically wrong ranges client-side.
  - **Cons.** AWS might intentionally accept inverted ranges (empty-result query). Validating semantic ordering would block legitimate calls.
  - **Decision.** ISO 8601 parseability only.

- **Add a separate `instructSupportedOnly` filter option.**
  - **Considered.** Convenience for chat-routing use case.
  - **Cons.** AWS doesn't expose this filter; operators filter client-side after the call.
  - **Decision.** Match AWS's documented parameter set exactly.

- **Unify with listInferenceProfiles into a generic listX helper.**
  - **Considered.** Same as before — third+fourth instance of "should we abstract this."
  - **Cons.** Same as before — parameter sets and response wrappers differ.
  - **Decision.** Four separate methods. Transport-layer sharing only.

- **Auto-paginate.**
  - **Considered.** Same as the other three enumerations.
  - **Cons.** Hides `nextToken`.
  - **Decision.** Plain page-at-a-time.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 7,081 tests** (+33 from M2.X.5.aa.z.11: 25 imported-models-api + 8 provider). All green, zero type errors.
- **Bedrock control-plane surface now has 9 of N operations.** listBatches + getBatch + stopBatch + createBatch + listGuardrails + getGuardrail + listInferenceProfiles + getInferenceProfile + listImportedModels.
- **Imported-model inventory unblocked.** Operators enumerate custom-imported models attributed to their account.
- **Architecture-aware routing supported.** modelArchitecture field surfaces; operators dispatch accordingly.
- **Instruct-tuned discoverability surfaced.** Boolean field enables chat vs completion routing.
- **Tenant cleanup workflows extended.** Combined with batch / guardrail / inference-profile sweeps, the surface now covers four enumerable resource types per tenant.
- **Pattern stable across 4 endpoints.** Adding listCustomModels / listMarketplaceModelEndpoints / etc. is mechanical.
- **Bedrock module count: 13.** batch-api + converse-api + embeddings + errors + event-stream + guardrails + guardrails-api + imported-models-api + inference-profiles-api + pricing + provider + signing + index.

## Open questions

- **Q1:** `getImportedModel(modelIdentifier)` — detail companion?
  - _Current direction:_ AWS's `GetImportedModel` returns a richer shape than the list summary (adds `modelDataSource.s3DataSource.s3Uri`, `modelKmsKey`, `instructSupported`, `jobName`, `jobArn`, etc.). Likely next if Bedrock depth continues.
- **Q2:** `createModelImportJob` for programmatic model imports?
  - _Current direction:_ Largest lift among control-plane writes. Body shape includes S3 source config, model name, role ARN, tags, vpcConfig, KMS key. Defer until operator authoring workflows demand it.
- **Q3:** `deleteImportedModel`?
  - _Current direction:_ Wait for demand. Tenant cleanup is the primary motivation; less urgent than the read surface.
- **Q4:** Architecture-aware enum tuple if AWS publishes a stable list?
  - _Current direction:_ Watch AWS docs. Today the list grows quarterly.
- **Q5:** Should the parser tolerate missing optional fields (e.g., `modelArchitecture`)?
  - _Current direction:_ AWS documents `modelArchitecture` as required. Strict parsing throws if missing.
- **Q6:** Pricing for imported models — should the kernel expose per-token rates?
  - _Current direction:_ Bedrock's imported-model pricing is per-instance / per-hour (capacity-based), not per-token. Out of scope for the LlmProvider abstraction.
