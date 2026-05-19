# ADR-0106: Bedrock batch inference getBatch (Phase 2 M2.X.5.aa.z.4)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0105 (M2.X.5.aa.z.3 listBatches), ADR-0102 (M2.X.5.aa.z OpenAI Files retrieveFile), ADR-0103 (M2.X.5.aa.z.1 Anthropic Files retrieveFile) |

## Context

M2.X.5.aa.z.3 shipped `listBatches()` on the Bedrock control plane, deferring single-job lookup (`getBatch`) as a Q1 follow-up. Demand surfaces in three workflows that listBatches alone can't satisfy:

1. **Job status polling.** Operators waiting on a batch to complete need to poll a specific `jobIdentifier`, not paginate the full job list.
2. **Failure diagnostics.** A failed job's `message` field carries the AWS-side reason — surfaced more reliably via `GetModelInvocationJob` than via list filtering.
3. **Webhook-driven retrieval.** If a future Bedrock event source emits a job-id (e.g., `batch.completed` via EventBridge), operators look up the full record by id.

`GetModelInvocationJob` (the AWS REST endpoint) returns the same wire shape as a list entry — same fields, same types. The kernel reuses the existing `BedrockBatchJobSummary` type via a `BedrockBatchJobDetail` alias.

## Decision

One new provider method + two helpers + a regex validator.

### 1. `BedrockProvider.getBatch(jobIdentifier)`

```ts
async getBatch(jobIdentifier: string): Promise<BedrockBatchJobDetail>;
```

- Validates `jobIdentifier` via `isBedrockBatchJobIdentifier` BEFORE the fetch (fast-fail on malformed input; no wasted request).
- URI-encodes the identifier in the path (`encodeURIComponent` — colons in ARNs become `%3A`).
- GETs `https://bedrock.{region}.amazonaws.com/model-invocation-jobs/{encoded}` via the existing `signedControlPlaneGet` helper from M2.X.5.aa.z.3.
- Parses the JSON body via `parseBatchJobDetail`.
- Errors route through `fromHttpResponse` / `fromNetworkError` — same paths as `listBatches`.

### 2. `BEDROCK_BATCH_JOB_IDENTIFIER_PATTERN` + `isBedrockBatchJobIdentifier`

AWS accepts EITHER a 12-char lowercase-alphanumeric unique id OR a full job ARN:

```
^(?:arn:aws(?:-[^:]+)?:bedrock:[a-z0-9-]{1,20}:[0-9]{12}:model-invocation-job\/[a-z0-9]{12}|[a-z0-9]{12})$
```

The regex covers the three AWS partitions (`aws`, `aws-us-gov`, `aws-cn`) and validates the resource type (`model-invocation-job`). Exported alongside the discriminator so operators can reuse the same shape check in their own code.

### 3. `BedrockBatchJobDetail` type + `parseBatchJobDetail` parser

Both are aliases for the M2.X.5.aa.z.3 surface:

```ts
export type BedrockBatchJobDetail = BedrockBatchJobSummary;
export function parseBatchJobDetail(raw: unknown): BedrockBatchJobDetail {
  return parseBatchJobSummary(raw);
}
```

`parseBatchJobSummary` is promoted from module-private to exported — operators can call it directly when consuming bedrock summaries from non-API sources (e.g., EventBridge payloads).

### 4. Validation discipline (mirrors M2.X.5.aa.z.3)

- Invalid identifier → throw `BedrockError` with `kind: "invalid_request_error"` BEFORE the fetch.
- HTTP 404 (typically `ResourceNotFoundException`) → typed `not_found_error` via the existing CODE_TO_KIND map.
- HTTP 403 → `permission_error` (AccessDeniedException).
- Network errors → `fromNetworkError` (`network_error` / `timeout_error`).
- JSON parse / shape errors → `BedrockError` with `kind: "api_error"`.

## Cross-cutting invariants enforced

- **Reuse the M2.X.5.aa.z.3 transport rail.** `signedControlPlaneGet` is called as-is; no new HTTP code paths.
- **Reuse the M2.X.5.aa.z.3 wire shape.** `BedrockBatchJobDetail = BedrockBatchJobSummary` — AWS returns the same shape for both endpoints.
- **Boundary validation BEFORE network.** Out-of-pattern jobIdentifier never burns a request.
- **AWS partition-aware regex.** ARNs from `aws-us-gov` + `aws-cn` regions accepted.
- **Path encoding via `encodeURIComponent`.** Colons in ARNs (`arn:aws:bedrock:...`) become `%3A`; the same encoding path used by `complete()` for model IDs.
- **No kernel changes.** `LlmProvider` interface unchanged. `getBatch` is Bedrock-specific.
- **Backwards compat preserved.** No M2.X.5.aa.z.3 tests changed; only additions.

## End-to-end semantic

