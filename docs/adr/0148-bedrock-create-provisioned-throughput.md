# ADR-0148: Bedrock createProvisionedModelThroughput — first PT mutation with mandatory clientRequestToken (Phase 2 M2.X.5.aa.z.27)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0108 (createBatch + clientRequestToken), ADR-0131 (createModelCustomizationJob + clientRequestToken), ADR-0142 (createInferenceProfile + clientRequestToken), ADR-0147 (M2.X.5.aa.z.26 PT inspection) |

## Context

ADR-0147 / M2.X.5.aa.z.26 shipped read-only PT inspection (`getProvisionedModelThroughput` + `listProvisionedModelThroughputs`) but deliberately deferred mutation. ADR-0147 Q1:

> Q1: Should the substrate add `createProvisionedModelThroughput`?
> _Current direction:_ Yes eventually. Needs careful idempotency + cost-confirmation design. Cost (≥$5K/op) makes this distinct from createInferenceProfile. Separate milestone.

M2.X.5.aa.z.27 closes Q1. The first PT mutation, designed with cost-safety guardrails distinct from the other CREATE endpoints in the substrate.

A one-month committed PT for `claude-3-5-sonnet` at 1 model-unit runs ~$5,000/month minimum. A six-month committed PT locks ~$30,000 across the term — non-cancellable mid-commitment. An on-demand (no commitment) PT runs ~$100/hour, accumulating ~$2,400/day if forgotten. **A casual API call here costs more than most operators' entire monthly LLM bill.**

The substrate's job: make casual creation hard. AWS's job: enforce idempotency and contract terms.

## Decision

`BedrockProvider.createProvisionedModelThroughput(input)` with `clientRequestToken` **REQUIRED** in the substrate input type — even though AWS docs make it optional.

```ts
async createProvisionedModelThroughput(
  input: BedrockCreateProvisionedModelThroughputInput,
): Promise<BedrockCreateProvisionedModelThroughputResponse>;

interface BedrockCreateProvisionedModelThroughputInput {
  readonly clientRequestToken: string;  // REQUIRED — cost-safety guardrail
  readonly modelUnits: number;
  readonly provisionedModelName: string;
  readonly modelId: string;
  readonly commitmentDuration?: BedrockProvisionedModelCommitmentDuration;
  readonly tags?: ReadonlyArray<BedrockProvisionedThroughputTag>;
}

interface BedrockCreateProvisionedModelThroughputResponse {
  readonly provisionedModelArn: string;
}
```

### Why mandatory clientRequestToken?

AWS's `clientRequestToken` is the idempotency primitive: repeated POSTs with the same token return the **same** ARN without creating a duplicate PT. The substrate's contract upgrade:

- **AWS:** "Optional. Recommended for production workloads."
- **Substrate:** "Mandatory. Operator must mint a token before we'll call AWS."

The substrate-mandate forces operators to deliberately mint a token (typically `crypto.randomUUID()`) before any call goes through. This adds a tiny code-friction barrier that's:
- **Trivial for intentional creates.** One `import { randomUUID } from "node:crypto"; const token = randomUUID();` line.
- **Prohibitive for casual creates.** Operators trying to fire-and-forget a PT create get a typescript error or runtime rejection, prompting them to think about the operation.
- **Naturally retry-safe.** Operators store the token alongside the intent (e.g., in a workflow row); retry on failure reuses the same token; AWS dedupes server-side.

This guardrail is unique to PT creation. The other CREATE endpoints in the substrate (createBatch, createModelCustomizationJob, createInferenceProfile) make clientRequestToken **optional** because their cost weight is 100×-1000× lower. PT is the outlier.

### Boundary validation (pure, pre-flight)

`buildCreateProvisionedModelThroughputBody(input)` enforces AWS-documented constraints BEFORE fetch:

| Field | Constraint |
|---|---|
| `clientRequestToken` | length [1, 256], pattern `^[a-zA-Z0-9](-*[a-zA-Z0-9])*$` |
| `modelUnits` | integer in [1, 1000] |
| `provisionedModelName` | length [1, 63], pattern `^([0-9a-zA-Z][_-]?)+$` (slug-safe) |
| `modelId` | length [1, 2048] (no pattern — accepts foundation/custom/imported model ARNs or IDs) |
| `commitmentDuration` (optional) | "OneMonth" or "SixMonths" |
| `tags` (optional) | count ≤ 200; per-tag key length [1, 128], value length ≤ 256 |

Per-tag validation reports the index in the error message ("tag value length must be ≤ 256 at index 2") for crisp debugging on bulk tag payloads.

`modelUnits` upper bound at 1000 is generous. AWS allows higher with quota increase, but 1000 is operator-safety territory — a 1000-unit PT runs >$5M/month committed. If operators need higher, they raise the limit via the substrate (separate ADR) — not by squeaking past validation.

### Wire shape

