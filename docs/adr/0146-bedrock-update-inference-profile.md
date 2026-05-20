# ADR-0146: Bedrock updateInferenceProfile (PATCH with APPLICATION-only guard) (Phase 2 M2.X.5.aa.z.25)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0112 (M2.X.5.aa.z.10 getInferenceProfile), ADR-0138 (M2.X.5.aa.z.22 deleteInferenceProfile with system-profile guard), ADR-0142 (M2.X.5.aa.z.23 createInferenceProfile), ADR-0145 (M2.X.5.aa.z.24 cross-resource tagging) |

## Context

ADR-0142 (M2.X.5.aa.z.23) shipped `createInferenceProfile` and completed the APPLICATION-inference-profile create + list + get + delete cycle. ADR-0142 Q1 lined up the missing mutation surface:

> Q1: Should there be an `updateInferenceProfile` (for description / tags mutation)?
> _Current direction:_ Yes — AWS supports `UpdateApplicationInferenceProfile`. Future milestone. Same shape as create + the system-profile guard pattern from ADR-0138.

M2.X.5.aa.z.25 closes that.

Two operator pains exist without an update surface:
1. **Description drift.** Operator created `tenant-a-sonnet` with description "for tenant A" — but tenant A's owner changed. No way to update without delete + recreate (which destroys the ARN, breaking every downstream reference).
2. **Tags belong elsewhere.** Tags ARE already mutable via M2.X.5.aa.z.24 (`tagResource` / `untagResource`). This milestone does NOT touch tags — it's description-only.

AWS's `UpdateApplicationInferenceProfile` API:
- **Method:** PATCH (first PATCH operation on the Bedrock control plane)
- **URI:** `/inference-profiles/{inferenceProfileIdentifier}`
- **Body:** `{description?: string}` (description is the only mutable field)
- **Response:** Empty on success

## Decision

`BedrockProvider.updateInferenceProfile(profileIdentifier, input)` with mandatory pre-flight GET guard against SYSTEM_DEFINED profiles, mirroring `deleteInferenceProfile` (ADR-0138).

```ts
async updateInferenceProfile(
  profileIdentifier: string,
  input: BedrockUpdateInferenceProfileInput,
): Promise<void>;

interface BedrockUpdateInferenceProfileInput {
  readonly description?: string;
}
```

### New transport: `signedControlPlanePatch`

PATCH was not previously used on the Bedrock control plane. The new transport mirrors `signedControlPlanePost`:
- Sig v4 signing via existing `signRequest` (method: "PATCH")
- `content-type: application/json` header on the request
- Body bytes via `TextEncoder`
- Same 2xx → resolve void, 4xx/5xx → `fromHttpResponse` error propagation
- No query string variant (the path is the identifier; the body is the payload)

### Validation order (defensive)

1. **Identifier blank check.** Fast-fail before any input parsing.
2. **Input body builder.** `buildUpdateInferenceProfileBody(input)` requires AT LEAST ONE mutable field — currently just `description`. Empty input `{}` is rejected at the body-build stage.
3. **Pre-flight GET.** Issues `getInferenceProfile(profileIdentifier)` to verify existence + read the `type` field for the guard.
4. **APPLICATION-only guard.** If `detail.type !== "APPLICATION"`, throw `invalid_request_error` naming the profile and type. **No PATCH ever issued for system profiles.**
5. **PATCH.** Signs + sends the request.

Order matters: identifier and input validation are **pre-fetch** (free); pre-flight GET is the AWS round-trip; PATCH is the second round-trip. Catching validation errors locally saves both round-trips.

### Why PATCH (vs PUT)?

AWS uses PATCH semantically — only the explicitly-provided fields are updated; omitted fields are left unchanged. A PUT replaces the whole resource. Operators wanting "set description to undefined" would need a different mechanism; AWS doesn't expose one for inference profiles.

### Why description-only (not tags)?

