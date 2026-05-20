# ADR-0147: Bedrock provisioned-throughput inspection — getProvisionedModelThroughput + listProvisionedModelThroughputs (Phase 2 M2.X.5.aa.z.26)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0115 (M2.X.5.aa.z.13 listCustomModels), ADR-0116 (M2.X.5.aa.z.14 getCustomModel), ADR-0131 (M2.X.5.aa.z.20 createModelCustomizationJob) |

## Context

The Bedrock control plane lets operators provision dedicated throughput against models — both foundation models and custom (fine-tuned) models. Each **provisioned throughput** (PT) is a paid resource backing a model with guaranteed capacity at a contracted unit count. PTs have commitment terms (one-month / six-month) that lock pricing.

Substrate operators currently have no visibility into PTs:

- **Cost dashboards** can't query "which models have PTs and what's the total monthly commitment?"
- **Reconciliation** can't find orphaned PTs after a custom model is decommissioned, leaking ~$5K-$50K/month per stranded PT.
- **Discovery** during incident response — "which PT is throttling?" — requires the AWS console or CLI.

AWS exposes two read endpoints for PTs:

- `GET /provisioned-model-throughputs/{provisionedModelId}` → `GetProvisionedModelThroughput`
- `GET /provisioned-model-throughputs` → `ListProvisionedModelThroughputs`

M2.X.5.aa.z.26 ships both as inspection-only operations. Mutation (Create/Update/Delete) is deferred to follow-up milestones — committed PTs are expensive enough that operators should explicitly opt-in to lifecycle management via AWS Console first, with the substrate adding the corresponding endpoints incrementally.

## Decision

Two new methods on `BedrockProvider`:

```ts
async getProvisionedModelThroughput(
  provisionedModelId: string,
): Promise<BedrockProvisionedModelDetail>;

async listProvisionedModelThroughputs(
  options?: BedrockListProvisionedModelThroughputsOptions,
): Promise<BedrockProvisionedModelListResponse>;
```

A new `provisioned-throughput-api.ts` file hosts types + builders + parsers. URI structure mirrors `inference-profiles`: path-based GET-individual + bare-path list with query filters.

### Type shapes

```ts
export const BEDROCK_PROVISIONED_MODEL_STATUSES = [
  "Creating", "InService", "Updating", "Failed",
] as const;

export const BEDROCK_PROVISIONED_MODEL_COMMITMENT_DURATIONS = [
  "OneMonth", "SixMonths",
] as const;

export interface BedrockProvisionedModelSummary {
  readonly provisionedModelName: string;
  readonly provisionedModelArn: string;
  readonly modelArn: string;             // current backing model
  readonly desiredModelArn: string;      // model after pending update completes
  readonly foundationModelArn: string;   // the foundation model behind any custom-model variants
  readonly modelUnits: number;
  readonly desiredModelUnits: number;
  readonly status: BedrockProvisionedModelStatus;
  readonly creationTime: string;
  readonly lastModifiedTime: string;
  readonly commitmentDuration?: BedrockProvisionedModelCommitmentDuration;
  readonly commitmentExpirationTime?: string;
}

export interface BedrockProvisionedModelDetail extends BedrockProvisionedModelSummary {
  readonly failureMessage?: string;  // only present when status === "Failed"
}
```

Three ARN fields capture the three logical bindings: `modelArn` is what the PT currently serves (could be a custom model), `desiredModelArn` is what it will serve after an in-flight update (typically equals `modelArn` for stable PTs), `foundationModelArn` is the foundation model behind any custom variants. Operators reading this distinguish "PT is mid-migration" (when `modelArn ≠ desiredModelArn`) from steady state.

### List filters

```ts
export interface BedrockListProvisionedModelThroughputsOptions {
  readonly statusEquals?: BedrockProvisionedModelStatus;
  readonly modelArnEquals?: string;
  readonly nameContains?: string;
  readonly sortBy?: "CreationTime";
  readonly sortOrder?: "Ascending" | "Descending";
  readonly maxResults?: number;        // [1, 1000]
  readonly nextToken?: string;
}
```

Operator-actionable filters: status (find Failed PTs), modelArn (find PTs for a specific model), nameContains (find PTs in a naming convention). Sort by creation time, pagination via nextToken.

### Boundary validation

`buildProvisionedThroughputListQuery` enforces AWS-documented constraints BEFORE fetch:

| Field | Constraint |
|---|---|
| `statusEquals` | Must be one of the 4 documented statuses |
| `modelArnEquals` | Length >= 1 (no pattern — accepts any AWS ARN shape) |
| `nameContains` | Length >= 1 |
| `sortBy` | Must be "CreationTime" (only documented value) |
| `sortOrder` | Must be "Ascending" or "Descending" |
| `maxResults` | Integer in [1, 1000] |
| `nextToken` | Length >= 1 when provided |