```ts
// Poll a batch to completion.
const provider = new BedrockProvider({ accessKeyId, secretAccessKey, region: "us-east-1" });
async function awaitCompletion(jobId: string, timeoutMs = 60 * 60 * 1000): Promise<BedrockBatchJobDetail> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await provider.getBatch(jobId);
    if (["Completed", "PartiallyCompleted", "Failed", "Stopped", "Expired"].includes(detail.status)) {
      return detail;
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
  throw new Error(`batch ${jobId} did not finish within ${timeoutMs.toString()}ms`);
}

// Or with a full ARN.
const detail = await provider.getBatch(
  "arn:aws:bedrock:us-east-1:123456789012:model-invocation-job/abc123def456",
);
console.log(detail.status, detail.outputDataConfig.s3OutputDataConfig.s3Uri);
```

## Alternatives considered

- **Separate `BedrockBatchJobDetail` type that diverges from `BedrockBatchJobSummary`.**
  - **Considered.** Future-proofs against AWS adding fields only to the detail response.
  - **Cons.** Premature. AWS currently returns identical shapes. If they diverge later, we ship a new ADR that splits the types.
  - **Decision.** Type alias for now.

- **Accept only 12-char unique identifiers (no ARNs).**
  - **Considered.** Simpler validation.
  - **Cons.** AWS docs explicitly accept both forms. Operators using ARN-keyed registries (CloudTrail, IAM policies) would have to extract the id manually.
  - **Decision.** Accept both via the union regex.

- **Skip identifier validation; let AWS return 400 on bad input.**
  - **Considered.** Less code.
  - **Cons.** Wasted request + opaque error. The regex catches typos at the boundary.
  - **Decision.** Validate at boundary.

- **Auto-retry on 404 (assume the job is still being scheduled).**
  - **Considered.** Some AWS services have eventual consistency on create.
  - **Cons.** Bedrock returns a synchronous job ARN from `CreateModelInvocationJob`; 404 means the operator passed a wrong id, not a stale read. Retrying masks the real bug.
  - **Decision.** Surface 404 immediately as `not_found_error`.

- **Cache the result for a short TTL.**
  - **Considered.** Polling loops re-fetch every 30s; caching would reduce control-plane load.
  - **Cons.** Caching policy is operator-specific (TTL varies by use case).
  - **Decision.** No caching. Operators add their own.

- **Add an async-iterable helper `pollBatch(jobIdentifier, {pollMs, terminalStatuses})`.**
  - **Considered.** Polling is the most common usage.
  - **Cons.** Polling cadence + terminal-status set vary by operator. The plain `getBatch` is composable; the polling loop fits in 10 lines of operator code.
  - **Decision.** Plain `getBatch`. Polling helper is operator-side.

- **Promote `parseBatchJobSummary` to a private function only used internally.**
  - **Considered.** Smaller public API surface.
  - **Cons.** Operators consuming Bedrock summaries from EventBridge / SQS would have to write their own parser. The function is already stable + tested.
  - **Decision.** Export it.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,909 tests** (+18 from M2.X.5.aa.z.4: 10 batch-api + 8 provider). All green, zero type errors.
- **ADR-0105 Q1 closed.** Bedrock batch surface now supports list + single-job lookup.
- **Polling-loop workflows viable.** Operators submitting a batch job from one process can poll for completion from another.
- **Failure diagnostics improve.** Failed jobs surfaced with their typed `message` field.
- **Pattern set for future single-resource lookups.** `getGuardrail(guardrailIdentifier)` / `getInferenceProfile(...)` / etc. all follow the same shape: regex validate → encode → signedControlPlaneGet → parse.
- **Bedrock control-plane surface now has 2 of N operations.** Listing + retrieval. Creation / cancellation deferred.

## Open questions

- **Q1:** Should there be `stopBatch(jobIdentifier)`?
  - _Current direction:_ Wait for demand. Stopping requires POST + idempotency-key handling; substantively more lift than GET.
- **Q2:** `createBatch(input)`?
  - _Current direction:_ Largest lift — full body shape validation (input/output S3 URIs, role ARN, model ID, timeout, vpcConfig). Defer until batch becomes a first-class authoring surface.
- **Q3:** Should the polling helper live in `@crossengin/ai-router` as a generic "wait-for-terminal" utility?
  - _Current direction:_ Not yet. Polling cadence is too workflow-specific.
- **Q4:** Listing other control-plane resources (guardrails, imported models, custom models, inference profiles)?
  - _Current direction:_ Add as demand surfaces. Same `signedControlPlaneGet` rail.
- **Q5:** Should `getBatch` accept a partial ARN (e.g., just the resource path)?
  - _Current direction:_ No. AWS docs are explicit about the two accepted forms.
- **Q6:** Webhook-driven retrieval — if EventBridge ships a Bedrock batch event source, will operators need parseBatchJobFromEvent?
  - _Current direction:_ Watch the AWS changelog. Today they'd write their own parser using `parseBatchJobSummary` (now exported).
