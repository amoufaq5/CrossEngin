# ADR-0151: Bedrock foundation model discovery — getFoundationModel + listFoundationModels (Phase 2 M2.X.5.aa.z.30)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0147 (PT inspection), ADR-0148 (createProvisionedModelThroughput), ADR-0142 (createInferenceProfile via copyFrom) |

## Context

Bedrock's CREATE endpoints expect foundation-model ARNs as inputs:

- `createInferenceProfile.modelSource.copyFrom` (ADR-0142) — foundation model ARN OR system-inference-profile ARN
- `createProvisionedModelThroughput.modelId` (ADR-0148) — foundation/custom/imported model ARN or ID
- `createBatch.modelId` (ADR-0108) — model ARN or ID
- `createModelCustomizationJob.baseModelIdentifier` (ADR-0131) — base foundation model

Operators feeding these endpoints need to know which foundation models are available, what each model supports, and which regions expose them. Without substrate-side discovery, the only paths are AWS Console browsing or hard-coding model IDs against a static doc reference. Both drift as AWS releases new models or deprecates old ones.

AWS exposes two read endpoints for this:

- `GET /foundation-models/{modelIdentifier}` → GetFoundationModel
- `GET /foundation-models` → ListFoundationModels

These are pure inspection — operators can never mutate AWS-managed foundation models. M2.X.5.aa.z.30 ships both.

## Decision

Two new methods on `BedrockProvider`:

```ts
async getFoundationModel(modelIdentifier: string): Promise<BedrockFoundationModelDetail>;

async listFoundationModels(
  options?: BedrockListFoundationModelsOptions,
): Promise<BedrockFoundationModelListResponse>;
```

A new `foundation-models-api.ts` file hosts types + builders + parsers. URI structure mirrors the existing list/get patterns from inference-profiles + PT-inspection (path-based GET-individual + bare-path list with query filters).

### Type shapes

```ts
export interface BedrockFoundationModelSummary {
  readonly modelId: string;
  readonly modelArn: string;
  readonly modelName: string;
  readonly providerName: string;
  readonly inputModalities: readonly BedrockFoundationModelModality[];
  readonly outputModalities: readonly BedrockFoundationModelModality[];
  readonly responseStreamingSupported?: boolean;
  readonly customizationsSupported?: readonly BedrockFoundationModelCustomization[];
  readonly inferenceTypesSupported?: readonly BedrockFoundationModelInferenceType[];
  readonly modelLifecycle?: { readonly status: BedrockFoundationModelLifecycleStatus };
}

export type BedrockFoundationModelDetail = BedrockFoundationModelSummary;

export interface BedrockFoundationModelListResponse {
  readonly modelSummaries: readonly BedrockFoundationModelSummary[];
}
```

Four enums encode the AWS-documented value sets:

- **Modality:** TEXT | IMAGE | EMBEDDING
- **Customization:** FINE_TUNING | CONTINUED_PRE_TRAINING | DISTILLATION
- **InferenceType:** ON_DEMAND | PROVISIONED
- **LifecycleStatus:** ACTIVE | LEGACY

`BedrockFoundationModelDetail` is a type alias for `BedrockFoundationModelSummary` — AWS's GetFoundationModel response carries the same fields as a ListFoundationModels summary entry, wrapped in a `modelDetails` envelope. The substrate's `parseFoundationModelDetail` unwraps that envelope.

### List filters

```ts
export interface BedrockListFoundationModelsOptions {
  readonly byCustomizationType?: BedrockFoundationModelCustomization;
  readonly byInferenceType?: BedrockFoundationModelInferenceType;
  readonly byOutputModality?: BedrockFoundationModelModality;
  readonly byProvider?: string;
}
```