Parsers (`parseProvisionedModelSummary`, `parseProvisionedModelDetail`, `parseProvisionedModelListResponse`) enforce the response contract — required string fields present, integer fields actually integers (rejecting `1.5`), enum values within the allowlist.

### Why inspection-only (no Create/Update/Delete)?

Three reasons:

1. **Cost weight.** A one-month PT for `claude-3-sonnet` runs ~$5K/month at minimum. Mistakes are expensive. Operators creating PTs should go through deliberate workflows (Console + IaC), not casual API calls.
2. **Commitment lock-in.** A six-month committed PT cannot be canceled mid-term. Substrate-side creation requires careful idempotency story.
3. **AWS Console parity.** Most operators use the AWS Console for PT creation today; the substrate's value-add for now is **observability** (read), not mutation.

Future milestones can add `createProvisionedModelThroughput`, `updateProvisionedModelThroughput`, `deleteProvisionedModelThroughput` once the operator workflow stabilizes.

## Cross-cutting invariants enforced

- **Pure boundary validation.** All checks in `buildProvisionedThroughputListQuery` before any AWS call.
- **AWS contract preserved verbatim.** Field names + status enum values + URI structure match AWS docs exactly.
- **Three-ARN distinction surfaces clearly.** Operators see `modelArn` vs `desiredModelArn` vs `foundationModelArn` as separate fields — no flattening.
- **Optional fields preserved as optional.** `commitmentDuration`, `commitmentExpirationTime`, `failureMessage` are omitted when AWS doesn't return them. No silent `null` injection.
- **Status enum strictly validated.** Unknown values from AWS surface as `api_error` (defensive — AWS adding a new status without docs update would fail loudly).
- **Integer validation on modelUnits.** AWS returns whole units; non-integer values (e.g., `1.5`) reject as malformed — guards against floating-point JSON parse quirks.
- **Symmetric error propagation.** 404 → `not_found_error`, 403 → `permission_error`, 429 → `rate_limit_error`, 5xx → `server_error`.
- **Control-plane host only.** Tests assert `bedrock.{region}.amazonaws.com`, not `bedrock-runtime.`.

## End-to-end semantic

```ts
import { BedrockProvider } from "@crossengin/ai-providers-bedrock";

const bedrock = new BedrockProvider({...});

// 1. Discovery — find all in-service PTs:
const { provisionedModelSummaries } = await bedrock.listProvisionedModelThroughputs({
  statusEquals: "InService",
  sortBy: "CreationTime",
  sortOrder: "Descending",
});

// 2. Reconciliation — find PTs for a custom model that's been deprecated:
const orphans = await bedrock.listProvisionedModelThroughputs({
  modelArnEquals: deprecatedCustomModelArn,
});
for (const pt of orphans.provisionedModelSummaries) {
  log.warn(`Orphaned PT ${pt.provisionedModelName}: ${pt.modelUnits.toString()} units, commitment ${pt.commitmentDuration ?? "none"}`);
}

// 3. Detail inspection for incident response:
const pt = await bedrock.getProvisionedModelThroughput(provisionedModelId);
if (pt.status === "Failed") {
  log.error(`PT failure: ${pt.failureMessage ?? "no message"}`);
}
if (pt.modelArn !== pt.desiredModelArn) {
  log.info(`PT mid-migration: serving ${pt.modelArn}, migrating to ${pt.desiredModelArn}`);
}

// 4. Cost projection:
const all = await bedrock.listProvisionedModelThroughputs({ maxResults: 1000 });
const totalUnits = all.provisionedModelSummaries.reduce((s, p) => s + p.modelUnits, 0);
log.info(`Total provisioned units across all PTs: ${totalUnits.toString()}`);
```

## Alternatives considered

- **Ship Create/Update/Delete in the same milestone.**
  - **Considered.** Full lifecycle parity with M2.X.5.aa.z.23 (createInferenceProfile) and friends.
  - **Cons.** PTs are 100×-1000× more expensive per operation than inference profiles. Substrate-side creation needs a deliberate idempotency + cost-confirmation story. Inspection has no cost risk.
  - **Decision.** Read-only this milestone.

- **Combine the two endpoints into one method.**
  - **Considered.** `getOrList(idOrFilter)`.
  - **Cons.** Different response shapes (detail vs list). Operators reason about them separately.
  - **Decision.** Two methods.

- **Skip the `foundationModelArn` field.**
  - **Considered.** Two ARNs (current + desired) might be enough.
  - **Cons.** Custom models have a foundation model behind them. Operators auditing cost across foundation-model families need this third ARN. AWS returns it; substrate surfaces it.
  - **Decision.** Three ARN fields.

