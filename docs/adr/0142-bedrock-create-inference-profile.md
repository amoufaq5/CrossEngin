# ADR-0142: Bedrock createInferenceProfile (APPLICATION-only via copyFrom) (Phase 2 M2.X.5.aa.z.23)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0111 (M2.X.5.aa.z.9 listInferenceProfiles), ADR-0112 (M2.X.5.aa.z.10 getInferenceProfile), ADR-0138 (M2.X.5.aa.z.22 deleteInferenceProfile with system-profile guard) |

## Context

ADR-0138 (M2.X.5.aa.z.22) added `deleteInferenceProfile` with a pre-flight guard against SYSTEM_DEFINED profiles. ADR-0138 Q3 lined up the natural pairing:

> Q3: Should the substrate expose `createInferenceProfile` (for APPLICATION-type profiles)?
> _Current direction:_ Yes — natural pairing. Future milestone. Once paired, operators have full APPLICATION lifecycle (create + read + delete) on the substrate.

M2.X.5.aa.z.23 closes that Q.

AWS Bedrock's `CreateInferenceProfile` API is the operator-facing surface for creating **application-inference-profiles** that copy from a source — either a foundation model ARN OR a system-defined cross-region inference profile. The created profile is always `type=APPLICATION` (system profiles can't be created by operators; they're AWS-managed). With this method, operators have the full APPLICATION lifecycle:

- `createInferenceProfile(input)` — make it (M2.X.5.aa.z.23, this milestone)
- `listInferenceProfiles({typeEquals: "APPLICATION"})` — find it (M2.X.5.aa.z.9 / ADR-0111)
- `getInferenceProfile(id)` — inspect it (M2.X.5.aa.z.10 / ADR-0112)
- `deleteInferenceProfile(id)` — remove it (M2.X.5.aa.z.22 / ADR-0138)

## Decision

`BedrockProvider.createInferenceProfile(input)` returning the new `inferenceProfileArn` + `status`. Uses the existing `signedControlPlanePost` transport (ADR-0108) — no new infrastructure.

```ts
async createInferenceProfile(
  input: BedrockCreateInferenceProfileInput,
): Promise<BedrockCreateInferenceProfileResponse>;
```

### Input shape

```ts
export interface BedrockCreateInferenceProfileInput {
  readonly inferenceProfileName: string;
  readonly modelSource: BedrockInferenceProfileModelSource;
  readonly description?: string;
  readonly clientRequestToken?: string;
  readonly tags?: ReadonlyArray<BedrockInferenceProfileTag>;
}

export interface BedrockInferenceProfileModelSource {
  readonly copyFrom: string;
}

export interface BedrockInferenceProfileTag {
  readonly key: string;
  readonly value: string;
}
```

`modelSource` is currently a single-variant object (only `copyFrom` is supported by AWS today). It's structured as an object to mirror AWS's wire format AND so future AWS expansion (e.g., a hypothetical `routingConfig: {...}` variant) is an additive type extension.

### Boundary validation (pure, pre-flight)

`buildCreateInferenceProfileBody(input)` enforces all AWS-documented constraints BEFORE any fetch:

| Field | Constraint |
|---|---|
| `inferenceProfileName` | length [1, 64], pattern `^([0-9a-zA-Z][_-]?){1,63}$` |
| `modelSource.copyFrom` | length [1, 2048] (no pattern — AWS accepts both foundation-model ARNs and inference-profile ARNs) |
| `description` (optional) | length [1, 200], pattern `^([0-9a-zA-Z][ _-]?)+$` |
| `clientRequestToken` (optional) | length [1, 256], pattern `^[a-zA-Z0-9-]+$` |
| `tags` (optional) | count ≤ 200; per-tag key length [1, 128], value length ≤ 256 |

Validation throws `BedrockError` with `kind: "invalid_request_error"` BEFORE any AWS call. Saves cost + load + provides crisp local error messages.

### Response

```ts
export interface BedrockCreateInferenceProfileResponse {
  readonly inferenceProfileArn: string;
  readonly status: BedrockInferenceProfileStatus;  // currently always "ACTIVE"
}
```

AWS returns more than this in their wire response (the freshly-created profile contains all the same fields as `getInferenceProfile`), but the create endpoint returns ONLY `inferenceProfileArn` + `status`. Operators wanting the full detail call `getInferenceProfile` immediately after.

