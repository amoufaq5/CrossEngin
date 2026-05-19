# ADR-0107: Bedrock batch inference stopBatch (Phase 2 M2.X.5.aa.z.5)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0105 (M2.X.5.aa.z.3 listBatches), ADR-0106 (M2.X.5.aa.z.4 getBatch) |

## Context

The Bedrock batch surface is read-complete (list + single-job lookup) after M2.X.5.aa.z.4 but has no mutation path. Operators detecting a runaway job, cost-overrun, or wrong-pack-version submission have to fall back to AWS SDK / console to stop it. Three workflows demand a programmatic stop:

1. **Cost runaways.** Detection logic spots a job running 10x longer than expected → stop before more model-invocation budget burns.
2. **Tenant offboarding.** Decommissioning a tenant should cancel any in-flight batch jobs attributed to them (paired with `listBatches({nameContains})` for discovery).
3. **Compliance kill switches.** A new content policy lands → stop in-flight jobs that may violate it.

`StopModelInvocationJob` is a POST with no body to `/model-invocation-jobs/{jobIdentifier}/stop`. Returns 200 + empty body on success; 409 ConflictException on terminal-state jobs (operator polled too late). M2.X.5.aa.z.5 ships `BedrockProvider.stopBatch(jobIdentifier)` against this endpoint.

## Decision

One new provider method + one new private transport helper.

### 1. `BedrockProvider.stopBatch(jobIdentifier)`

```ts
async stopBatch(jobIdentifier: string): Promise<void>;
```

- Validates `jobIdentifier` via the M2.X.5.aa.z.4 `isBedrockBatchJobIdentifier` regex (same shape: 12-char unique id OR full job ARN across `aws` / `aws-us-gov` / `aws-cn` partitions).
- URI-encodes the identifier (`encodeURIComponent`) into the path: `/model-invocation-jobs/{encoded}/stop`.
- POSTs an empty body via the new `signedControlPlanePost` helper.
- Returns `void` on success — AWS returns 200 + empty body for `StopModelInvocationJob`. The response text is read but discarded.
- Validation discipline mirrors `getBatch`: bad identifier throws `BedrockError` with `kind: "invalid_request_error"` BEFORE the fetch (no wasted request).

### 2. `signedControlPlanePost({path})`

Private sibling to M2.X.5.aa.z.3's `signedControlPlaneGet`. Mirrors the GET helper with three differences:
- Method: POST.
- Headers: adds `content-type: application/json` alongside `accept`.
- No `query` parameter — stopBatch is path-only.

Same sig v4 signing (`signRequest` with empty Uint8Array body — produces the SHA-256 of the empty string, which AWS expects), same `host` + `x-amz-date` + `x-amz-content-sha256` + `authorization` headers, same `x-amz-security-token` propagation when sessionToken is present, same `fromHttpResponse` / `fromNetworkError` routing.

### 3. Error mapping

- **HTTP 200 / empty body** → resolve void.
- **HTTP 400 ValidationException** → `invalid_request_error`.
- **HTTP 403 AccessDeniedException** → `permission_error`.
- **HTTP 404 ResourceNotFoundException** → `not_found_error`.
- **HTTP 409 ConflictException** (job already in terminal state) → falls through `classifyHttpStatus` to `unknown_error`. The `.code` field carries `"ConflictException"` so operators can discriminate. _See Q1._
- **HTTP 429 ThrottlingException** → `rate_limit_error`.
- **Network failure** → `network_error` / `timeout_error`.

## Cross-cutting invariants enforced

- **Read/write split on the same rail.** `signedControlPlaneGet` (M2.X.5.aa.z.3) for GETs; `signedControlPlanePost` (this ADR) for POSTs. Both use the same `signRequest` + same control-plane host + same auth header threading.
- **Identifier regex shared.** `isBedrockBatchJobIdentifier` (M2.X.5.aa.z.4) is reused without modification. Two methods, one validator.
- **Boundary validation BEFORE network.** Out-of-pattern jobIdentifier never burns a request.
- **Empty body discipline.** AWS sig v4 requires Content-SHA256 even on empty bodies; the existing `signing.ts` handles `new Uint8Array(0)` correctly (SHA-256 of empty string).
- **No kernel changes.** `LlmProvider` interface unchanged. `stopBatch` is Bedrock-specific.
- **Backwards compat preserved.** No M2.X.5.aa.z.3 / M2.X.5.aa.z.4 tests changed; only additions.

## End-to-end semantic

```ts
// Cost-runaway kill switch.
const provider = new BedrockProvider({ accessKeyId, secretAccessKey, region: "us-east-1" });
async function killIfRunaway(jobId: string, maxDurationMs: number): Promise<void> {
  const detail = await provider.getBatch(jobId);
  if (detail.status === "InProgress" && detail.submitTime !== undefined) {
    const elapsed = Date.now() - new Date(detail.submitTime).getTime();
    if (elapsed > maxDurationMs) {
      try {
        await provider.stopBatch(jobId);
        logger.warn({ jobId, elapsed }, "stopped runaway batch");
      } catch (err) {
        if (err instanceof BedrockError && err.code === "ConflictException") {
          // Job became terminal between our get + stop — safe to ignore.
        } else {
          throw err;
        }
      }
    }
  }
}

// Tenant-offboarding cancellation sweep.
async function cancelTenantJobs(tenantPrefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await provider.listBatches({
      nameContains: tenantPrefix,
      statusEquals: "InProgress",
      ...(cursor !== undefined ? { nextToken: cursor } : {}),
    });
    for (const job of page.invocationJobSummaries) {
      await provider.stopBatch(job.jobArn);
    }
    cursor = page.nextToken;
  } while (cursor !== undefined);
}
```

