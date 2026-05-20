# ADR-0149: Bedrock updateProvisionedModelThroughput — PATCH for model migration + rename (Phase 2 M2.X.5.aa.z.28)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0146 (M2.X.5.aa.z.25 updateInferenceProfile / signedControlPlanePatch), ADR-0147 (M2.X.5.aa.z.26 PT inspection), ADR-0148 (M2.X.5.aa.z.27 createProvisionedModelThroughput) |

## Context

ADR-0148 / M2.X.5.aa.z.27 shipped the first PT mutation (create). ADR-0147 Q2 and ADR-0148 Q1 lined up the next:

> ADR-0147 Q2: Should the substrate add `updateProvisionedModelThroughput`?
> _Current direction:_ Yes when create is shipped. Same milestone pairing.
>
> ADR-0148 Q1: Should the substrate add `updateProvisionedModelThroughput` (change `desiredModelArn` for in-flight model migration)?
> _Current direction:_ Yes — natural pairing. PATCH semantics, same cost-safety token rule (or relax since update doesn't usually multiply cost). Separate milestone.

M2.X.5.aa.z.28 closes both. The substrate now supports two mid-life mutations on PT resources:
1. **Model migration** — change `desiredModelId` to a different model. AWS provisions new capacity for the desired model, then atomically swaps. The PT's ARN doesn't change.
2. **Rename** — change `desiredProvisionedModelName` to a new name.

Both fields are optional; at least one must be provided.

## Decision

`BedrockProvider.updateProvisionedModelThroughput(provisionedModelId, input)` reuses the `signedControlPlanePatch` transport from ADR-0146.

```ts
async updateProvisionedModelThroughput(
  provisionedModelId: string,
  input: BedrockUpdateProvisionedModelThroughputInput,
): Promise<void>;

interface BedrockUpdateProvisionedModelThroughputInput {
  readonly desiredModelId?: string;
  readonly desiredProvisionedModelName?: string;
}
```

### Why NO mandatory `clientRequestToken` (asymmetric from create)?

ADR-0148 makes `clientRequestToken` mandatory on `createProvisionedModelThroughput` because each create call risks a $5K+/month commitment. The update endpoint is different:

- **No new resources created.** Update mutates the existing PT in place; doesn't multiply cost.
- **No commitment extension.** AWS doesn't extend an existing commitment via update; the lock-in period is set at create time.
- **AWS doesn't expose `clientRequestToken` on this endpoint.** AWS's UpdateProvisionedModelThroughput has no idempotency token field. Substrate can't fabricate one.
- **Mutations are idempotent by nature.** A PATCH with the same body twice produces the same end state. No dedup needed.

So `clientRequestToken` is absent from the input type. The cost-safety guardrail from ADR-0148 is unique to create.

### Validation order

1. **Identifier blank check.** Fast-fail before input parsing.
2. **Input body builder.** `buildUpdateProvisionedModelThroughputBody(input)` requires AT LEAST ONE mutable field (desiredModelId OR desiredProvisionedModelName). Empty input `{}` rejected.
3. **PATCH.** Signs + sends via `signedControlPlanePatch`.

No pre-flight GET. Update doesn't have the SYSTEM_DEFINED-vs-APPLICATION distinction that delete/update-inference-profile have — PTs are always operator-owned. No guard needed.

### Boundary validation

| Field | Constraint |
|---|---|
| `desiredModelId` (optional) | length [1, 2048] — same as create's `modelId` |
| `desiredProvisionedModelName` (optional) | length [1, 63], pattern `^([0-9a-zA-Z][_-]?)+$` — same as create's `provisionedModelName` |

The `at-least-one-field` rule is the key safety: empty input is meaningless on PATCH and surfaces as a clear local error rather than an AWS round-trip returning 400.

### Wire shape

```
PATCH /provisioned-model-throughput/{provisionedModelId}
Content-Type: application/json
Authorization: AWS4-HMAC-SHA256 ...

{
  "desiredModelId": "arn:aws:bedrock:...",  // optional
  "desiredProvisionedModelName": "..."       // optional
}
```

Singular path matches create. Response is empty on 200 success.

After the PATCH, the PT enters `Updating` status (visible via `getProvisionedModelThroughput`). The `desiredModelArn` field on the PT reflects the target; `modelArn` continues to serve traffic until the migration completes (typically a few minutes). When migration finishes, AWS sets `modelArn = desiredModelArn` and the PT returns to `InService` status.

## Cross-cutting invariants enforced

- **No mandatory `clientRequestToken`.** Asymmetric from create. Update doesn't multiply cost.
- **At-least-one-field rule.** Empty input `{}` is rejected pre-fetch.
- **PATCH semantics.** Only provided fields update; omitted fields stay unchanged. Operators can change name without touching model, or migrate model without renaming.
- **No pre-flight GET guard.** PTs are always operator-owned; no SYSTEM-style ambiguity to disambiguate.
- **Reuses `signedControlPlanePatch` from ADR-0146.** No new transport.
- **Symmetric error propagation.** 404 → not_found_error, 409 → conflict_error (e.g., new name collision), 403 → permission_error, 429 → rate_limit_error.
- **Singular path for the resource.** `/provisioned-model-throughput/{id}` — same as create. List/Get use plural `/provisioned-model-throughputs`.
- **Bedrock control plane: 20 read + 2 stop + 3 create + 4 delete + 3 tag + 2 update = 34 operations.**

## End-to-end semantic

```ts
import { BedrockProvider } from "@crossengin/ai-providers-bedrock";

const bedrock = new BedrockProvider({...});
const ptId = "arn:aws:bedrock:us-east-1:123:provisioned-model/abc";

// Rename a PT (no model change).
await bedrock.updateProvisionedModelThroughput(ptId, {
  desiredProvisionedModelName: "tenant-a-pt-v2",
});

// Migrate a PT to a different model (rolling switch).
await bedrock.updateProvisionedModelThroughput(ptId, {
  desiredModelId: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
});

// Both at once.
await bedrock.updateProvisionedModelThroughput(ptId, {
  desiredModelId: "...",
  desiredProvisionedModelName: "...",
});

// Poll until migration completes.
let pt = await bedrock.getProvisionedModelThroughput(ptId);
while (pt.status === "Updating") {
  await new Promise((r) => setTimeout(r, 30_000));
  pt = await bedrock.getProvisionedModelThroughput(ptId);
}
// At this point, pt.modelArn === pt.desiredModelArn.
```

The PT's ARN is stable across migration — downstream code calling InvokeModel against the PT continues to work transparently.

## Alternatives considered

- **Mandate `clientRequestToken` for symmetry with create.**
  - **Considered.** Uniform cost-safety contract across PT lifecycle.
  - **Cons.** Update doesn't create new resources or extend commitments. AWS doesn't expose the token on this endpoint. Forcing operators to mint one for no benefit adds friction without payoff.
  - **Decision.** No mandatory token on update.

- **Allow `modelUnits` mutation via update.**
  - **Considered.** Operator wants to scale up/down.
  - **Cons.** AWS doesn't expose this on UpdateProvisionedModelThroughput. Scaling needs a separate operation (or delete + recreate). Substrate can't fabricate it.
  - **Decision.** No `modelUnits` field on update.

- **Allow `commitmentDuration` mutation via update.**
  - **Considered.** Convert on-demand to committed mid-life for cost savings.
  - **Cons.** AWS doesn't expose this either. Operator must delete + recreate with the new commitment (and the old PT must finish billing first).
  - **Decision.** Out of scope. Operator workflow.

- **Add a pre-flight GET to verify the PT exists before PATCH.**
  - **Considered.** Better error message ("PT not found" vs AWS 404 raw).
  - **Cons.** AWS's 404 already classifies cleanly as `not_found_error`. The pre-flight would add a round-trip without adding info.
  - **Decision.** No pre-flight. Symmetric with createInferenceProfile (no guard).

- **Block updates while `status === "Updating"` (no overlapping migrations).**
  - **Considered.** Substrate-side serialization.
  - **Cons.** AWS handles the 409 ConflictException server-side. Substrate-side block would need a pre-flight GET (see above). Trust AWS.
  - **Decision.** Propagate AWS's 409 if it fires.

- **Auto-poll until `Updating → InService` completes (block until ready).**
  - **Considered.** Operator convenience.
  - **Cons.** Same rationale as create — polling belongs in operator workflow code. Substrate is the transport.
  - **Decision.** Return immediately; operators poll.

- **Combine update + status-polling into a single helper method.**
  - **Considered.** "I just want the migration to finish."
  - **Cons.** Would belong in a higher-level helper package (`@crossengin/bedrock-helpers`). Substrate stays minimal.
  - **Decision.** Future helper, separate package.

- **Allow `desiredModelArn` (full ARN) as an alias for `desiredModelId`.**
  - **Considered.** AWS accepts both.
  - **Cons.** Operator confusion — two field names for the same concept. AWS uses `desiredModelId` on the wire; substrate mirrors verbatim. The field accepts both ARN and short-ID values.
  - **Decision.** One field name.

## Consequences

- **56 packages + 1 app, 127 meta-schema tables, 7,922 tests** (+23 from M2.X.5.aa.z.28: 9 in `provisioned-throughput-api.test.ts` covering body builder, 14 in `provider.test.ts` covering wire shape + validation order + error propagation).
- **Bedrock control plane: 20 read + 2 stop + 3 create + 4 delete + 3 tag + 2 update = 34 operations.** Two updates on the substrate now: updateInferenceProfile (ADR-0146) and updateProvisionedModelThroughput (this).
- **Closes ADR-0147 Q2 + ADR-0148 Q1.**
- **PT lifecycle is now 3/4 complete on the substrate.** Create + Read + Update shipped; Delete remains (next milestone candidate).
- **PATCH transport reused.** `signedControlPlanePatch` from ADR-0146 carries the second PATCH endpoint — no new infrastructure.
- **Asymmetric cost-safety contract documented.** Create requires `clientRequestToken`; update does not. The asymmetry encodes the cost-weight semantic difference between the two operations.

## Open questions

- **Q1:** Should the substrate add `deleteProvisionedModelThroughput`?
  - _Current direction:_ Yes — next milestone candidate. Committed PTs return 409 mid-commitment per AWS; on-demand PTs delete cleanly. Substrate propagates the 409 verbatim.
- **Q2:** Should `updateProvisionedModelThroughput` support scaling `modelUnits` if AWS adds it?
  - _Current direction:_ Additive field — preserve `BedrockUpdateProvisionedModelThroughputInput` as an open shape. If AWS adds `desiredModelUnits` to UpdateProvisionedModelThroughput, substrate extends.
- **Q3:** Should there be a helper that combines update + status-polling into a single async call?
  - _Current direction:_ Yes — higher-level helper package (`@crossengin/bedrock-helpers` or similar). Future enhancement.
- **Q4:** Should the substrate emit a `RouterInstrumentation`-style event on PT updates (audit trail)?
  - _Current direction:_ Out of scope. PT mutation is control-plane, not LLM call. A future `BedrockControlPlaneInstrumentation` would cover.
- **Q5:** Should the update accept a `clientRequestToken` even though AWS doesn't (substrate-side dedup)?
  - _Current direction:_ No. Local dedup adds state to the provider; substrate is stateless transport. Operators wanting idempotent retry of updates store their own intent.
- **Q6:** Should `desiredProvisionedModelName` validation match AWS's exact pattern when it has been observed to differ from the create-time pattern?
  - _Current direction:_ Treat as same pattern unless empirically observed otherwise. AWS docs are sometimes inconsistent; substrate uses the same `^([0-9a-zA-Z][_-]?)+$` for both create and update.
- **Q7:** Should there be a "dry-run" mode that returns whether the update would succeed (without actually applying)?
  - _Current direction:_ AWS doesn't expose dryRun on UpdatePT. Out of scope.
- **Q8:** Should the substrate detect "no-op updates" (e.g., desiredProvisionedModelName equals current name) and skip the AWS call?
  - _Current direction:_ Operator-side concern. Substrate doesn't know the current state without a pre-flight GET. Pass-through to AWS; AWS returns 200 fast on no-ops.
