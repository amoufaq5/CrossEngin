# ADR-0105: Bedrock batch inference listBatches (Phase 2 M2.X.5.aa.z.3)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0071 (M2.9 Bedrock provider), ADR-0102 (M2.X.5.aa.z OpenAI Files API), ADR-0103 (M2.X.5.aa.z.1 Anthropic Files API), ADR-0104 (M2.X.5.aa.z.2 listFiles) |

## Context

AWS Bedrock does not ship a Files-API equivalent (no `POST /v1/files` endpoint). The closest operational surface — and the only Bedrock control-plane endpoint that resembles the enumeration pattern from ADR-0104 — is **batch inference** (`ListModelInvocationJobs`). Operators submitting offline batch jobs against Claude / Llama / Mistral / Titan on Bedrock need the same three workflows that motivated ADR-0104:

1. **Tenant offboarding** — enumerate active + completed jobs attributed to a tenant (via `nameContains` filter, since jobs carry no native tenant tag).
2. **Storage / cost audits** — count jobs by status, identify long-running stragglers, surface failed jobs whose S3 outputs need cleanup.
3. **Reference reconciliation** — diff operator records (`jobArn → tenant_id`) against AWS's view, detect orphaned jobs.

M2.X.5.aa.z.3 ships `BedrockProvider.listBatches(options?)` against the `ListModelInvocationJobs` control-plane endpoint. Unlike OpenAI / Anthropic Files APIs (which run against the same `*.openai.com` / `*.anthropic.com` host as inference), Bedrock partitions its surface across **two different hosts** — `bedrock-runtime.{region}.amazonaws.com` (inference, sig v4 service `bedrock`) and `bedrock.{region}.amazonaws.com` (control plane, same service name). The provider gains a separate `controlPlaneBaseUrl` config + `signedControlPlaneGet` helper.

Submit / get / stop operations on batch jobs (Q1) and Files-API parity (Q4) are deferred.

## Decision

One new module + one new provider method.

### 1. `batch-api.ts`

- `BEDROCK_BATCH_JOB_STATUSES` — 10-value const tuple matching AWS's documented states (`Submitted | InProgress | Completed | Failed | Stopping | Stopped | PartiallyCompleted | Expired | Validating | Scheduled`).
- `BedrockBatchJobStatus` type + `isBedrockBatchJobStatus(value)` discriminator.
- `BEDROCK_BATCH_SORT_BY_VALUES = ["CreationTime"]` + `BEDROCK_BATCH_SORT_ORDER_VALUES = ["Ascending", "Descending"]`.
- `BedrockBatchJobSummary` type — flat shape mirroring AWS's `InvocationJobSummary` (jobArn, jobName, modelId, roleArn, status, submitTime + optional clientRequestToken, message, lastModifiedTime, endTime, timeoutDurationInHours, jobExpirationTime, vpcConfig); `inputDataConfig.s3InputDataConfig.s3Uri` + `outputDataConfig.s3OutputDataConfig.s3Uri` required.
- `BedrockBatchJobListResponse` — `{invocationJobSummaries, nextToken?}`. `nextToken` omitted when empty/absent.
- `buildBatchListQuery(options)` — pure function returning a `Record<string, string>` of query params. Validates each option at the boundary BEFORE any fetch:
  - `statusEquals` against the tuple.
  - `maxResults` is an integer in `[1, 1000]`.
  - `nameContains` length in `[1, 63]`.
  - `submitTimeAfter` / `submitTimeBefore` parseable via `Date.parse`.
  - `nextToken` non-empty.
  - `sortBy` / `sortOrder` against their respective tuples.
- `parseBatchListResponse(raw)` — strict parser; throws `BedrockError` on missing required fields / unknown statuses / malformed substructures.

### 2. `BedrockProvider.listBatches(options?)`

```ts
async listBatches(options: BedrockListBatchesOptions = {}): Promise<BedrockBatchJobListResponse>;
```

- Validates options via `buildBatchListQuery` (fast-fail on out-of-range / invalid values).
- Builds a sorted, AWS-URI-encoded query string + appends to `/model-invocation-jobs/`.
- Sig v4 signs the GET with the `query` parameter threaded through (canonical query string includes all params, alphabetized).
- Issues `GET https://bedrock.{region}.amazonaws.com/model-invocation-jobs/?...` via the existing `FetchLike`.
- Parses the JSON body via `parseBatchListResponse`.
- Errors route through `fromHttpResponse` / `fromNetworkError` — same paths as `complete()` / `embed()`.

