# ADR-0111: Bedrock listInferenceProfiles — third control-plane enumeration (Phase 2 M2.X.5.aa.z.9)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0105 (M2.X.5.aa.z.3 listBatches), ADR-0109 (M2.X.5.aa.z.7 listGuardrails), ADR-0071 (M2.9 Bedrock provider) |

## Context

Cross-region inference profiles are AWS's mechanism for routing a single logical model identifier (e.g., `us.anthropic.claude-3-5-sonnet-20241022-v2:0`) to ANY of multiple regional model deployments, automatically failing over when one region is overloaded. They're how AWS recommends production workloads invoke Claude / Llama / Titan today — direct foundation-model ARNs are increasingly seen as a development-only path.

Two operational scenarios surface demand:

1. **Discovery.** When does a customer's account get access to a new cross-region profile (e.g., AWS adds `eu.anthropic.claude-3-5-haiku-...`)? Operators tracking which profiles exist in their account need a programmatic surface.
2. **Cost/audit attribution.** APPLICATION-type profiles (custom routing rules defined per-application) generate billing line-items separate from SYSTEM_DEFINED profiles. Enumeration is the first step in surfacing per-tenant inference-profile spend.

M2.X.5.aa.z.9 is the third paginated control-plane enumeration after `listBatches` (M2.X.5.aa.z.3) and `listGuardrails` (M2.X.5.aa.z.7). The pattern is now mechanical — boundary-validated query builder + strict response parser + provider thin wrapper, all on the existing `signedControlPlaneGet` transport rail.

## Decision

One new module + one new provider method.

### 1. `inference-profiles-api.ts`

- `BEDROCK_INFERENCE_PROFILE_STATUSES` — 1-value const tuple (`ACTIVE`). AWS currently documents only one terminal state for profiles.
- `BEDROCK_INFERENCE_PROFILE_TYPES` — 2-value const tuple (`SYSTEM_DEFINED | APPLICATION`). System-defined profiles are AWS-managed; application profiles are operator-created.
- `BedrockInferenceProfileStatus` + `BedrockInferenceProfileType` types and `isBedrockInferenceProfileStatus` / `isBedrockInferenceProfileType` discriminators.
- `BedrockInferenceProfileModel` — `{modelArn}`. Each profile routes to N regional foundation model ARNs.
- `BedrockInferenceProfileSummary` — flat shape with 8 required fields (`inferenceProfileId`, `inferenceProfileName`, `inferenceProfileArn`, `models`, `status`, `type`, `createdAt`, `updatedAt`) + optional `description`.
- `BedrockInferenceProfileListResponse` — `{inferenceProfileSummaries, nextToken?}` with `nextToken` omitted when empty / absent.
- `buildInferenceProfileListQuery(options)` — pure boundary-validator returning `Record<string, string>`. Validates `typeEquals` against the tuple, `maxResults` integer in `[1, 1000]`, `nextToken` non-empty. Throws `BedrockError invalid_request_error` BEFORE any fetch.
- `parseInferenceProfileListResponse(raw)` + `parseInferenceProfileSummary(raw)` — strict parsers; throw `BedrockError api_error` on missing required fields, unknown status, unknown type, malformed models array.

### 2. `BedrockProvider.listInferenceProfiles(options?)`

```ts
async listInferenceProfiles(options: BedrockListInferenceProfilesOptions = {}): Promise<BedrockInferenceProfileListResponse>;
```

- Validates options via `buildInferenceProfileListQuery`.
- GETs `https://bedrock.{region}.amazonaws.com/inference-profiles?...` via the existing `signedControlPlaneGet` helper.
- Parses JSON via `parseInferenceProfileListResponse`.
- Errors route through `fromHttpResponse` / `fromNetworkError` — same paths as the other 5 control-plane methods.

## Cross-cutting invariants enforced

- **Mechanical reuse of the M2.X.5.aa.z.3 / .7 rail.** No transport changes. The third enumeration cements the pattern.
- **Strict enum tuples.** `status` ACTIVE + `type` SYSTEM_DEFINED | APPLICATION enforced at parse time; throw on unknown.
- **Per-region model ARN preservation.** Operators need the per-region modelArn list — it's how they understand which regions a profile spans.
- **Boundary validation BEFORE network.** Bad `typeEquals` / out-of-range `maxResults` / empty `nextToken` fail fast.
- **Provider-native pagination.** AWS's opaque `nextToken` preserved as-is.
- **No kernel changes.** `LlmProvider` interface unchanged. `listInferenceProfiles` is Bedrock-specific.
- **Backwards compat preserved.** No prior tests changed; only additions.

## End-to-end semantic

```ts
const provider = new BedrockProvider({ accessKeyId, secretAccessKey, region: "us-east-1" });

// Discovery — which cross-region profiles does this account see?
const all: BedrockInferenceProfileSummary[] = [];
let cursor: string | undefined;
do {
  const page = await provider.listInferenceProfiles({
    maxResults: 100,
    ...(cursor !== undefined ? { nextToken: cursor } : {}),
  });
  all.push(...page.inferenceProfileSummaries);
  cursor = page.nextToken;
} while (cursor !== undefined);

// Filter to APPLICATION-type profiles (operator-defined routing rules).
const operatorProfiles = await provider.listInferenceProfiles({
  typeEquals: "APPLICATION",
});

// Inspect which regions a profile spans.
for (const profile of all) {
  const regions = new Set(
    profile.models.map((m) => m.modelArn.split(":")[3] ?? "unknown"),
  );
  console.log(`${profile.inferenceProfileName}: ${[...regions].join(", ")}`);
}
```