- **Coerce non-integer modelUnits to floor(value).**
  - **Considered.** Tolerate AWS quirks.
  - **Cons.** AWS doesn't return fractional units. A non-integer would mean a contract violation; loud error is better than silent coercion.
  - **Decision.** Strict integer check.

- **Add a `getModelDeploymentArn(customModelId)` convenience that resolves a custom model to its first PT ARN.**
  - **Considered.** Reduces the operator's "which PT serves this model?" lookup.
  - **Cons.** Multi-PT semantics (a custom model can have N PTs). Operator-side workflow: `listProvisionedModelThroughputs({modelArnEquals: customModelArn})`. Substrate is the transport.
  - **Decision.** No convenience helper.

- **Auto-paginate on `list*` (follow nextToken until exhaustion).**
  - **Considered.** Operator convenience.
  - **Cons.** Inconsistent with other list endpoints in the substrate (listCustomModels, listInferenceProfiles, etc.). Auto-pagination hides backpressure — a huge result set would block. Operators iterate manually.
  - **Decision.** Match the existing list-endpoint pattern.

- **Sort by `lastModifiedTime` or `provisionedModelName` (in addition to `CreationTime`).**
  - **Considered.** More flexibility.
  - **Cons.** AWS docs say `CreationTime` is the only supported `sortBy` value. Substrate can't fabricate sort orders AWS doesn't support.
  - **Decision.** Match AWS exactly.

- **Combine `commitmentDuration` + `commitmentExpirationTime` into a single nested `commitment` object.**
  - **Considered.** Cleaner structure.
  - **Cons.** AWS returns them as flat siblings. Reshaping the AWS contract creates a translation layer that future AWS additions (e.g., a `commitmentRenewalPolicy`) would have to fit.
  - **Decision.** Flat fields matching AWS.

## Consequences

- **56 packages + 1 app, 127 meta-schema tables, 7,860 tests** (+58 from M2.X.5.aa.z.26: 37 in `provisioned-throughput-api.test.ts` covering enums + query builder + 3 parsers, 21 in `provider.test.ts` covering wire shape + filter threading + error propagation).
- **Bedrock control plane: 20 read + 2 stop + 2 create + 4 delete + 3 tag + 1 update = 32 operations.** Two new read surfaces added; PT lifecycle remains inspection-only for now.
- **Operator cost visibility for the first time.** "Which PTs are running, what's the unit count, what's the commitment?" is now a single substrate call.
- **Reconciliation workflows unblocked.** Operators decommissioning a custom model can detect orphaned PTs and budget for cancellation timing.
- **Failed PTs surface their `failureMessage`.** Incident response gets the AWS-side error context.
- **Mid-migration detection.** `modelArn !== desiredModelArn` is the operator-visible signal.
- **No new transport infrastructure.** Reuses `signedControlPlaneGet` from ADR-0111.

## Open questions

- **Q1:** Should the substrate add `createProvisionedModelThroughput`?
  - _Current direction:_ Yes eventually. Needs careful idempotency + cost-confirmation design. Cost (≥$5K/op) makes this distinct from createInferenceProfile. Separate milestone.
- **Q2:** Should the substrate add `updateProvisionedModelThroughput` (change `modelArn` or `desiredModelUnits` mid-life)?
  - _Current direction:_ Yes when create is shipped. Same milestone pairing.
- **Q3:** Should the substrate add `deleteProvisionedModelThroughput`?
  - _Current direction:_ Yes — pairs with create. Committed PTs cannot be deleted mid-commitment; AWS surfaces this as 409 ConflictException.
- **Q4:** Should there be a `getPtsByModel(modelArn)` convenience helper?
  - _Current direction:_ No — operator writes the filter. Substrate is the transport.
- **Q5:** Should the response include cost estimates (e.g., `monthlyUsdProjection`)?
  - _Current direction:_ No — AWS doesn't return cost. Operators compute from `modelUnits × tier_rate` client-side.
- **Q6:** Should `listProvisionedModelThroughputs` support `creationTimeAfter` / `creationTimeBefore` filters?
  - _Current direction:_ AWS may support these (docs are inconsistent across regions). Additive options; defer until operator request.
- **Q7:** Should the substrate emit a `RouterInstrumentation` event when a PT is in `Failed` status (early warning)?
  - _Current direction:_ Out of scope. Operators wire their own monitoring via the existing read methods.
- **Q8:** Should there be a `meta.bedrock_pt_snapshots` table for periodic cost-snapshot persistence?
  - _Current direction:_ Operator workflow. Substrate doesn't manage state outside its own meta-schema concerns.