## Alternatives considered

- **Map ConflictException → invalid_request_error.**
  - **Considered.** 409s mean "request is structurally valid but resource state forbids it" — could fit `invalid_request_error`.
  - **Cons.** `invalid_request_error` conventionally means "structural problem with your request." Conflating state-conflict with structural-error loses information operators need. Better: leave kind as `unknown_error` (via classifyHttpStatus fallback) and let operators discriminate on `.code === "ConflictException"`.
  - **Decision.** No mapping change in this milestone. Q1 tracks adding a dedicated `conflict_error` kind in a future milestone.

- **Return the response body instead of `void`.**
  - **Considered.** Some AWS endpoints return useful response bodies even when documented as empty.
  - **Cons.** `StopModelInvocationJob` is documented to return empty; no schema for operators to consume. `void` is honest about that.
  - **Decision.** `void`. Future revisions can widen if AWS ships a non-empty response.

- **Auto-retry 409 ConflictException as "already stopped".**
  - **Considered.** Some operators want stopBatch to be effectively idempotent.
  - **Cons.** Silently turning 409 into success masks bugs (operator called stop on wrong job, then a real job became terminal). Operators wanting idempotency wrap stopBatch themselves (as in the example above).
  - **Decision.** Surface 409 verbatim.

- **Skip the new `signedControlPlanePost` helper; thread method into `signedControlPlaneGet`.**
  - **Considered.** Less code duplication.
  - **Cons.** GET and POST need different default headers (POST adds `content-type`); the parameter sprawl would dwarf the duplication.
  - **Decision.** Separate helper. Future PUT / DELETE follow the same pattern.

- **Validate ALL terminal statuses (Completed, Failed, Stopped, etc.) client-side and short-circuit stopBatch.**
  - **Considered.** Pre-fetch the job via `getBatch`, check status, only POST if `InProgress` / `Submitted` / `Scheduled`.
  - **Cons.** Race condition — the job could become terminal between get and stop. Net: still need to handle 409.  Doubles the request count.
  - **Decision.** Single POST. Let AWS authoritative-source decide.

- **Accept an idempotency key argument.**
  - **Considered.** Some AWS APIs accept `clientRequestToken` for idempotency.
  - **Cons.** `StopModelInvocationJob` doesn't document one. Operators wanting at-most-once semantics wrap themselves.
  - **Decision.** No idempotency key parameter.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,920 tests** (+11 from M2.X.5.aa.z.5). All green, zero type errors.
- **Batch read/write split complete.** Bedrock now has 3 of 4 documented batch operations (list + get + stop); only `createBatch` is missing.
- **Cost-runaway + tenant-offboarding + compliance-kill-switch workflows unblocked.** Operators no longer need to drop down to AWS SDK / console for cancellation.
- **POST rail established.** `signedControlPlanePost` is reusable for future control-plane POSTs that take empty bodies (e.g., resource-state mutations on guardrails, inference profiles, custom models).
- **409 handling deferred.** ConflictException returns with `kind: "unknown_error"` + `code: "ConflictException"`. Most operator code that catches BedrockError will see this; the `.code` discriminates. Q1 tracks the path forward.

## Open questions

- **Q1:** Should there be a dedicated `conflict_error` kind for HTTP 409?
  - _Current direction:_ Add when a second 409-emitting endpoint lands (e.g., `stopGuardrailGeneration` if AWS ships one). One data point doesn't justify a kernel-level error kind yet.
- **Q2:** `createBatch(input)` next?
  - _Current direction:_ Largest lift of the four batch endpoints. Full body shape validation (input/output S3 URIs, role ARN, model ID, timeout, vpcConfig). Defer until batch becomes an authoring surface (rather than a read-only observability surface).
- **Q3:** Should `stopBatch` return the post-stop status?
  - _Current direction:_ No. AWS returns empty body. Operators wanting confirmation call `getBatch` after stop.
- **Q4:** Should there be a `stopAllBatches({nameContains, statusEquals})` convenience wrapper?
  - _Current direction:_ Operators write the 10-line loop (as in the example above). Convenience wrappers tend to hide important error-handling decisions.
- **Q5:** Per-tenant rate limiting on stopBatch calls?
  - _Current direction:_ Out of scope — operators wrap with `withRetry` from ai-router if needed. AWS Bedrock's own throttling kicks in around 1 RPS per account for control-plane calls, which is usually plenty.
- **Q6:** Idempotency / at-most-once stop?
  - _Current direction:_ AWS doesn't expose a documented mechanism. Q1 deferred.
