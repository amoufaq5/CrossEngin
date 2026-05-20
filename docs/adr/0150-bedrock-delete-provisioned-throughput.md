# ADR-0150: Bedrock deleteProvisionedModelThroughput — completes PT lifecycle (Phase 2 M2.X.5.aa.z.29)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0136 (signedControlPlaneDelete transport), ADR-0147 (PT inspection), ADR-0148 (createProvisionedModelThroughput), ADR-0149 (updateProvisionedModelThroughput) |

## Context

ADR-0147 / M2.X.5.aa.z.26 shipped PT inspection (get + list). ADR-0148 / M2.X.5.aa.z.27 added create with mandatory `clientRequestToken`. ADR-0149 / M2.X.5.aa.z.28 added update via PATCH. The remaining PT lifecycle verb: delete.

ADR-0147 Q3, ADR-0148 Q2, and ADR-0149 Q1 all lined up the same milestone:

> ADR-0147 Q3: Should the substrate add `deleteProvisionedModelThroughput`?
> _Current direction:_ Yes — pairs with create. Committed PTs cannot be deleted mid-commitment; AWS surfaces this as 409 ConflictException.
>
> ADR-0148 Q2: Should the substrate add `deleteProvisionedModelThroughput`?
> _Current direction:_ Yes. Committed PTs can't be deleted mid-commitment (AWS returns 409); on-demand PTs delete cleanly. Separate milestone.
>
> ADR-0149 Q1: Should the substrate add `deleteProvisionedModelThroughput`?
> _Current direction:_ Yes — next milestone candidate. Committed PTs return 409 mid-commitment per AWS; on-demand PTs delete cleanly. Substrate propagates the 409 verbatim.

M2.X.5.aa.z.29 closes all three. ADR-150 is also a milestone count — the 150th architecture decision since project bootstrap.

The interesting semantic: **AWS returns 409 ConflictException when an operator tries to delete a committed PT mid-commitment** (i.e., within the one-month or six-month lock-in period). The PT must age out of its commitment before it can be deleted. Substrate propagates the 409 verbatim — operators handle the commitment-aging workflow.

## Decision

`BedrockProvider.deleteProvisionedModelThroughput(provisionedModelId)`. Uses the existing `signedControlPlaneDelete` transport from ADR-0136. No pre-flight GET, no guard.

```ts
async deleteProvisionedModelThroughput(provisionedModelId: string): Promise<void>;
```

### Why no pre-flight GET guard?

The other DELETE in the inference-profiles family (`deleteInferenceProfile`, ADR-0138) runs a pre-flight GET to refuse SYSTEM_DEFINED profiles. PTs don't have that distinction — they are always operator-created and operator-deletable. No SYSTEM-vs-APPLICATION ambiguity exists. So:

- **No pre-flight GET.** Saves one round-trip per delete.
- **No guard.** AWS's own 409 handling is the canonical "you can't delete this" surface.

### Wire shape

```
DELETE /provisioned-model-throughput/{provisionedModelId}
Authorization: AWS4-HMAC-SHA256 ...
```

Empty body. Singular path (matches create + update). Response is empty on 200/204 success.

### 409 ConflictException semantic

The interesting case for operators: a one-month committed PT created on Day 1 cannot be deleted until Day 30+. Attempting to delete on Day 15 returns:

```json
{
  "__type": "ConflictException",
  "message": "Cannot delete provisioned model throughput within commitment period"
}
```

Substrate propagates this verbatim as `conflict_error` with `status === 409` and `code === "ConflictException"`. Operators decide the next step:

- **Wait it out.** Schedule a retry after the commitment expires.
- **Convert via update.** Some commitments can be relaxed via `updateProvisionedModelThroughput` (e.g., model migration without changing commitment).
- **Accept the cost.** Let the PT age out naturally; it stops billing after the commitment period.

The substrate doesn't try to be clever — operators with the right context handle the workflow.

## Cross-cutting invariants enforced