Four operator-actionable filters. No pagination (small number of foundation models per region; AWS doesn't expose `nextToken`).

### Boundary validation

`buildFoundationModelListQuery` enforces AWS-documented constraints BEFORE fetch:

| Field | Constraint |
|---|---|
| `byCustomizationType` | Must be one of the 3 documented values |
| `byInferenceType` | Must be one of the 2 documented values |
| `byOutputModality` | Must be one of the 3 documented modalities |
| `byProvider` | Length [1, 256] |

Parsers (`parseFoundationModelSummary`, `parseFoundationModelDetail`, `parseFoundationModelListResponse`) enforce the response contract — required strings present, modality/customization/inferenceType/lifecycle-status values within their allowlists, nested objects shaped correctly.

### Why type-alias `Detail = Summary` (not extended-shape)?

Earlier milestones (ADR-0116 getCustomModel, ADR-0123 getModelCustomizationJob) used the extended-shape pattern — `Detail extends Summary` with extra fields like `failureMessage`. ADR-0142 createInferenceProfile uses the type-alias pattern — `Detail = Summary` — because AWS returns identical shapes.

Foundation models follow the type-alias pattern: AWS's GetFoundationModel returns a `modelDetails` envelope containing exactly the same fields as a ListFoundationModels summary. No extra detail-only fields exist (yet). If AWS adds detail-only fields later, the alias extends to `interface Detail extends Summary { ...new fields... }` additively.

## Cross-cutting invariants enforced

- **Pure boundary validation.** All checks in `buildFoundationModelListQuery` before any AWS call.
- **AWS contract preserved verbatim.** Field names + enum values + URI structure match AWS docs exactly.
- **Defensive `modelDetails` envelope unwrap.** AWS's GetFoundationModel wraps the model in `{modelDetails: {...}}`; substrate handles both wrapped and flat responses (defensive fallback if AWS removes the envelope in a future version).
- **Strict enum validation on responses.** Unknown modality/customization/inferenceType/lifecycle values surface as `api_error` (loud failure on undocumented AWS additions).
- **All optional fields preserved.** `responseStreamingSupported`, `customizationsSupported`, `inferenceTypesSupported`, `modelLifecycle` are conditionally emitted in the parsed result based on AWS's response (no silent default injection).
- **Symmetric error propagation.** 404 → `not_found_error`, 403 → `permission_error`, 429 → `rate_limit_error`.
- **Control-plane host only.** Tests assert `bedrock.{region}.amazonaws.com`, not `bedrock-runtime.`.

## End-to-end semantic

```ts
import { BedrockProvider } from "@crossengin/ai-providers-bedrock";

const bedrock = new BedrockProvider({...});

// 1. Discover all Anthropic models in the region.
const { modelSummaries } = await bedrock.listFoundationModels({
  byProvider: "Anthropic",
});
for (const m of modelSummaries) {
  console.log(`${m.modelId} (${m.modelName})`);
}

// 2. Find models that support fine-tuning.
const fineTunable = await bedrock.listFoundationModels({
  byCustomizationType: "FINE_TUNING",
});

// 3. Find models that support provisioned throughput.
const ptCapable = await bedrock.listFoundationModels({
  byInferenceType: "PROVISIONED",
});

// 4. Find embedding models.
const embeddingModels = await bedrock.listFoundationModels({
  byOutputModality: "EMBEDDING",
});

// 5. Inspect a specific model before using it.
const detail = await bedrock.getFoundationModel(
  "anthropic.claude-3-5-sonnet-20241022-v2:0",
);
if (detail.modelLifecycle?.status === "LEGACY") {
  log.warn(`Model ${detail.modelId} is LEGACY — migration recommended.`);
}

// 6. Pipeline with create operations.
const ptCapableModels = await bedrock.listFoundationModels({
  byInferenceType: "PROVISIONED",
  byProvider: "Anthropic",
});
for (const m of ptCapableModels.modelSummaries) {
  // Operator decides whether to provision throughput per model.
  log.info(`PT-capable: ${m.modelId}`);
}
```

Discovery workflows now feed every downstream CREATE endpoint with concrete, region-specific model identifiers.

## Alternatives considered

- **Hardcode a static model registry alongside the substrate.**
  - **Considered.** Avoid the read round-trip.
  - **Cons.** AWS releases new models monthly; deprecates older ones quarterly. Static registry drifts immediately. Live query is the only durable source of truth.
  - **Decision.** Live query.

- **Combine `getFoundationModel` with `getCustomModel` / `getImportedModel` into a single `getModel(arn)` method.**
  - **Considered.** Type-unified surface.
  - **Cons.** Three different AWS endpoints, three different response shapes, three different sets of fields. Forcing union types loses precision.
  - **Decision.** Keep separate.

- **Add a `byInputModality` filter (symmetric with `byOutputModality`).**
  - **Considered.** Symmetric API.
  - **Cons.** AWS doesn't expose `byInputModality`. Substrate can't fabricate a filter AWS doesn't support; operators wanting input-modality filtering iterate client-side.
  - **Decision.** Match AWS exactly.

- **Cache `listFoundationModels` results (model catalog changes slowly).**
  - **Considered.** Reduce read traffic for discovery workflows.
  - **Cons.** Cache invalidation. Operators may need fresh data when AWS releases new models. PG-style fresh read on every call is the obvious-default; operators wanting a cache wrap the provider.
  - **Decision.** No cache.

- **Auto-paginate (model catalog is small but AWS could add pagination later).**
  - **Considered.** Forward-compat.
  - **Cons.** AWS doesn't paginate today. If they add `nextToken` later, additive change. Auto-pagination would silently hide backpressure.
  - **Decision.** No pagination wrapper.

- **Use extended-shape `Detail extends Summary` pattern.**
  - **Considered.** Symmetric with ADR-0116 (custom-model) and friends.
  - **Cons.** AWS returns the same fields for both. No detail-only fields exist. Type-alias matches the empirical shape.
  - **Decision.** Type alias. Extension is additive if AWS adds detail-only fields later.

- **Translate enum values to camelCase (e.g., `fine_tuning` instead of `FINE_TUNING`).**
  - **Considered.** TypeScript convention alignment.
  - **Cons.** AWS returns SCREAMING_SNAKE_CASE; substrate-side translation creates two truth tables (AWS docs vs substrate types). Pass-through is simpler.
  - **Decision.** Match AWS verbatim.

- **Skip parsing `customizationsSupported` / `inferenceTypesSupported` / `modelLifecycle` (just pass raw arrays).**
  - **Considered.** Simpler parser.
  - **Cons.** Loses enum validation. An undocumented AWS value would silently pass through.
  - **Decision.** Strict enum validation. Loud failure on undocumented additions.

## Consequences

- **56 packages + 1 app, 127 meta-schema tables, 7,991 tests** (+58 from M2.X.5.aa.z.30: 40 in `foundation-models-api.test.ts` covering enums + query builder + 3 parsers, 18 in `provider.test.ts` covering wire shape + filter threading + error propagation across both methods).
- **Bedrock control plane: 22 read + 2 stop + 3 create + 5 delete + 3 tag + 2 update = 37 operations.** Two new read surfaces.
- **Discovery workflows now first-class.** Operators discover model availability before committing to creates.
- **PT creation is more reliable.** Operators verify a model supports `PROVISIONED` inference before calling `createProvisionedModelThroughput`.
- **Inference-profile creation is more reliable.** Operators verify the foundation model exists before calling `createInferenceProfile`.
- **Legacy-model awareness.** Operators detect `modelLifecycle.status === "LEGACY"` and plan migrations.
- **No new transport infrastructure.** Reuses `signedControlPlaneGet` from earlier milestones.

## Open questions

- **Q1:** Should `getFoundationModel` accept either modelId or modelArn?
  - _Current direction:_ Yes — AWS accepts both. Substrate passes through; AWS resolves.
- **Q2:** Should there be a higher-level `findPtCapableModels(provider)` convenience helper?
  - _Current direction:_ Operator-side composition. `listFoundationModels({ byInferenceType: "PROVISIONED", byProvider })` is 4 lines.
- **Q3:** Should the response include cross-region availability (e.g., "this model is also in us-west-2")?
  - _Current direction:_ AWS scopes responses to the configured region. Operators wanting cross-region run separate `BedrockProvider` instances per region.
- **Q4:** Should the substrate cache `listFoundationModels` with a TTL (e.g., 1 hour)?
  - _Current direction:_ Operator-side wrapper. Substrate stays stateless.
- **Q5:** Should there be a `modelCustomizationsByModelId(arn)` convenience that returns just the `customizationsSupported` field?
  - _Current direction:_ Operator-side. `(await getFoundationModel(arn)).customizationsSupported` is one line.
- **Q6:** Should the substrate validate that a `modelId` passed to `createPT` / `createInferenceProfile` / `createBatch` is actually a known foundation model (via a `listFoundationModels` pre-check)?
  - _Current direction:_ No. Adds a round-trip per create call. AWS validates the modelId server-side. Operators wanting pre-validation wrap.
- **Q7:** Should there be a `legacyModelWarning` instrumentation event when an operator references a LEGACY model?
  - _Current direction:_ Future enhancement via `BedrockControlPlaneInstrumentation` (separate ADR).
- **Q8:** Should the substrate expose `BEDROCK_FOUNDATION_MODEL_PROVIDERS` as a known-provider enum (Anthropic, Amazon, Meta, etc.)?
  - _Current direction:_ No. AWS adds new providers; substrate doesn't maintain the list. Operators pass arbitrary provider strings.