### 3. Control-plane host

`BedrockProviderOptions` gains optional `controlPlaneBaseUrl`. Default: `https://bedrock.{region}.amazonaws.com`. The existing `baseUrl` (defaults to `https://bedrock-runtime.{region}.amazonaws.com`) is preserved unchanged — inference calls keep routing to the runtime host.

Both hosts use the same sig v4 service name (`bedrock`); the existing `signRequest` is reused without modification. A new private `signedControlPlaneGet({path, query})` helper mirrors the existing `signedFetch` but: (a) issues GET, (b) sends an empty body, (c) constructs the URL on `controlPlaneBaseUrl`, (d) returns the response body as a string.

### 4. Validation discipline

Identical to ADR-0104:
- Invalid type → throw `BedrockError` with `kind: "invalid_request_error"`.
- Network error → `fromNetworkError`.
- HTTP error → `fromHttpResponse` (typed kind per AWS exception class).
- JSON parse / shape error → `BedrockError` with `kind: "api_error"`.

## Cross-cutting invariants enforced

- **Provider-native pagination.** AWS uses `nextToken` (opaque string) — preserved as-is in the response shape. The kernel doesn't try to unify with OpenAI's `after` or Anthropic's `before_id` / `after_id`.
- **Provider-native sort vocabulary.** Only `CreationTime` (ASC/DESC) is allowed, per AWS docs. Future sort dimensions get added to the tuple.
- **Boundary validation.** Bad `maxResults` / `statusEquals` / `nameContains` length / unparseable dates fail at the provider boundary, never burning a request.
- **Same sig v4 path.** Reuses `signRequest`; the `query` parameter (already supported by `signing.ts` since M2.9) carries the canonical query string into the sig v4 signature.
- **Backwards compat preserved.** No M2.9 / M2.9.5 / M2.9.6 / M2.9.7 / M2.9.8 / M2.9.8.x tests changed; only additions.
- **No kernel changes.** `LlmProvider` interface unchanged. `listBatches` is a Bedrock-specific method — operators wanting to enumerate batches call the provider directly. The interface doesn't try to abstract batch inference (Anthropic + OpenAI use Files API for batch input; AWS uses S3 + dedicated control plane — the surfaces are too different to share).

## End-to-end semantic

```ts
// Audit: how many jobs in each terminal state for a tenant?
const provider = new BedrockProvider({ accessKeyId, secretAccessKey, region: "us-east-1" });
const counts: Record<string, number> = {};
let cursor: string | undefined;
do {
  const page = await provider.listBatches({
    nameContains: "tenant-x-",
    maxResults: 100,
    sortBy: "CreationTime",
    sortOrder: "Descending",
    ...(cursor !== undefined ? { nextToken: cursor } : {}),
  });
  for (const job of page.invocationJobSummaries) {
    counts[job.status] = (counts[job.status] ?? 0) + 1;
  }
  cursor = page.nextToken;
} while (cursor !== undefined);

// Storage cleanup: find old completed jobs whose S3 outputs can be archived.
const old = await provider.listBatches({
  statusEquals: "Completed",
  submitTimeBefore: "2026-01-01T00:00:00Z",
  maxResults: 1000,
});
for (const job of old.invocationJobSummaries) {
  await archiveS3Output(job.outputDataConfig.s3OutputDataConfig.s3Uri);
}
```

## Alternatives considered

- **Wait for AWS to ship a Bedrock Files API.**
  - **Considered.** Symmetric with OpenAI + Anthropic.
  - **Cons.** No public announcement; AWS's batch story has matured around model-invocation-jobs + S3 for years and shows no sign of changing. Operators need an enumeration surface now.
  - **Decision.** Ship against the existing control-plane API.

- **Add `getBatch(jobIdentifier)` + `stopBatch(jobIdentifier)` in the same milestone.**
  - **Considered.** Full CRUD-ish surface.
  - **Cons.** Lift in scope — submit / get / stop bring richer body shapes (input/output config validation, role ARN validation, S3 URI validation). Better as a follow-up (Q1).
  - **Decision.** `listBatches` only.

- **Unify with OpenAI / Anthropic `listFiles` into a kernel `LlmEnumerationProvider` interface.**
  - **Considered.** Cross-provider "enumerate everything" pattern.
  - **Cons.** The surfaces are fundamentally different: OpenAI / Anthropic list opaque file objects scoped to one type (files); Bedrock lists model invocation jobs with S3 input/output. A unified interface would need lowest-common-denominator fields and lose almost all useful information.
  - **Decision.** Provider-native methods. Operators iterate per provider.

