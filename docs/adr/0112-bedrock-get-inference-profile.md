# ADR-0112: Bedrock getInferenceProfile (Phase 2 M2.X.5.aa.z.10)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0106 (M2.X.5.aa.z.4 getBatch), ADR-0111 (M2.X.5.aa.z.9 listInferenceProfiles) |

## Context

M2.X.5.aa.z.9 shipped `listInferenceProfiles` returning a paginated roster. Like the batch surface, the read story isn't complete until single-resource lookup exists — operators receiving a profile ID from logs / metrics / webhooks need to look up the full record without re-enumerating.

Unlike `GetGuardrail` (which returns a substantively richer shape than `ListGuardrails`), AWS's `GetInferenceProfile` returns the SAME wire shape as a `ListInferenceProfiles` entry. The kernel mirrors the M2.X.5.aa.z.4 `getBatch` pattern: type alias + thin parser wrapper.

Demand surfaces:
1. **Log-driven lookup.** Inference profile ARN appears in a CloudTrail / billing record — look up the full record by id.
2. **Webhook-driven lookup.** EventBridge emits a Bedrock event referencing a profile — fetch the full state.
3. **Spot-check enumeration vs detail.** Drift-detection comparison of "what we expect" vs "what AWS shows for this specific profile."

## Decision

One new provider method + two thin re-exports.

### 1. `BedrockProvider.getInferenceProfile(profileIdentifier)`

```ts
async getInferenceProfile(profileIdentifier: string): Promise<BedrockInferenceProfileDetail>;
```

- Validates `profileIdentifier` non-empty BEFORE the fetch (no wasted request on empty input).
- URI-encodes the identifier (`encodeURIComponent` — handles dots / colons in IDs and ARN colons).
- GETs `/inference-profiles/{encoded}` via the existing `signedControlPlaneGet` helper.
- Parses via `parseInferenceProfileDetail`.
- No query parameters — AWS doesn't accept any on this endpoint.

### 2. `BedrockInferenceProfileDetail = BedrockInferenceProfileSummary`

Type alias mirroring M2.X.5.aa.z.4's `BedrockBatchJobDetail = BedrockBatchJobSummary` pattern. AWS returns identical shapes for the list entry and the get response; aliasing documents intent without duplicating the type.

### 3. `parseInferenceProfileDetail(raw) = parseInferenceProfileSummary(raw)`

Thin wrapper around the M2.X.5.aa.z.9 parser. Both functions are exported; operators consuming inference profile payloads from non-API sources (EventBridge, CloudTrail) get consistent typing.

### 4. Identifier validation discipline

AWS accepts both the inference profile ID (`us.anthropic.claude-3-5-sonnet-20241022-v2:0`) and the full ARN. Both forms contain dots and / or colons that need URL encoding. Strict regex validation would be brittle — inference profile IDs vary by AWS region group (`us.`, `eu.`, `apne1.`, future prefixes), and application-defined profiles have operator-controlled IDs.

The kernel validates non-empty only. Wrong identifiers surface as 404 `not_found_error` via the AWS-side classification.

## Cross-cutting invariants enforced

- **Mirrors the M2.X.5.aa.z.4 getBatch shape.** Type alias + parser alias + thin provider wrapper. Same convention; same operator mental model.
- **No transport changes.** Reuses `signedControlPlaneGet` from M2.X.5.aa.z.3.
- **Empty-identifier fast-fail.** Boundary validation BEFORE network.
- **URI-encoded path component.** Identifiers with dots / colons travel correctly through sig v4 + the HTTP fetch.
- **Strict response parsing.** Reuses M2.X.5.aa.z.9's `parseInferenceProfileSummary` — same status / type / models field validation.
- **No kernel changes.** `LlmProvider` interface unchanged.
- **Backwards compat preserved.** No prior tests changed; only additions.

## End-to-end semantic