## Alternatives considered

- **Wait for AWS to add `getInferenceProfile` and ship both in one milestone.**
  - **Considered.** Closes the read surface in one PR.
  - **Cons.** `getInferenceProfile` adds a different cost profile + a different rate-limit class. Splitting keeps each milestone tight + reviewable.
  - **Decision.** Ship list now. Get follows separately.

- **Add a `region` field to `BedrockInferenceProfileModel` by parsing the ARN.**
  - **Considered.** Operators want the region anyway; parsing in the provider would save them code.
  - **Cons.** ARN parsing is brittle (AWS-China / GovCloud have different shapes). The kernel preserves AWS's verbatim shape; operators parse if they need the region.
  - **Decision.** Preserve `{modelArn}` only.

- **Unify with `listGuardrails` + `listBatches` into a generic `paginatedList<T>` helper.**
  - **Considered.** Three implementations of the same shape.
  - **Cons.** The query parameter sets differ (statusEquals/nameContains/submitTimeAfter/submitTimeBefore for batches; guardrailIdentifier for guardrails; typeEquals for inference profiles); the parser logic differs; the response wrappers differ. A truly generic helper would be either dynamically-typed (loses safety) or so parametric it'd be opaque.
  - **Decision.** Three separate methods. The shared rail is `signedControlPlaneGet` at the transport layer.

- **Validate `inferenceProfileId` against a regex pattern.**
  - **Considered.** AWS uses prefixed dotted IDs (`us.`, `eu.`, etc.).
  - **Cons.** AWS adds new prefixes as they expand to new regional groupings. A regex would be perpetually stale.
  - **Decision.** Preserve as a non-empty string.

- **Cache the result for a short TTL.**
  - **Considered.** Inference-profile rosters change rarely.
  - **Cons.** Caching policy is operator-specific.
  - **Decision.** No caching at the provider layer.

- **Auto-paginate.**
  - **Considered.** Same as the other two enumerations.
  - **Cons.** Hides `nextToken`; operators can't resume.
  - **Decision.** Plain page-at-a-time.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 7,037 tests** (+34 from M2.X.5.aa.z.9: 26 inference-profiles-api + 8 provider). All green, zero type errors.
- **Bedrock control-plane surface now has 7 of N operations.** listBatches + getBatch + stopBatch + createBatch + listGuardrails + getGuardrail + listInferenceProfiles.
- **Cross-region inference-profile discovery unblocked.** Operators tracking which profiles exist in their AWS account can enumerate them.
- **Per-type filtering supported.** SYSTEM_DEFINED vs APPLICATION distinction surfaces; operator-defined profiles can be audited separately from AWS-managed ones.
- **Per-region model ARN list preserved.** Operators understanding which regions a profile spans can route accordingly.
- **Bedrock module count: 12.** batch-api + converse-api + embeddings + errors + event-stream + guardrails + guardrails-api + inference-profiles-api + pricing + provider + signing + index.
- **Pagination pattern now proven THREE times.** Adding `listImportedModels` / `listCustomModels` / `listMarketplaceModelEndpoints` is mechanical.

## Open questions

- **Q1:** `getInferenceProfile(profileIdentifier)` next?
  - _Current direction:_ Yes — same rich-detail pattern as `getGuardrail` (M2.X.5.aa.z.8). Likely next if Bedrock depth continues.
- **Q2:** `createInferenceProfile` / `deleteInferenceProfile`?
  - _Current direction:_ APPLICATION-type profiles can be created programmatically. Wait for operator demand — most operators today consume SYSTEM_DEFINED profiles only.
- **Q3:** Should the kernel auto-translate `modelId` in `CompletionRequest` to an inference profile ID?
  - _Current direction:_ No. Operators pass what AWS accepts. Translation logic would need region-affinity policy + fallback rules; that's an ai-router concern, not an ai-providers-bedrock concern.
- **Q4:** Helper to derive per-region availability from a profile?
  - _Current direction:_ Out of scope for the provider — `profile.models[i].modelArn.split(":")` is one line of operator code.
- **Q5:** Cross-provider abstraction for "the model identifier accepts cross-region failover" (Anthropic + OpenAI don't have inference profiles)?
  - _Current direction:_ No. The concept is Bedrock-specific.
- **Q6:** Pricing implications — APPLICATION-type profile use vs direct model ARN use.
  - _Current direction:_ Out of scope for this milestone. M6.7 (PostgresCostTracker, proposed) would surface this if the operator threads inferenceProfileArn through completion metadata.
- **Q7:** Should the parser preserve unknown profile types (forward-compat)?
  - _Current direction:_ No. Throwing on unknown surfaces AWS additions immediately, prompting a kernel update.