- **Treat the response shape as `unknown` and let operators cast.**
  - **Considered.** Less translation overhead.
  - **Cons.** Boundary errors (missing fields, unknown statuses) surface deep in operator code instead of at the parse site. Strict parse means earlier failure + better debugging.
  - **Decision.** Strict typed parsing via `parseBatchListResponse`.

- **Auto-paginate inside `listBatches` (e.g., `listAllBatches()`).**
  - **Considered.** Operators don't have to write the do/while loop.
  - **Cons.** Hides `nextToken`; operators can't resume from a checkpoint. The plain `listBatches` is composable.
  - **Decision.** Plain `listBatches`. Auto-paginator is operator-side.

- **Skip validation of `maxResults` / `nameContains` / dates client-side.**
  - **Considered.** AWS would return 400 anyway.
  - **Cons.** Wasted request + opaque AWS error message. Boundary validation gives operators a clear, fast-fail error.
  - **Decision.** Validate at boundary per ADR-0104 pattern.

- **Use a separate region for the control plane than for inference.**
  - **Considered.** Some AWS services have region-pinning differences.
  - **Cons.** Bedrock's control plane lives in the same region as the runtime; mixing would be operator error.
  - **Decision.** Single `region` config flows to both base URLs.

- **Run batch enumeration through `LlmRouter`.**
  - **Considered.** Cost ceiling + retry policy.
  - **Cons.** `listBatches` is a read-only enumeration with no token usage; the router's cost model doesn't apply. Retry is the operator's concern (use `withRetry` if needed).
  - **Decision.** No router integration.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,891 tests** (+41 from M2.X.5.aa.z.3: 28 batch-api + 13 provider listBatches). All green, zero type errors.
- **Bedrock now has an operational read surface.** Pre-M2.X.5.aa.z.3 the only Bedrock methods were `complete()` / `completeNonStreaming()` / `embed()` / `embedMultimodal()` (+ guardrail siblings) — all single-call inference. Operators tracking batch jobs had to call AWS SDKs directly.
- **Three-provider parity on enumeration.** OpenAI + Anthropic + Bedrock all expose a paginated list method for their long-lived artifacts (files / files / batch jobs respectively).
- **Tenant offboarding workflows viable on Bedrock.** Operators tagging job names with tenant prefixes can enumerate + audit per tenant.
- **Storage audits unblocked.** Operators can count jobs by status, identify stragglers, and surface failed jobs for output cleanup.
- **Pattern set for future Bedrock control-plane methods.** `signedControlPlaneGet` is the rail; subsequent methods (getBatch, listGuardrails, listImportedModels, listInferenceProfiles) follow the same shape.
- **Two-host model documented.** Operators with strict residency / firewall rules need to allow both `bedrock-runtime.{region}.amazonaws.com` (inference) AND `bedrock.{region}.amazonaws.com` (control plane).

## Open questions

- **Q1:** Should `getBatch(jobIdentifier)` + `createBatch(input)` + `stopBatch(jobIdentifier)` be added next?
  - _Current direction:_ Wait for operator demand. Submit / stop are stateful; getBatch is the most likely follow-up.
- **Q2:** Should the provider auto-resolve job identifier vs ARN (AWS accepts both)?
  - _Current direction:_ Pass-through for now; AWS handles disambiguation server-side.
- **Q3:** Should there be a kernel-level helper to enumerate "all long-lived AI artifacts" across providers?
  - _Current direction:_ No. The surfaces are too different (files vs batch jobs). Operators normalize at the application layer.
- **Q4:** What about Bedrock's other enumeration endpoints (listGuardrails, listImportedModels, listInferenceProfiles, listCustomModels)?
  - _Current direction:_ Pattern is now established. Add as demand surfaces.
- **Q5:** Should `parseBatchListResponse` tolerate unknown statuses (downgrade to "Unknown") for forward compat when AWS adds new states?
  - _Current direction:_ Strict for now. If AWS ships a new status, we add it to the tuple and ship a new ADR.
- **Q6:** Cursor expiry handling — what if `nextToken` is invalidated mid-iteration?
  - _Current direction:_ HTTP 400 → typed `invalid_request_error`. Operator restarts.
- **Q7:** Should `listBatches` cache responses for a short TTL?
  - _Current direction:_ No. Caching policy is operator-specific.