```ts
const provider = new BedrockProvider({ accessKeyId, secretAccessKey, region: "us-east-1" });

// Log-driven lookup.
async function describeProfileFromLog(logEntry: {
  inferenceProfileArn: string;
}): Promise<void> {
  const detail = await provider.getInferenceProfile(logEntry.inferenceProfileArn);
  console.log(
    `Profile ${detail.inferenceProfileName} (${detail.type}) routes to ${detail.models.length.toString()} regional models`,
  );
}

// Drift detection: spot-check one profile.
async function verifyExpectedProfile(
  expectedId: string,
  expectedRegions: ReadonlySet<string>,
): Promise<boolean> {
  try {
    const detail = await provider.getInferenceProfile(expectedId);
    const actualRegions = new Set(
      detail.models.map((m) => m.modelArn.split(":")[3] ?? "unknown"),
    );
    return [...expectedRegions].every((r) => actualRegions.has(r));
  } catch (err) {
    if (err instanceof BedrockError && err.kind === "not_found_error") return false;
    throw err;
  }
}
```

## Alternatives considered

- **Separate `BedrockInferenceProfileDetail` type that may diverge from the summary.**
  - **Considered.** Future-proofs against AWS adding fields only to the detail response.
  - **Cons.** Premature. AWS currently returns identical shapes. If they diverge, a follow-up ADR splits the types.
  - **Decision.** Type alias for now (same as M2.X.5.aa.z.4 / `BedrockBatchJobDetail`).

- **Require the inference profile ID (not the ARN).**
  - **Considered.** Tighter input validation.
  - **Cons.** AWS docs explicitly accept both forms. Operators with ARN-keyed registries (CloudTrail, IAM policy conditions) shouldn't have to extract IDs.
  - **Decision.** Accept either; URL-encode the whole identifier.

- **Strict regex on identifier format.**
  - **Considered.** Catch typos at boundary.
  - **Cons.** Inference profile IDs have heterogeneous shapes (system-defined vs application-defined; cross-region prefix varies). Permissive non-empty validation is more honest.
  - **Decision.** Non-empty validation only.

- **Cache the result for a short TTL.**
  - **Considered.** Drift-detection polls re-fetch frequently.
  - **Cons.** Caching policy is operator-specific.
  - **Decision.** No provider-layer caching.

- **Auto-retry on 404 (assume eventual consistency on profile creation).**
  - **Considered.** Some AWS resources are eventually consistent.
  - **Cons.** Inference profiles aren't subject to documented eventual-consistency caveats. 404 means the operator passed a wrong identifier.
  - **Decision.** Surface 404 immediately.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 7,048 tests** (+11 from M2.X.5.aa.z.10: 3 inference-profiles-api detail + 8 provider). All green, zero type errors.
- **Bedrock control-plane surface now has 8 of N operations.** listBatches + getBatch + stopBatch + createBatch + listGuardrails + getGuardrail + listInferenceProfiles + getInferenceProfile.
- **Inference-profile read story complete.** Both enumeration + single-resource lookup work.
- **Log / webhook driven workflows unblocked.** Operators with a profile ID in hand can fetch the full record.
- **Drift-detection workflows simplified.** Single profile lookup avoids re-enumerating the full roster when only one profile changed.
- **Detail alias pattern proven twice.** `BedrockBatchJobDetail = BedrockBatchJobSummary` (M2.X.5.aa.z.4) + `BedrockInferenceProfileDetail = BedrockInferenceProfileSummary` (this ADR). Future single-resource lookups where AWS returns the same shape as list entries follow the same convention.

## Open questions

- **Q1:** Auto-retry helper for "wait until inference profile is ACTIVE"?
  - _Current direction:_ Out of scope. AWS provisions inference profiles synchronously (status is `ACTIVE` immediately for SYSTEM_DEFINED; APPLICATION-type provisioning timing is documented).
- **Q2:** Should `getInferenceProfile` accept a model identifier and resolve to the wrapping profile?
  - _Current direction:_ No. Profiles wrap models; the kernel doesn't reverse-traverse.
- **Q3:** Pricing-aware `getInferenceProfile` that surfaces estimated per-region cost?
  - _Current direction:_ Out of scope. Pricing is a separate concern (M6.7 PostgresCostTracker, proposed).
- **Q4:** Should the parser preserve unknown fields for forward-compat?
  - _Current direction:_ Strict on known fields; tolerates unknown fields at the JSON level.
- **Q5:** Helper `forEachInferenceProfile(provider, callback)` for the paginate-then-detail pattern?
  - _Current direction:_ Out of scope. If three operators write essentially-identical loops, lift to ai-router.
- **Q6:** Webhook-driven retrieval shape — should there be a parsing helper for EventBridge events?
  - _Current direction:_ `parseInferenceProfileSummary` is already exported. Operators wrap.