- **No pre-flight GET.** PTs are always operator-owned; no SYSTEM-vs-APPLICATION distinction requires a guard.
- **Reuses `signedControlPlaneDelete` from ADR-0136.** No new transport infrastructure.
- **Identifier blank check pre-fetch.** Standard fast-fail validation.
- **404 propagates as `not_found_error`.** Caller decides idempotency (mirrors ADR-0136 / ADR-0138 / ADR-0146 conventions).
- **409 propagates as `conflict_error` with code `ConflictException`.** The committed-mid-commitment block is the principal operator-facing 409 case here.
- **Symmetric error propagation.** 403 → `permission_error`, 429 → `rate_limit_error`, 5xx → `server_error`, network → `network_error`.
- **Singular path.** `/provisioned-model-throughput/{id}` — matches create + update; LIST/GET use plural `/provisioned-model-throughputs`.
- **Bedrock control plane: 20 read + 2 stop + 3 create + 5 delete + 3 tag + 2 update = 35 operations.**
- **PT lifecycle is 4/4 complete on the substrate.** Create + Read + Update + Delete all shipped.

## End-to-end semantic

```ts
import { BedrockProvider } from "@crossengin/ai-providers-bedrock";
import { isConflictError, isNotFoundError } from "@crossengin/ai-providers";

const bedrock = new BedrockProvider({...});

// Delete an on-demand (no-commit) PT — succeeds cleanly.
await bedrock.deleteProvisionedModelThroughput("pt-on-demand-abc");

// Delete a committed PT mid-commitment — propagates 409.
try {
  await bedrock.deleteProvisionedModelThroughput("pt-committed-xyz");
} catch (err) {
  if (isConflictError(err)) {
    // Committed PT not yet expired. Schedule retry after commitment ends.
    const pt = await bedrock.getProvisionedModelThroughput("pt-committed-xyz");
    log.warn(
      `PT ${pt.provisionedModelName} cannot be deleted yet; commitment expires ${pt.commitmentExpirationTime ?? "unknown"}`,
    );
    return;
  }
  throw err;
}

// Caller-decided idempotent delete (silent on already-gone):
try {
  await bedrock.deleteProvisionedModelThroughput(ptId);
} catch (err) {
  if (!isNotFoundError(err)) throw err;
}
```

Reconciliation workflow with paired inspection:

```ts
// Find all on-demand PTs (no commitment) for a deprecated model.
const { provisionedModelSummaries } = await bedrock.listProvisionedModelThroughputs({
  modelArnEquals: deprecatedModelArn,
});

const onDemandPts = provisionedModelSummaries.filter(
  (pt) => pt.commitmentDuration === undefined,
);

for (const pt of onDemandPts) {
  await bedrock.deleteProvisionedModelThroughput(pt.provisionedModelArn);
  log.info(`Deleted on-demand PT ${pt.provisionedModelName}`);
}
```

Full PT lifecycle on the substrate:

```ts
// 1. Create (mandatory clientRequestToken from ADR-0148)
const token = crypto.randomUUID();
const { provisionedModelArn } = await bedrock.createProvisionedModelThroughput({
  clientRequestToken: token,
  modelUnits: 1,
  provisionedModelName: "tenant-a-pt",
  modelId: foundationModelArn,
});

// 2. Read (ADR-0147)
const pt = await bedrock.getProvisionedModelThroughput(provisionedModelArn);

// 3. Update (ADR-0149)
await bedrock.updateProvisionedModelThroughput(provisionedModelArn, {
  desiredProvisionedModelName: "tenant-a-pt-v2",
});

// 4. Delete (this milestone)
await bedrock.deleteProvisionedModelThroughput(provisionedModelArn);
```

## Alternatives considered

- **Pre-flight GET to check commitment status before issuing DELETE.**
  - **Considered.** Avoid the 409 round-trip for committed PTs.
  - **Cons.** The 409 is the canonical AWS surface; substrate-side prevention duplicates the logic. Operators reading the `getProvisionedModelThroughput` response can check `commitmentExpirationTime` themselves before calling delete. The 409 error message is also clearer than a substrate-fabricated one.
  - **Decision.** No pre-flight. Propagate AWS's 409.

- **Add a `force` parameter that throws an `invalid_request_error` if the PT is committed.**
  - **Considered.** Substrate-side safety guard.
  - **Cons.** AWS doesn't accept a force flag — they ALWAYS reject committed-mid-commitment delete. Substrate-side "force" would be cargo-cult (no real effect on AWS behavior).
  - **Decision.** No force parameter.

- **Add a `waitForCommitmentExpiry` option that polls until the commitment expires + then deletes.**
  - **Considered.** Operator convenience.
  - **Cons.** Could block for 1-6 months. Belongs in a higher-level workflow helper, not the transport-level provider method.
  - **Decision.** Operator workflow concern.