```
POST /provisioned-model-throughput
Content-Type: application/json
Authorization: AWS4-HMAC-SHA256 ...

{
  "clientRequestToken": "...",
  "modelUnits": 1,
  "provisionedModelName": "tenant-a-pt",
  "modelId": "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0",
  "commitmentDuration": "OneMonth",     // optional
  "tags": [{ "key": "tenant", "value": "a" }]  // optional
}
```

Path is **singular** (`/provisioned-model-throughput`) for CREATE, **plural** (`/provisioned-model-throughputs`) for LIST/GET. Matches AWS conventions verbatim.

Response is minimal — only `provisionedModelArn`. Operators wanting full detail call `getProvisionedModelThroughput` next (the PT starts in `Creating` status and reaches `InService` after a few minutes).

## Cross-cutting invariants enforced

- **clientRequestToken is mandatory.** TypeScript-side required field. No auto-generation. No bypass. Substrate's contract upgrade over AWS's "recommended."
- **Cost-safety via friction.** The required-token rule forces a deliberate operator gesture before each create call.
- **Idempotent retry is supported by AWS server-side.** Substrate doesn't dedupe locally — operators store the token and retry; AWS returns the same ARN.
- **modelUnits capped at 1000.** Substrate-level upper bound on top of AWS's higher limit. Operators wanting >1000 file a separate request.
- **Tags are optional + cross-resource-compatible.** Tag operations from M2.X.5.aa.z.24 (tagResource / untagResource / listTagsForResource) work on PT ARNs post-creation.
- **No commitment auto-default.** `commitmentDuration` is optional — when omitted, AWS creates an on-demand (no-commit) PT. Substrate doesn't paper over this with a default; operators picking one-month/six-months MUST do so explicitly.
- **Symmetric error propagation.** 404 → not_found_error (modelId doesn't exist), 409 → conflict_error (name collision), 403 → permission_error, 429 → rate_limit_error, 402 → server-side capacity error.
- **Bedrock control plane: 20 read + 2 stop + 3 create + 4 delete + 3 tag + 1 update = 33 operations.**

## End-to-end semantic

```ts
import { randomUUID } from "node:crypto";
import { BedrockProvider } from "@crossengin/ai-providers-bedrock";

const bedrock = new BedrockProvider({...});

// Mint the token deliberately. Operators typically store it durably
// alongside the PT-create intent (workflow row, DB record, etc.) so
// retries can reuse it for AWS-side idempotency.
const token = randomUUID();

// Create an on-demand PT (no commitment) — accumulates ~$100/hour.
const { provisionedModelArn } = await bedrock.createProvisionedModelThroughput({
  clientRequestToken: token,
  modelUnits: 1,
  provisionedModelName: "tenant-a-pt",
  modelId: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0",
});

// Or with a one-month commitment — locks ~$5K, gets a price discount.
await bedrock.createProvisionedModelThroughput({
  clientRequestToken: token,
  modelUnits: 1,
  provisionedModelName: "tenant-a-pt",
  modelId: "...",
  commitmentDuration: "OneMonth",
  tags: [{ key: "tenant", value: "a" }, { key: "owner", value: "platform-team" }],
});

// Poll for InService status (PT creation takes a few minutes).
let pt = await bedrock.getProvisionedModelThroughput(provisionedModelArn);
while (pt.status === "Creating") {
  await new Promise((r) => setTimeout(r, 30_000));
  pt = await bedrock.getProvisionedModelThroughput(provisionedModelArn);
}
```

Idempotent retry pattern:

```ts
// Operator-side: persist the token before calling AWS.
await db.query("INSERT INTO pending_pts (token, intent) VALUES ($1, $2)", [token, JSON.stringify(intent)]);

// Make the call; on failure, the next workflow run can reuse the same token.
try {
  await bedrock.createProvisionedModelThroughput({ clientRequestToken: token, ... });
} catch (err) {
  // Retry later with the SAME token; AWS dedupes server-side.
}
```

## Alternatives considered

- **Make `clientRequestToken` optional (match AWS verbatim).**
  - **Considered.** Symmetric with createBatch, createInferenceProfile, etc.
  - **Cons.** Removes the deliberation friction. PT cost weight (100×-1000× higher) justifies the asymmetric contract.
  - **Decision.** Mandatory in the substrate.

- **Auto-generate the token if missing.**
  - **Considered.** Operator convenience.
  - **Cons.** Defeats the idempotency contract — every retry creates a NEW PT (auto-generated different tokens). Worst-case: PT-cost duplication on transient failures.
  - **Decision.** No auto-gen.

- **Add a `confirmedCostUsdUpperBound` parameter that operators must pass.**
  - **Considered.** Even stronger guardrail.
  - **Cons.** Substrate would need a per-model pricing table that drifts as AWS adjusts pricing. Maintenance burden. Mandatory token is sufficient deliberate-gesture friction.
  - **Decision.** Defer; operator-side cost-projection can be wrapped in operator code.

- **Add a `dryRun` parameter that returns the would-be cost without creating.**
  - **Considered.** Useful for cost-projection workflows.
  - **Cons.** AWS doesn't expose dryRun on CreatePT. Substrate-side simulation would need the pricing table from the previous alternative.
  - **Decision.** Defer.

- **Default `commitmentDuration` to undefined explicitly to surface the no-commit cost.**
  - **Considered.** Done already — undefined means no commit, no surprise commitment.
  - **Decision.** Keep as is. AWS contract preserved.

- **Reject `modelUnits > 10` (more aggressive cost-safety).**
  - **Considered.** Smaller units cap.
  - **Cons.** Some legitimate workloads need 50+ units (high-throughput tenants). 1000 is the substrate's defensive ceiling; operators with quota-bumps need >1000 file a separate substrate change.
  - **Decision.** 1000 cap.

- **Substrate-side deduplication via a local clientRequestToken cache.**
  - **Considered.** Reject duplicate token without AWS round-trip.
  - **Cons.** AWS already dedupes. Local cache adds complexity, stale-cache risk, and operator confusion ("why did the call succeed silently?"). Trust AWS.
  - **Decision.** No local dedup.

- **Allow `modelId` to accept just a model slug (e.g., `anthropic.claude-3-sonnet`) and auto-expand to ARN.**
  - **Considered.** Operator ergonomics.
  - **Cons.** ARN expansion needs region awareness, account ID, and the foundation-model-vs-custom-model distinction. AWS accepts both; substrate doesn't second-guess.
  - **Decision.** Pass through as-is.

- **Substrate-side polling for `Creating → InService` status (block until ready).**
  - **Considered.** Operator convenience.
  - **Cons.** Substrate is the transport. Polling logic belongs in operator code (workflows, retries). Mixing them adds state to the provider.
  - **Decision.** Return immediately with the ARN; operators poll.

## Consequences

- **56 packages + 1 app, 127 meta-schema tables, 7,899 tests** (+39 from M2.X.5.aa.z.27: 23 in `provisioned-throughput-api.test.ts` covering body builder boundaries + response parser, 16 in `provider.test.ts` covering wire shape + pre-flight + error propagation + idempotency).
- **Bedrock control plane: 20 read + 2 stop + 3 create + 4 delete + 3 tag + 1 update = 33 operations.**
- **Closes ADR-0147 Q1.**
- **Cost-safety guardrail is unique to this endpoint.** The mandatory `clientRequestToken` rule asymmetry from other CREATEs documents the cost-weight concern in the type system.
- **Operator idempotency story works end-to-end.** Token stored alongside intent → retry-safe → AWS dedupes server-side.
- **modelUnits cap at 1000 is substrate-side defensive.** AWS allows higher with quota; operators wanting >1000 file a separate substrate change.
- **PT mutation half-done.** Create shipped; Update / Delete remain. Both are easier to add safely now that the safety pattern is established.

## Open questions

- **Q1:** Should the substrate add `updateProvisionedModelThroughput` (change `desiredModelArn` for in-flight model migration)?
  - _Current direction:_ Yes — natural pairing. PATCH semantics, same cost-safety token rule (or relax since update doesn't usually multiply cost). Separate milestone.
- **Q2:** Should the substrate add `deleteProvisionedModelThroughput`?
  - _Current direction:_ Yes. Committed PTs can't be deleted mid-commitment (AWS returns 409); on-demand PTs delete cleanly. Separate milestone.
- **Q3:** Should there be a `createOrLookup` helper that catches 409 + returns the existing PT?
  - _Current direction:_ Operator-side helper. Three-line `try`/`catch` wrap with `getProvisionedModelThroughput` or `listProvisionedModelThroughputs({nameContains})`. Substrate is transport.
- **Q4:** Should the substrate emit a `RouterInstrumentation`-style event on PT creation (audit trail)?
  - _Current direction:_ Out of scope. PT creation is a control-plane mutation, not an LLM call. A future `BedrockControlPlaneInstrumentation` would cover it.
- **Q5:** Pricing-table-aware cost projection / dry-run support?
  - _Current direction:_ Operator-side workflow. Substrate doesn't maintain pricing tables; AWS changes pricing.
- **Q6:** Auto-poll until `InService` status?
  - _Current direction:_ Operator-side. Workflow runtime (M3) is the natural home for the polling loop.
- **Q7:** Should there be a higher-level `provisionThroughput(intent)` workflow that combines persistence + idempotent retry + status polling?
  - _Current direction:_ Yes — would live in a higher-level package (`@crossengin/bedrock-helpers` or similar). Future enhancement.
- **Q8:** Should the substrate enforce naming conventions (e.g., `^[a-z]+-pt$` prefix)?
  - _Current direction:_ No — operator policy, not substrate concern. AWS pattern is enforced; operator-specific naming is wrapped above.
