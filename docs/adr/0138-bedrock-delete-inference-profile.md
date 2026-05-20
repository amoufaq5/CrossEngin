# ADR-0138: Bedrock deleteInferenceProfile with system-profile guard (Phase 2 M2.X.5.aa.z.22)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0111 (M2.X.5.aa.z.9 listInferenceProfiles), ADR-0112 (M2.X.5.aa.z.10 getInferenceProfile), ADR-0136 (M2.X.5.aa.z.21 first three deletes) |

## Context

ADR-0136 (M2.X.5.aa.z.21) shipped the first three Bedrock DELETE surfaces: `deleteCustomModel`, `deleteImportedModel`, `deleteGuardrail`. ADR-0136 Q2 lined up the next DELETE for a follow-up:

> Q2: Should there be a `deleteInferenceProfile`?
> _Current direction:_ AWS supports delete for application-inference-profiles (operator-owned) but NOT for system-inference-profiles (AWS-owned). A future milestone could add it with a guard against system profiles.

M2.X.5.aa.z.22 closes that.

The complication that makes this milestone different from the three deletes in M2.X.5.aa.z.21: **the Bedrock `inference-profiles` namespace has TWO kinds of resources sharing the same path shape**.

- `type === "APPLICATION"` — operator-created, operator-owned, operator-deletable.
- `type === "SYSTEM_DEFINED"` — AWS-owned, immutable from the operator's side. AWS rejects delete attempts.

If the substrate simply issues `DELETE /inference-profiles/{id}` blindly, an operator passing a system-profile ARN gets an opaque `400 ValidationException` back from AWS. The substrate can do better: refuse pre-flight, with a clear message naming the profile and explaining why.

## Decision

`BedrockProvider.deleteInferenceProfile(profileIdentifier)` with mandatory pre-flight GET that enforces a system-profile guard.

```ts
async deleteInferenceProfile(profileIdentifier: string): Promise<void> {
  if (profileIdentifier.length === 0) {
    throw new BedrockError({
      kind: "invalid_request_error",
      message: "deleteInferenceProfile: profileIdentifier must be a non-empty string",
    });
  }
  const detail = await this.getInferenceProfile(profileIdentifier);
  if (detail.type !== "APPLICATION") {
    throw new BedrockError({
      kind: "invalid_request_error",
      message: `deleteInferenceProfile: cannot delete ${detail.type} profile '${profileIdentifier}'. Only APPLICATION-type profiles are operator-owned and deletable.`,
    });
  }
  const path = `/inference-profiles/${encodeURIComponent(profileIdentifier)}`;
  await this.signedControlPlaneDelete({ path });
}
```

The implementation:

1. Validates the identifier non-empty (same as every other endpoint).
2. **Pre-flight GET** via `getInferenceProfile(profileIdentifier)`. This call serves three purposes simultaneously:
   - Verify the profile exists (404 → not_found_error). 
   - Verify the caller has GET permission (403 → permission_error).
   - Read the profile's `type` so the guard can fire.
3. If `type !== "APPLICATION"`, throw `invalid_request_error` with a message naming the profile and type. **No DELETE is ever issued** for system profiles.
4. Otherwise, DELETE via the shared `signedControlPlaneDelete` transport (ADR-0136).

## Cross-cutting invariants enforced

