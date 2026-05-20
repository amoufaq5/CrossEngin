# ADR-0136: Bedrock DELETE control-plane surfaces — first three deletes (Phase 2 M2.X.5.aa.z.21)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0071 (M2.9 Bedrock provider), ADR-0116 (M2.X.5.aa.z.14 getCustomModel), ADR-0114 (M2.X.5.aa.z.12 getImportedModel), ADR-0110 (M2.X.5.aa.z.8 getGuardrail), ADR-0127 (M2.X.13 not_found_error), ADR-0134 (M6.6.y router not-found short-circuit) |

## Context

The Bedrock control plane now has 18 read + 2 stop + 1 create operations (ADR-0105 through ADR-0131). What it does NOT have: any DELETE operation. The substrate cannot remove resources it created. Operators must drop to AWS CLI or console to:

- Delete a no-longer-used **custom model** (post fine-tune cleanup; cost reduction).
- Delete a no-longer-used **imported model** (rejected upload; switch to a different source format).
- Delete a deprecated **guardrail** (policy retirement; rebuild from scratch).

These three resources are the closest cousins of the existing GET endpoints (ADR-0116, ADR-0114, ADR-0110) and the natural first DELETE batch. They share:

1. **Resource is path-identifier**: `/custom-models/{id}`, `/imported-models/{id}`, `/guardrails/{id}` (matching the GET URI).
2. **Operator-owned lifecycle**: the operator created the resource via createModelCustomizationJob / createImportedModel / createGuardrail; the operator deletes it.
3. **Clear AWS semantics**: 204 No Content on success; 404 ResourceNotFoundException (already gone or never existed); 409 ConflictException (in-use); 403/429 as usual.

M2.X.5.aa.z.21 ships the three deletes + a shared `signedControlPlaneDelete` transport.

## Decision

### New transport: `signedControlPlaneDelete`

```ts
private async signedControlPlaneDelete(input: {
  readonly path: string;
  readonly query?: Record<string, string>;
}): Promise<void>;
```

Mirrors `signedControlPlaneGet` exactly except:
- HTTP method is `DELETE` (passed to both `signRequest` and `fetch`).
- Returns `void` instead of response body text (DELETE responses are typically empty / `204 No Content`).
- Query is `optional` (default `{}`) — most delete endpoints take no query, but `deleteGuardrail` takes optional `?guardrailVersion=X`.