### Why no pre-flight (vs delete)?

The DELETE endpoint (ADR-0138) needs a pre-flight GET to check the `type` field and refuse SYSTEM_DEFINED profiles. The CREATE endpoint doesn't need one:

- AWS always creates `type=APPLICATION` profiles via this endpoint. Operators cannot accidentally create a SYSTEM profile.
- The source ARN (`copyFrom`) is validated by AWS itself; the substrate doesn't second-guess.
- Conflict detection (name already exists) lives in AWS; the substrate propagates 409 verbatim.

Result: a clean single-POST endpoint with boundary validation in front. Symmetric with `createBatch` (ADR-0108), `createModelCustomizationJob` (ADR-0131).

## Cross-cutting invariants enforced

- **Pure boundary validation.** All checks happen in `buildCreateInferenceProfileBody` before any fetch.
- **AWS contract preservation.** Field names + types match AWS verbatim (`inferenceProfileName`, `modelSource.copyFrom`, `clientRequestToken`).
- **No silent defaults.** No client-side filling-in of `description` or `clientRequestToken`. The wire body contains only what the operator provided.
- **Idempotency hook.** `clientRequestToken` supports AWS's idempotency contract: repeated POSTs with the same token return the same ARN without re-creating.
- **Symmetric error propagation.** 404 → `not_found_error` (copyFrom ARN doesn't exist), 409 → `conflict_error` (name collision), 403 → `permission_error`, 429 → `rate_limit_error`, 5xx → `server_error`.
- **Control-plane host only.** Tests assert `bedrock.{region}.amazonaws.com`, not `bedrock-runtime.`.
- **APPLICATION-only by construction.** AWS only creates APPLICATION profiles via this endpoint; no guard needed (vs delete which CAN target system profiles).

## End-to-end semantic

```ts
import { BedrockProvider } from "@crossengin/ai-providers-bedrock";
import {
  isConflictError,
  isNotFoundError,
} from "@crossengin/ai-providers";

const bedrock = new BedrockProvider({...});

// Create an application profile copying from a foundation model.
const profile = await bedrock.createInferenceProfile({
  inferenceProfileName: "tenant-a-sonnet",
  modelSource: {
    copyFrom:
      "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
  },
  description: "Per-tenant routing for tenant A",
  tags: [
    { key: "tenant", value: "a" },
    { key: "env", value: "prod" },
  ],
});
console.log(profile.inferenceProfileArn);  // ARN for downstream use

// Caller-decided idempotent create (silent on already-exists):
try {
  await bedrock.createInferenceProfile({...});
} catch (err) {
  if (isConflictError(err)) {
    // Name already exists. Resolve via getInferenceProfile + reuse.
    return reconcileExisting(...);
  }
  if (isNotFoundError(err)) {
    // copyFrom source doesn't exist.
    return surfaceToOperator(err);
  }
  throw err;
}

// Full APPLICATION lifecycle is now in the substrate:
await bedrock.createInferenceProfile({...});  // M2.X.5.aa.z.23 (this)
const list = await bedrock.listInferenceProfiles({typeEquals: "APPLICATION"});  // M2.X.5.aa.z.9
const detail = await bedrock.getInferenceProfile(arn);                          // M2.X.5.aa.z.10
await bedrock.deleteInferenceProfile(arn);  // M2.X.5.aa.z.22 (with guard)
```

## Alternatives considered

- **Add a `type: "APPLICATION"` parameter to the input.**
  - **Considered.** Explicit-is-better-than-implicit.
  - **Cons.** AWS doesn't have a `type` field on the create body; the type is always APPLICATION for this endpoint. Adding it as a TS-side parameter would be cargo-cult that we'd silently strip from the wire body. Clear naming (`createInferenceProfile`) is enough.
  - **Decision.** No type parameter. The method name encodes it.

- **Auto-set `clientRequestToken` to a generated UUID when omitted.**
  - **Considered.** Free idempotency.
  - **Cons.** Hidden behavior. Operators retrying expect deterministic behavior; auto-tokens make every retry a NEW request from AWS's perspective. Operators wanting idempotency provide their own token.
  - **Decision.** No auto-token. Document the idempotency contract.

- **Combine create + getDetail into a single method that returns the full profile.**
  - **Considered.** "I just made it; give me everything."
  - **Cons.** Two round-trips per "create + read." Most operators only need the ARN. Operators wanting full detail call `getInferenceProfile` next; that's a 3-line wrap.
  - **Decision.** Return only what AWS returns. Symmetric with other create endpoints.

- **Support multiple `modelSource` variants up-front (anticipating future AWS additions).**
  - **Considered.** A discriminated union with `copyFrom` + a future `routingConfig`.
  - **Cons.** Speculation. AWS hasn't announced a second variant. Single-variant object remains additive-compatible — when AWS ships variant N, type extends naturally.
  - **Decision.** Single variant. Forward-compatible structure.

- **Validate `copyFrom` against an ARN pattern.**
  - **Considered.** Catch typos pre-flight.
  - **Cons.** `copyFrom` accepts foundation-model ARNs OR system-inference-profile ARNs OR (potentially) a future ID format. The substrate would need to know all current + future patterns. Length-bound is the safer minimum check; AWS rejects bad ARNs with a clear 400.
  - **Decision.** Length-only validation.

- **Make `tags` required (or default to `[]`).**
  - **Considered.** Many operators want tags by policy.
  - **Cons.** Operator policy. AWS's API treats tags as optional. The substrate follows AWS.
  - **Decision.** Optional. Operators wrap in a policy enforcer if needed.

- **Add a `createOrLookup` helper that catches 409 and returns the existing profile.**
  - **Considered.** Common idempotent-create workflow.
  - **Cons.** Operator-specific. The 3-line caller wrap is straightforward. Same rationale as ADR-0108 for createBatch.
  - **Decision.** Operators write their own reconciliation.

## Consequences

- **56 packages + 1 app, 124 meta-schema tables, 7,704 tests** (+34 from M2.X.5.aa.z.23: 19 in `inference-profiles-api.test.ts` covering boundary validation + response parsing, 15 in `provider.test.ts` covering wire shape + error propagation). All green, zero type errors.
- **Bedrock control plane: 18 read + 2 stop + 2 create + 4 delete = 26 operations.** Full APPLICATION-inference-profile lifecycle on the substrate.
- **Closes ADR-0138 Q3.**
- **Future expansion is additive.** When AWS adds new `modelSource` variants, the `BedrockInferenceProfileModelSource` type extends without breaking existing callers.
- **No new transport infrastructure.** Reuses `signedControlPlanePost` from ADR-0108.

## Open questions

- **Q1:** Should there be an `updateInferenceProfile` (for description / tags mutation)?
  - _Current direction:_ Yes — AWS supports `UpdateApplicationInferenceProfile`. Future milestone. Same shape as create + the system-profile guard pattern from ADR-0138.
- **Q2:** Should the substrate expose `tagResource` / `untagResource` for tag management post-creation?
  - _Current direction:_ Yes — generic tag operations apply to inference profiles + custom models + guardrails + many more. Future milestone (`tagResource` / `untagResource` / `listTagsForResource`). Cross-resource surface.
- **Q3:** Should the response include the full profile detail (currently only `arn` + `status`)?
  - _Current direction:_ Stick with AWS's response shape. Operators wanting detail call `getInferenceProfile` next.
- **Q4:** When AWS adds new `modelSource` variants (e.g., routing config), should we ship them in additive milestones?
  - _Current direction:_ Yes — each new variant gets a sub-milestone with the same boundary-validation + tests pattern.
- **Q5:** Should `description` validation be more permissive (AWS's pattern excludes punctuation, but the docs are sparse)?
  - _Current direction:_ Strict pattern matches AWS docs verbatim. If real-world operator usage discovers the pattern is too tight, relax with a paired AWS-docs reference.
- **Q6:** Should the substrate auto-prefix tag keys with a tenant namespace (e.g., `crossengin:tenant=`)?
  - _Current direction:_ No — operator-side concern. Substrate is the transport.
- **Q7:** Should `clientRequestToken` be auto-generated if missing AND `idempotent: true` flag is set?
  - _Current direction:_ Out of scope. Operators wanting auto-idempotency wrap the method.
- **Q8:** Multi-region create — should the substrate retry with a different region if the source ARN belongs to a different region?
  - _Current direction:_ No. The substrate is single-region per `BedrockProvider` instance. Operators wanting cross-region wire multiple providers.