Tags have a dedicated cross-resource surface from M2.X.5.aa.z.24 (`tagResource` / `untagResource`). Wiring tags into UpdateInferenceProfile too would create two paths to the same outcome — confusing for operators. UpdateInferenceProfile stays minimal: just description.

Future AWS additions (e.g., a hypothetical mutable `defaultModel` field) would extend `BedrockUpdateInferenceProfileInput` additively.

## Cross-cutting invariants enforced

- **No accidental update of SYSTEM_DEFINED profiles.** The guard is mandatory — no bypass flag. Symmetric with `deleteInferenceProfile` (ADR-0138).
- **Pre-flight cost: 1 extra GET per update.** Same trade-off as ADR-0138's delete. Operator workflow (rare op); not a hot path.
- **Clear error messages.** "cannot update SYSTEM_DEFINED profile 'ip-system-1'" surfaces the profile + type so operators reading logs see WHY.
- **First PATCH on the Bedrock control plane.** Pattern set for future mutation surfaces.
- **AWS contract preserved verbatim.** PATCH method, `/inference-profiles/{id}` path, body shape with optional `description`.
- **Pure boundary validation.** All checks happen in `buildUpdateInferenceProfileBody` before the AWS call.
- **Symmetric error propagation.** 404 → `not_found_error` (profile doesn't exist OR race-deleted between GET and PATCH), 403 → `permission_error` (have `GetInferenceProfile` but not `UpdateInferenceProfile`), 429 → `rate_limit_error`.
- **No partial-update side effects.** AWS PATCH is atomic; substrate doesn't override.

## End-to-end semantic

```ts
import { BedrockProvider } from "@crossengin/ai-providers-bedrock";
import {
  isInvalidRequestError,
  isNotFoundError,
} from "@crossengin/ai-providers";

const bedrock = new BedrockProvider({...});

// Update the description of an existing APPLICATION profile.
await bedrock.updateInferenceProfile("tenant-a-sonnet", {
  description: "for tenant A (renamed to Alpha LLC)",
});

// SYSTEM_DEFINED profile → guard blocks the update.
try {
  await bedrock.updateInferenceProfile("us.anthropic.claude-3-sonnet", {
    description: "anything",
  });
} catch (err) {
  if (isInvalidRequestError(err)) {
    // Caught by the pre-flight guard.
    log.warn(err.message);
    return;
  }
  throw err;
}

// Race window between GET and PATCH (profile deleted by another caller):
try {
  await bedrock.updateInferenceProfile(arn, { description: "..." });
} catch (err) {
  if (!isNotFoundError(err)) throw err;
  // Resource gone; operator workflow decides next step.
}

// Tags via the cross-resource surface (M2.X.5.aa.z.24):
await bedrock.tagResource({ resourceArn, tags: [{ key: "owner", value: "alpha" }] });
```

Full APPLICATION lifecycle now on the substrate: create + list + get + **update** + delete + tag.

## Alternatives considered

- **Include tag mutation in UpdateInferenceProfile.**
  - **Considered.** "One call to update everything."
  - **Cons.** Two paths to the same outcome confuses operators. M2.X.5.aa.z.24's cross-resource tagging is the canonical surface. Substrate stays single-purpose.
  - **Decision.** Description-only.

- **Use PUT semantics (replace the whole resource).**
  - **Considered.** Simpler mental model.
  - **Cons.** AWS uses PATCH. Substrate mirrors AWS. PUT would also raise a question: "how do I omit a field to mean 'leave unchanged'?" PATCH answers that natively.
  - **Decision.** PATCH.

- **Skip the system-profile guard (let AWS reject SYSTEM updates with its own error).**
  - **Considered.** Saves one round-trip.
  - **Cons.** Opaque error message ("ValidationException"). Pre-flight produces "cannot update SYSTEM_DEFINED profile 'ip-system-1'" — actionable. Symmetric with ADR-0138's delete-side guard.
  - **Decision.** Mandatory guard.

- **Cache the type lookup per session.**
  - **Considered.** Multiple updates to the same profile would skip the second GET.
  - **Cons.** Cache invalidation. Profile type changes are rare-to-impossible, but the cache itself is a complication. No cache.
  - **Decision.** Re-read on every update.

- **Make description required (no empty/null update).**
  - **Considered.** "Why call update if you're not changing anything?"
  - **Cons.** AWS allows PATCH with description-only OR additional future fields. Substrate's "at least one mutable field" rule already prevents empty updates. Operators wanting to update description-only pass `{description: "..."}`.
  - **Decision.** "At least one field" enforcement; current implementation requires description.

- **Return the updated profile detail (call getInferenceProfile post-PATCH).**
  - **Considered.** Save the operator a round-trip.
  - **Cons.** AWS returns void on success. Operators wanting full detail call `getInferenceProfile` next.
  - **Decision.** Return void. Symmetric with delete.

- **Add an `ifMatch` precondition header (optimistic concurrency).**
  - **Considered.** Prevent race-condition overwrites.
  - **Cons.** AWS doesn't expose ETag headers for inference profiles. The substrate can't fabricate concurrency control AWS doesn't support.
  - **Decision.** No precondition. Last-write-wins.

## Consequences

- **56 packages + 1 app, 127 meta-schema tables, 7,802 tests** (+21 from M2.X.5.aa.z.25: 6 in `inference-profiles-api.test.ts` covering the body builder, 15 in `provider.test.ts` covering wire shape + pre-flight guard + error propagation). All green, zero type errors.
- **Bedrock control plane: 18 read + 2 stop + 2 create + 4 delete + 3 tag + 1 update = 30 operations.** Operator now has full APPLICATION lifecycle on the substrate.
- **First PATCH operation on the Bedrock control plane.** `signedControlPlanePatch` transport added; reusable for future mutation surfaces (`updateGuardrail` if AWS adds one, etc.).
- **Closes ADR-0142 Q1.**
- **Pre-flight-guard pattern reused.** Symmetric with `deleteInferenceProfile` (ADR-0138). Operators learning one guard semantic know both.
- **No tag mutation overlap.** Tags continue via `tagResource` / `untagResource` from M2.X.5.aa.z.24.
- **Storage / observability impact: zero.** Operation is a single PATCH, no audit table addition (operator wiring to RouterInstrumentation if needed is out of scope).

## Open questions

- **Q1:** Should the substrate offer an "upsert profile description" helper (catch 404, create instead)?
  - _Current direction:_ Operator workflow. Three-line `try`/`catch` wrapper. Substrate is the transport.
- **Q2:** When AWS adds more mutable fields (e.g., a `routingConfig` for application profiles), should the substrate auto-include them in `BedrockUpdateInferenceProfileInput`?
  - _Current direction:_ Yes — additive type extension. Each new field comes with paired AWS-docs validation.
- **Q3:** Should `updateInferenceProfile` accept tags as a convenience (forwarding to `tagResource`)?
  - _Current direction:_ No. One canonical path per concern.
- **Q4:** Should the response include the updated profile detail (one round-trip down from two)?
  - _Current direction:_ AWS doesn't return it. Substrate matches AWS. Operators wanting full detail call `getInferenceProfile` next.
- **Q5:** PATCH on a 404'd profile after the pre-flight GET succeeds — should the substrate retry the GET to clarify the race?
  - _Current direction:_ No. Race-deleted 404 propagates as `not_found_error`; operator workflow decides retry vs accept.
- **Q6:** Should there be an `ifVersion` parameter (operator passes the last-seen `updatedAt` to detect concurrent modifications)?
  - _Current direction:_ AWS doesn't expose this. Out of scope.
- **Q7:** Should the substrate offer a `bulkUpdate` helper for many profiles?
  - _Current direction:_ Operator iterates. AWS doesn't have bulk APIs. 3-line wrap.
- **Q8:** Should the PATCH be retryable on 5xx (substrate-side retry)?
  - _Current direction:_ Out of scope. Retry lives at the router layer (M6.6 onward). Provider-level retry would duplicate.