The signing rail uses Sig v4 with the empty body and the same `host` / `region` / `service` / `credentials` resolution as the existing GET / POST transports. No new infrastructure: the `signRequest` function already accepts any HTTP method via its `method: string` field (ADR-0071's M2.9 design).

### Three new methods on `BedrockProvider`

```ts
async deleteCustomModel(modelIdentifier: string): Promise<void>;
async deleteImportedModel(modelIdentifier: string): Promise<void>;
async deleteGuardrail(
  guardrailIdentifier: string,
  guardrailVersion?: string,
): Promise<void>;
```

Each:
- Validates the identifier is a non-empty string BEFORE issuing fetch (same shape as get / stop methods).
- URI-encodes the identifier (handles `:` in ARNs).
- Delegates to `signedControlPlaneDelete`.
- Returns `void` on any 2xx (200, 202, 204 all OK).
- Propagates 404 as `not_found_error`, 409 as `conflict_error`, 403 as `permission_error`, 429 as `rate_limit_error`, 5xx as `server_error`, network failures as `network_error`.

`deleteGuardrail` carries the same optional `guardrailVersion` parameter as `getGuardrail`. Omitting it deletes the whole guardrail (all versions); providing it deletes that specific version. Matches AWS semantics.

## Cross-cutting invariants enforced

- **Same shape as GET / stop endpoints.** Operators learning one delete pattern know all three.
- **Boundary validation first.** Empty-string / empty-version checks throw `invalid_request_error` BEFORE any AWS call. Saves cost + load.
- **404 propagates verbatim (caller decides idempotency).** This is the most important semantic decision. Two options were considered:
  1. **404 → success (silent idempotency).** The substrate decides "the resource is gone, so the operator's intent is satisfied; return void." Simpler caller code.
  2. **404 → not_found_error (caller decides).** The substrate reports verbatim what AWS returned; the caller `catch`es and chooses behavior.
  - **Decision: (2).** Reasons:
    - **ADR-0134 router invariant.** The router short-circuits on `isNotFoundError`. If the provider swallowed 404s, the router would never see them — and other callers that DO want the signal (e.g., "verify the resource is gone before retrying createImportedModel") would lose it.
    - **Predicate composition pattern.** Operators wanting silent idempotency write `try { await delete(); } catch (e) { if (!isNotFoundError(e)) throw e; }`. Three lines. The reverse (provider-swallowed 404, caller wants the signal) is impossible without rebuilding the error.
    - **Symmetry with the rest of the package.** Every get / stop / create endpoint propagates 404 as `not_found_error`. Deletes follow the same rule.
- **Pre-flight check before fetch.** A blank identifier throws before fetch is called (test asserts the fetch impl is never reached).
- **Control-plane host only.** Tests assert the URL contains `bedrock.{region}.amazonaws.com` and NOT `bedrock-runtime.`. The runtime host is unauthorized for control-plane operations.
- **No swallowing of unexpected statuses.** 2xx → resolve void. Anything else → throw via `fromHttpResponse`. No silent "200 means empty body" assumptions.
- **DELETE bodies are empty.** `body.byteLength === 0` test asserts the request payload is empty (required by Sig v4 for DELETE).

## End-to-end semantic

```ts
import { BedrockProvider } from "@crossengin/ai-providers-bedrock";
import { isNotFoundError, isConflictError } from "@crossengin/ai-providers";

const bedrock = new BedrockProvider({
  accessKeyId, secretAccessKey, region: "us-east-1",
});

// Caller-decided idempotent delete (silent on already-gone resources):
try {
  await bedrock.deleteCustomModel("my-cm-id");
} catch (err) {
  if (isNotFoundError(err)) {
    // Resource already gone — operator's intent satisfied.
    return;
  }
  if (isConflictError(err)) {
    // Resource in use (e.g., provisioned throughput attached).
    return handleInUseError(err);
  }
  throw err;
}

// Strict delete (caller wants to know if the resource didn't exist):
await bedrock.deleteCustomModel("my-cm-id");  // throws on 404
```

## Alternatives considered

- **Bundle delete with stop into a single "lifecycle" method.**
  - **Considered.** Some AWS resources (jobs, batches) only support stop; others (models, guardrails) only support delete. A combined "terminate" abstraction.
  - **Cons.** Different semantics, different paths, different post-condition. AWS keeps them separate; the substrate should too.
  - **Decision.** Keep separate.

- **Make 404 silently succeed (idempotent delete by default).**
  - **Considered.** Most operator workflows want "make this gone, however we get there."
  - **Cons.** Eliminates the signal for callers that need it (router short-circuit, verify-then-recreate workflows). Three-line caller wrapper for the common case is fine.
  - **Decision.** Propagate 404 as `not_found_error`. Document the wrap pattern.

- **Ship all DELETE endpoints in one milestone (custom-model, imported-model, guardrail, model-customization-job, model-import-job, inference-profile, batch-job).**
  - **Considered.** Bundle.
  - **Cons.** Each has different semantics (jobs use stop, not delete; inference profiles aren't user-owned in the same way; batches are stop-not-delete). Bundling muddles the proposal.
  - **Decision.** Three deletes that share the path/identifier shape. Future DELETE additions get their own ADRs.

- **Use a single generic `deleteResource(path)` method on the provider.**
  - **Considered.** DRY.
  - **Cons.** Loses type safety on the identifier (a custom-model ID is structurally different from a guardrail ID with optional version). Loses discoverability — operators search "deleteCustomModel" via IDE autocomplete.
  - **Decision.** Three named methods, one shared private transport.

- **Add a `force?: boolean` parameter to override 409 ConflictException.**
  - **Considered.** Operators want "delete it now."
  - **Cons.** AWS doesn't expose a force flag on these endpoints. Substrate can't fabricate one. Operator must resolve the conflict (detach provisioned throughput, etc.) before retrying.
  - **Decision.** No force flag. 409 propagates as `conflict_error`.

- **Auto-retry delete with the GET pattern: on 404, look up via list and retry.**
  - **Considered.** "Resource isn't there? Maybe it had a different identifier. Look it up."
  - **Cons.** Operator-specific workflow. Not provider concern. Future "deleteOrLookup" helper is straightforward (3 lines).
  - **Decision.** Operators write their own reconciliation.

- **Match `getGuardrail`'s `guardrailVersion`-omitted-means-latest behavior on delete.**
  - **Considered.** Symmetric default.
  - **Cons.** AWS docs say omitting version on delete deletes the WHOLE guardrail (all versions). On GET, omitting version returns the latest. They're explicitly different. Following AWS semantics.
  - **Decision.** AWS semantics: omit-version = delete all; provide-version = delete that version.

## Consequences

- **56 packages + 1 app, 121 meta-schema tables, 7,597 tests** (+28 from M2.X.5.aa.z.21: all in `provider.test.ts`). All green, zero type errors.
- **First DELETE write surfaces on the Bedrock control plane.** Operators can fully manage custom-model / imported-model / guardrail lifecycle from the substrate.
- **`signedControlPlaneDelete` transport added.** Reusable for future DELETE endpoints (deleteInferenceProfile, deleteModelInvocationJob, etc.).
- **404 propagation pattern documented.** Future DELETE endpoints follow the same caller-decides-idempotency rule.
- **Router short-circuit (M6.6.y) earns its keep on delete-after-already-deleted workflows.** When a delete fires from inside an automated lifecycle pipeline, a 404 short-circuits to the operator's handler instead of falling over to a different provider (which doesn't even know about Bedrock identifiers).
- **Test coverage doubles for the three corresponding GET endpoints' delete partners.** Each delete has ~10 tests covering the success path, identifier validation, all four 4xx classifiers (404, 409, 403, 429), and network error.

## Open questions

- **Q1:** Should there be a `deleteModelCustomizationJob` / `deleteModelImportJob`?
  - _Current direction:_ AWS doesn't expose delete for these (they age out / get archived). `stopModelCustomizationJob` and `stopBatch` cover the lifecycle. Skip.
- **Q2:** Should there be a `deleteInferenceProfile`?
  - _Current direction:_ AWS supports delete for application-inference-profiles (operator-owned) but NOT for system-inference-profiles (AWS-owned). A future milestone could add it with a guard against system profiles.
- **Q3:** Should `deleteGuardrail` validate `guardrailVersion` format (numeric, DRAFT, etc.)?
  - _Current direction:_ No — AWS accepts variable formats. Empty-string check is enough. AWS rejects malformed versions with a clear 400.
- **Q4:** Should the substrate expose a "deleteOrLookup" helper that silently succeeds on 404?
  - _Current direction:_ Operator workflow, not provider concern. Three-line wrap pattern documented in this ADR. Defer.
- **Q5:** Should DELETE operations be subject to additional safety checks (confirm prompt, dry-run flag)?
  - _Current direction:_ Not on the provider. Safety belongs to a higher layer (CLI confirm, workflow approval step). Provider is the raw transport.
- **Q6:** Should there be a bulk-delete (deleteCustomModels via a list of ARNs)?
  - _Current direction:_ No — AWS doesn't expose bulk delete. Operator iterates: `for (const id of ids) { try { await deleteCustomModel(id); } catch (e) { if (!isNotFoundError(e)) throw e; } }`. Substrate is single-resource by AWS's design.
- **Q7:** Future DELETE rollout order?
  - _Current direction:_ Next batch should be deleteInferenceProfile (application-only) + deletePromptManagementResource (when M2.9.X covers Prompt Management) + deleteFlowFlow / deleteFlowVersion (when M2.9.X covers Flows).