- **Make `deleteProvisionedModelThroughput` silently succeed on 404 (idempotent delete by default).**
  - **Considered.** Eliminates the "is the PT gone yet?" lookup.
  - **Cons.** Same rationale as ADR-0136: 404 is information operators may need (e.g., to detect race conditions or surface "what did we delete?"). 3-line caller wrap for silent-idempotency.
  - **Decision.** Propagate 404 verbatim.

- **Mandate `clientRequestToken` like create.**
  - **Considered.** Symmetric safety contract.
  - **Cons.** Delete doesn't create new resources. Re-deleting the same PT (via 404) is harmless. AWS doesn't expose `clientRequestToken` on delete. No symmetric need.
  - **Decision.** No mandatory token.

- **Auto-poll until `status` transitions from `InService → Deleting → gone`.**
  - **Considered.** Operator convenience.
  - **Cons.** Polling belongs in operator code. Substrate is the transport.
  - **Decision.** Return immediately after the 200 response.

- **Add a higher-level `tearDownAllPtsForModel(modelArn)` helper.**
  - **Considered.** Reconciliation workflow.
  - **Cons.** Operator-side helper. Lives in `@crossengin/bedrock-helpers` or similar. Substrate stays minimal.
  - **Decision.** Future helper package.

## Consequences

- **56 packages + 1 app, 127 meta-schema tables, 7,933 tests** (+11 from M2.X.5.aa.z.29: all in `provider.test.ts` covering wire shape + error propagation + the 409 mid-commitment semantic).
- **Bedrock control plane: 20 read + 2 stop + 3 create + 5 delete + 3 tag + 2 update = 35 operations.**
- **PT lifecycle is 4/4 complete.** Create + Read + Update + Delete all shipped.
- **Closes ADR-0147 Q3 + ADR-0148 Q2 + ADR-0149 Q1.** Three deferred questions resolved.
- **No new transport infrastructure.** Reuses `signedControlPlaneDelete` from ADR-0136.
- **ADR-150 hits the milestone count.** 150 ADRs since project bootstrap, of which 124 are Phase 2 (ADR-0047 onward).
- **Committed-mid-commitment semantic surfaces cleanly.** Operators using `isConflictError(err) && err.code === "ConflictException"` discriminate the wait-it-out case from genuine conflicts.
- **Reconciliation workflows unblocked.** Operators decommissioning a custom model can `list → filter on-demand → delete each → propagate 409 on committed → schedule expiry retry`.

## Open questions

- **Q1:** Should the substrate emit a `RouterInstrumentation`-style event on PT deletion (audit trail)?
  - _Current direction:_ Out of scope. PT deletion is a control-plane mutation, not an LLM call. A future `BedrockControlPlaneInstrumentation` rail (separate from RouterInstrumentation) would cover it.
- **Q2:** Should there be a `deleteWhenExpired(provisionedModelArn)` helper that schedules the delete for after the commitment expires?
  - _Current direction:_ Workflow concern. The workflow runtime (M3) is the natural home for scheduled-action persistence. Future enhancement.
- **Q3:** Should `deleteProvisionedModelThroughput` accept a `dryRun?: boolean` to check whether the delete would succeed?
  - _Current direction:_ AWS doesn't expose dryRun. Operators get the same info from `getProvisionedModelThroughput` + `commitmentExpirationTime` inspection.
- **Q4:** Should the substrate add bulk delete (`deletePts(ids)`)?
  - _Current direction:_ AWS doesn't expose bulk. Operators iterate.
- **Q5:** Should there be commitment-expiration awareness in `listProvisionedModelThroughputs` (filter PTs whose commitment has expired)?
  - _Current direction:_ Operators compute client-side from the existing fields. No new filter needed.
- **Q6:** Should `deleteProvisionedModelThroughput` log a warning if `status === "Updating"` (potentially racy)?
  - _Current direction:_ AWS handles concurrent state via 409. Substrate doesn't need to log.
- **Q7:** Higher-level lifecycle helper combining all four PT verbs?
  - _Current direction:_ Future `@crossengin/bedrock-helpers` package. Substrate stays primitive.
- **Q8:** Should the substrate cache the commitment-expiry check (to avoid repeated `getProvisionedModelThroughput` calls during reconciliation)?
  - _Current direction:_ Operator-side concern. Substrate is stateless.