- **No accidental deletion of SYSTEM_DEFINED profiles, ever.** Even if AWS's behavior changed to silently accept system-profile deletes, the substrate would still refuse. Defense-in-depth.
- **Clear error message.** The guard error names the profile ID and the type, so operators reading logs immediately understand WHY the delete was rejected.
- **Pre-flight ALSO surfaces 404 / 403 cleanly.** A delete request against a non-existent profile gets a `not_found_error` rather than first issuing DELETE (which might 404 anyway but adds a round-trip's worth of AWS load).
- **No silent retry / race-bypass.** If the profile is deleted between GET and DELETE (race window), the DELETE returns 404 — the substrate propagates that verbatim. Same idempotency-via-isNotFoundError pattern as ADR-0136.
- **The guard is mandatory, not optional.** No `bypassSystemGuard?: boolean` flag. The substrate's contract is "this method only deletes APPLICATION profiles." Operators wanting to bypass would use `signedControlPlaneDelete` directly, but that's private.
- **Permissions are layered.** A caller can have `bedrock:GetInferenceProfile` without `bedrock:DeleteInferenceProfile`. Pre-flight catches missing GET. The DELETE call catches missing DELETE.

## End-to-end semantic

```ts
import { BedrockProvider } from "@crossengin/ai-providers-bedrock";
import { isInvalidRequestError, isNotFoundError } from "@crossengin/ai-providers";

const bedrock = new BedrockProvider({...});

// Common case: operator-owned APPLICATION profile.
await bedrock.deleteInferenceProfile("ip-app-abc");  // resolves void

// System profile (e.g., an AWS-owned cross-region profile).
try {
  await bedrock.deleteInferenceProfile("us.anthropic.claude-3-sonnet");
} catch (err) {
  if (isInvalidRequestError(err)) {
    // Caught by the pre-flight guard. Message: "cannot delete SYSTEM_DEFINED..."
    log.warn(err.message);
    return;
  }
  throw err;
}

// Idempotent delete (resource may already be gone):
try {
  await bedrock.deleteInferenceProfile(id);
} catch (err) {
  if (!isNotFoundError(err)) throw err;
}
```

## Alternatives considered

- **Skip the pre-flight; let AWS reject system-profile deletes with its own error.**
  - **Considered.** Saves one round-trip.
  - **Cons.** Opaque error message ("ValidationException: cannot delete this resource"). Operators don't immediately see WHICH constraint was violated. With the guard, they see "SYSTEM_DEFINED profile" + the identifier — actionable.
  - **Decision.** Pre-flight. The 1-RTT cost is acceptable on a DELETE (operator action, not in a hot path).

- **Validate by ARN-shape alone (system profiles have a distinctive ARN structure).**
  - **Considered.** No round-trip needed.
  - **Cons.** ARN shapes evolve. The substrate would need to know all current + future system-profile ARN patterns. The `type` field is authoritative and stable.
  - **Decision.** Trust the `type` field.

- **Mandate that callers pass `type` as an extra argument.**
  - **Considered.** `deleteInferenceProfile(id, type)`. Operator says "I want to delete this APPLICATION profile"; substrate verifies.
  - **Cons.** Footgun. Operator might pass `"APPLICATION"` for a profile that's actually `"SYSTEM_DEFINED"` (typo, bad cache, etc.). Substrate would trust the operator. Pre-flight is the safer source of truth.
  - **Decision.** No type parameter. Pre-flight reads the actual value.

- **Cache the type lookup (one-time per identifier).**
  - **Considered.** Multiple deletes of the same profile would skip the second GET.
  - **Cons.** Cache invalidation. Type changes are rare-to-impossible, but the cache itself is a complication. Profiles get deleted, then recreated with same ID under a different type. The cache lies. Defer.
  - **Decision.** No cache. PG-style read every time.

- **Add an `--allow-system-delete` flag (admin-only escape hatch).**
  - **Considered.** "Sometimes you really do want to delete a system profile."
  - **Cons.** AWS doesn't allow it. The substrate cannot bypass AWS's enforcement. The flag would be cargo-cult — fires the DELETE, AWS rejects with 400. Same end state.
  - **Decision.** No flag.

- **Return a structured `DeleteResult` instead of `void` (e.g., `{deleted: true, profileType: "APPLICATION"}`).**
  - **Considered.** Audit-friendly.
  - **Cons.** Inconsistent with every other delete method on the provider. Operators wanting the profile type can pre-flight themselves with `getInferenceProfile`.
  - **Decision.** Return `void`. Symmetric with ADR-0136's three deletes.

## Consequences

- **56 packages + 1 app, 122 meta-schema tables, 7,626 tests** (+13 from M2.X.5.aa.z.22: all in `provider.test.ts`). All green, zero type errors.
- **Bedrock control plane: 18 read + 2 stop + 1 create + 4 delete = 25 operations.** First "smart" delete with a pre-flight guard.
- **Closes ADR-0136 Q2.**
- **Establishes the pre-flight-guard pattern for future "two-typed" resources.** If AWS adds more namespaces where some resources are AWS-owned and others operator-owned (e.g., a future "guardrail templates" surface), the same pattern applies.
- **Operator audit trail unchanged.** Higher layers (workflow runtime, gateway audit) record the DELETE attempt regardless of guard outcome. The guard rejection is logged on the operator side.
- **Pre-flight cost: 1 extra GET per delete.** Acceptable for DELETE (operator action), would be expensive for hot-path operations.

## Open questions

- **Q1:** Should there be a `tryDeleteInferenceProfile` variant that returns `{deleted: boolean, reason?: "system_profile" | "not_found" | "in_use"}` instead of throwing?
  - _Current direction:_ Maybe — for ergonomic batch operations. Defer to operator feedback.
- **Q2:** What about future application-inference-profile mutation (updateInferenceProfile)?
  - _Current direction:_ AWS supports `UpdateInferenceProfile` for APPLICATION profiles (description, tags). Future milestone; same guard pattern applies.
- **Q3:** Should the substrate expose `createInferenceProfile` (for APPLICATION-type profiles)?
  - _Current direction:_ Yes — natural pairing. Future milestone. Once paired, operators have full APPLICATION lifecycle (create + read + delete) on the substrate.
- **Q4:** Should the guard accept any non-SYSTEM_DEFINED type (e.g., a hypothetical future "INVITED" or "SHARED" type) or strictly require "APPLICATION"?
  - _Current direction:_ Strict "APPLICATION". New types would need explicit deletability decisions; default-deny is safer.
- **Q5:** What if pre-flight GET succeeds but the response is malformed (missing `type` field)?
  - _Current direction:_ `parseInferenceProfileDetail` throws on missing required fields, so the guard never sees a half-parsed profile. Failure surfaces as `api_error`.
- **Q6:** Should deletion of APPLICATION profiles that are CURRENTLY-being-invoked be allowed?
  - _Current direction:_ AWS surfaces this as 409 ConflictException. Substrate propagates as `conflict_error`. Operator decides retry behavior.
- **Q7:** Bulk delete (e.g., `deleteInferenceProfiles(ids)`)?
  - _Current direction:_ No bulk verb in AWS. Operator iterates; the substrate is single-resource by AWS design (same as ADR-0136 Q6).
