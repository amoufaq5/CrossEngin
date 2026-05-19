# ADR-0108: Bedrock batch inference createBatch (Phase 2 M2.X.5.aa.z.6)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0105 (M2.X.5.aa.z.3 listBatches), ADR-0106 (M2.X.5.aa.z.4 getBatch), ADR-0107 (M2.X.5.aa.z.5 stopBatch) |

## Context

After M2.X.5.aa.z.5 the Bedrock batch surface is read-complete + cancel-complete, but operators still have to call out to AWS SDK / Terraform / console to submit new jobs. The asymmetry undercuts the value proposition: an operator detecting a runaway job can stop it via the provider but can't relaunch a corrected version through the same code path.

`CreateModelInvocationJob` is the largest of the four batch endpoints by body shape:
- 5 required fields: `jobName`, `modelId`, `roleArn`, `inputDataConfig.s3InputDataConfig.s3Uri`, `outputDataConfig.s3OutputDataConfig.s3Uri`.
- 4 optional top-level fields: `clientRequestToken` (idempotency), `tags` (cost attribution), `timeoutDurationInHours`, `vpcConfig`.
- 6 documented validation rules: name pattern, name length, role-ARN format, S3-URI scheme, input-format whitelist, timeout range, tag-count ceiling, tag-key/value lengths, VPC entry counts.

M2.X.5.aa.z.6 ships `BedrockProvider.createBatch(input)` with full boundary validation + a typed response shape. The response is intentionally minimal — AWS returns `{jobArn}` only; operators wanting more detail call `getBatch(jobArn)` immediately after.

## Decision

One new provider method, one new exported body-builder, one new exported response parser, and ~10 new boundary-validation constants.

### 1. `BedrockProvider.createBatch(input)`

```ts
async createBatch(input: BedrockCreateBatchInput): Promise<BedrockCreateBatchResponse>;
```

- Validates `input` via `buildCreateBatchBody` (throws `BedrockError invalid_request_error` BEFORE the fetch on any rule violation).
- POSTs the validated JSON body via `signedControlPlanePost` to `/model-invocation-jobs`.
- Parses the JSON body via `parseCreateBatchResponse` (returns `{jobArn}`).

### 2. `BedrockCreateBatchInput` shape

```ts
export interface BedrockCreateBatchInput {
  readonly jobName: string;                                // required
  readonly modelId: string;                                // required
  readonly roleArn: string;                                // required
  readonly inputDataConfig: BedrockBatchS3InputDataConfig; // required
  readonly outputDataConfig: BedrockBatchS3OutputDataConfig; // required
  readonly clientRequestToken?: string;                    // optional (idempotency)
  readonly tags?: ReadonlyArray<BedrockBatchTag>;          // optional (cost attribution)
  readonly timeoutDurationInHours?: number;                // optional (24-168)
  readonly vpcConfig?: BedrockBatchVpcConfig;              // optional
}
```

The `BedrockBatchS3InputDataConfig` / `BedrockBatchS3OutputDataConfig` / `BedrockBatchVpcConfig` types from M2.X.5.aa.z.3 are reused unchanged.

### 3. Boundary validation rules (all enforced by `buildCreateBatchBody`)

| Field | Constraint | Constant |
|---|---|---|
| `jobName` length | `[1, 63]` | `BEDROCK_BATCH_JOB_NAME_MAX_LEN` |
| `jobName` pattern | `^[a-zA-Z0-9](-*[a-zA-Z0-9])*$` | `BEDROCK_BATCH_JOB_NAME_PATTERN` |
| `modelId` length | `[1, 2048]` | `BEDROCK_BATCH_MODEL_ID_MAX_LEN` |
| `roleArn` pattern | `^arn:aws(-[^:]+)?:iam::[0-9]{12}:role/.+$` | `BEDROCK_BATCH_ROLE_ARN_PATTERN` |
| `s3Uri` pattern (in + out) | `^s3://[a-z0-9.\-_]{1,255}/.*$` | `BEDROCK_BATCH_S3_URI_PATTERN` |
| `s3InputFormat` | `JSONL` only | `BEDROCK_BATCH_S3_INPUT_FORMAT_VALUES` |
| `clientRequestToken` length | `[1, 256]` | `BEDROCK_BATCH_CLIENT_REQUEST_TOKEN_MAX_LEN` |
| `clientRequestToken` pattern | same as jobName | `BEDROCK_BATCH_CLIENT_REQUEST_TOKEN_PATTERN` |
| `timeoutDurationInHours` | integer `[24, 168]` | `BEDROCK_BATCH_TIMEOUT_HOURS_MIN/MAX` |
| `tags` count | `≤ 200` | `BEDROCK_BATCH_MAX_TAGS` |
| `tag.key` length | `[1, 128]` | `BEDROCK_BATCH_TAG_KEY_MAX_LEN` |
| `tag.value` length | `[0, 256]` | `BEDROCK_BATCH_TAG_VALUE_MAX_LEN` |
| `vpcConfig.subnetIds` count | `[1, 16]` | `BEDROCK_BATCH_VPC_MAX_ENTRIES` |
| `vpcConfig.securityGroupIds` count | `[1, 16]` | `BEDROCK_BATCH_VPC_MAX_ENTRIES` |

All ARN patterns are AWS-partition-aware (`aws`, `aws-us-gov`, `aws-cn`) per the M2.X.5.aa.z.4 convention.

### 4. `BedrockCreateBatchResponse` shape

```ts
export interface BedrockCreateBatchResponse {
  readonly jobArn: string;
}
```

`parseCreateBatchResponse` is strict — missing / empty / non-string `jobArn` throws `BedrockError api_error`. Operators wanting fuller post-create state call `getBatch(out.jobArn)` immediately after.

### 5. Transport — widened `signedControlPlanePost`

The M2.X.5.aa.z.5 helper accepted only `{path}` (empty body). M2.X.5.aa.z.6 widens to `{path, body?}` with default `new Uint8Array(0)`. stopBatch's call is unchanged; createBatch supplies its JSON body bytes.

### 6. Error mapping

- `200 / {jobArn}` → resolve `{jobArn}`.
- `400 ValidationException` → `invalid_request_error` (AWS-side validation, e.g., role lacks `s3:GetObject`).
- `403 AccessDeniedException` → `permission_error`.
- `409 ConflictException` (jobName already exists, or clientRequestToken reused with different payload) → `kind: "unknown_error"` + `code: "ConflictException"` (same as M2.X.5.aa.z.5 — dedicated `conflict_error` kind still deferred).
- `429 ThrottlingException` → `rate_limit_error`.
- Network → `network_error` / `timeout_error`.
- JSON parse / missing `jobArn` → `api_error`.

## Cross-cutting invariants enforced

- **Boundary validation BEFORE network.** All 14 validation rules fail fast without burning a request.
- **AWS-partition-aware ARN regexes.** `roleArn` accepts the same three partitions as `jobIdentifier` (M2.X.5.aa.z.4).
- **Body builder is pure + exported.** `buildCreateBatchBody` is unit-testable without spinning a provider. Operators writing CI / lint tools can validate request shapes statically.
- **Response parser is strict + exported.** `parseCreateBatchResponse` throws on any unexpected shape. Operators reusing the parser on non-API sources (replay logs, EventBridge events) get consistent typing.
- **Reuses M2.X.5.aa.z.3 types.** `BedrockBatchS3InputDataConfig` / `BedrockBatchS3OutputDataConfig` / `BedrockBatchVpcConfig` are NOT redefined.
- **No kernel changes.** `LlmProvider` interface unchanged. `createBatch` is Bedrock-specific.
- **Backwards compat preserved.** No M2.X.5.aa.z.3 / .4 / .5 tests changed; only additions. signedControlPlanePost widening is backwards-compatible (body defaults to empty).

## End-to-end semantic

```ts
// Submit a batch job, poll to completion, surface the output URI.
const provider = new BedrockProvider({ accessKeyId, secretAccessKey, region: "us-east-1" });
const { jobArn } = await provider.createBatch({
  jobName: "tenant-x-claims-2026-05-19",
  modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  roleArn: "arn:aws:iam::123456789012:role/BedrockBatchRole",
  inputDataConfig: {
    s3InputDataConfig: {
      s3Uri: "s3://tenant-x-data/in/claims-2026-05-19.jsonl",
      s3InputFormat: "JSONL",
    },
  },
  outputDataConfig: {
    s3OutputDataConfig: {
      s3Uri: "s3://tenant-x-data/out/claims-2026-05-19/",
    },
  },
  clientRequestToken: "claims-2026-05-19",  // idempotency: re-submitting same payload returns same job
  tags: [
    { key: "tenant", value: "tenant-x" },
    { key: "purpose", value: "claims-classification" },
  ],
  timeoutDurationInHours: 48,
});

// Poll to completion (using getBatch from M2.X.5.aa.z.4).
async function awaitTerminal(arn: string): Promise<BedrockBatchJobDetail> {
  while (true) {
    const detail = await provider.getBatch(arn);
    if (["Completed", "PartiallyCompleted", "Failed", "Stopped", "Expired"].includes(detail.status)) {
      return detail;
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}
const final = await awaitTerminal(jobArn);
console.log("output at:", final.outputDataConfig.s3OutputDataConfig.s3Uri);
```

## Alternatives considered

- **Accept arbitrary `input` and let AWS validate server-side.**
  - **Considered.** Less validation code.
  - **Cons.** Loses fast-fail on the boundary; operators submit a 400-bait request and only learn after the fetch. The 14 documented constraints are stable; encoding them client-side is ~50 lines.
  - **Decision.** Validate at boundary.

- **Return the full `BedrockBatchJobDetail` from `createBatch` (auto-call `getBatch` after submit).**
  - **Considered.** One round trip closer to "create returns full state."
  - **Cons.** AWS's create response really is just `{jobArn}` — the just-created job's state is `Submitted` (always), with no `endTime` etc. The auto-call wastes a request 99% of the time.
  - **Decision.** Return `{jobArn}` only. Operators wanting more call `getBatch` explicitly.

- **Add a `createBatchAndAwait(input, {pollIntervalMs, timeoutMs})` convenience method.**
  - **Considered.** Polling is the common usage.
  - **Cons.** Polling parameters vary per workflow (claims processing might poll every 60s; embeddings batch every 10s). Convenience methods that hide pollers tend to need rewriting.
  - **Decision.** Provide `createBatch` + `getBatch` separately. Operators compose.

- **Tighten the `modelId` validation to a documented Bedrock model regex.**
  - **Considered.** Catch typos at boundary.
  - **Cons.** AWS accepts base model IDs, ARNs, inference profile IDs, custom model ARNs, and (recently) inference profile ARNs. The valid-shapes space is wide and growing. Length-only validation is honest about that.
  - **Decision.** Length validation only (1-2048 chars).

- **Require `s3InputFormat: "JSONL"` (don't make it optional).**
  - **Considered.** It's currently the only accepted value.
  - **Cons.** AWS defaults to JSONL when omitted. Forcing it on operator code is unnecessary friction. Making it optional + whitelist-validated when supplied is the cleanest middle path.
  - **Decision.** Optional + whitelist-validated.

- **Validate `clientRequestToken` content against operator-supplied uniqueness rules.**
  - **Considered.** Catch token-reuse before AWS does.
  - **Cons.** Uniqueness is operator-specific (some want per-tenant scoping, some per-day). The shape regex catches obvious bugs; uniqueness is operator responsibility.
  - **Decision.** Shape + length only. AWS surfaces re-use as ConflictException.

- **Throw a typed `BedrockBatchConflictError extends BedrockError` for 409s.**
  - **Considered.** Operators handling `createBatch` conflicts often want specific behavior.
  - **Cons.** Same as ADR-0107 Q1 — adding a new error subclass for one endpoint without a kernel-level kind sets a confusing precedent. Defer.
  - **Decision.** No new error subclass; operators discriminate on `.code === "ConflictException"`.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,947 tests** (+27 from M2.X.5.aa.z.6: 18 batch-api + 9 provider). All green, zero type errors.
- **Bedrock batch CRUD is feature-complete.** All four documented endpoints (list, get, stop, create) now have provider methods.
- **Round-trip workflows unblocked.** Operators can detect a runaway batch via getBatch, stop it via stopBatch, fix the input, and relaunch via createBatch — all through the kernel.
- **Boundary-validation pattern set for write surfaces.** Future POST-with-body control-plane methods (e.g., `createGuardrail`, `createInferenceProfile`) follow the same shape: pure body-builder + exported response parser + provider thin wrapper.
- **Idempotency via clientRequestToken supported.** Re-submitting the same payload (same token, same body) returns the same job ARN; different bodies with the same token return 409.
- **Cost attribution via tags supported.** Operators threading `tenant` / `purpose` / `cost-center` tags get them on the AWS billing surface (Cost Explorer, Billing Alarms).
- **VPC-scoped jobs supported.** Operators with strict network egress policies can route their batch invocations through specific subnets + security groups.
- **ConflictException handling remains structurally unaddressed.** Two endpoints now emit 409 (stopBatch + createBatch); a dedicated `conflict_error` kernel kind would now be justified. Tracked in Q1.

## Open questions

- **Q1:** Add a dedicated `conflict_error` kernel kind?
  - _Current direction:_ Yes — two endpoints now emit 409. M2.X.12 (proposed) would add `isConflictError(err)` to ai-providers + extend Bedrock CODE_TO_KIND. Holding for one more milestone to confirm the shape.
- **Q2:** Per-operator tag policy (require certain keys)?
  - _Current direction:_ Out of scope for the provider. Operators wrap createBatch with their own tag-injecting facade.
- **Q3:** Helper to derive `clientRequestToken` from a content hash for natural idempotency?
  - _Current direction:_ Out of scope. Operators wanting hash-keyed idempotency compose `crypto.sha256Hex` with their inputs.
- **Q4:** Should `createBatch` auto-truncate jobName to fit the 63-char limit?
  - _Current direction:_ No. Truncation strategy is operator-specific (prefix? suffix? hash?). Fast-fail surfaces the bug.
- **Q5:** Should `BedrockBatchS3InputFormat` be a re-export from `BedrockBatchS3InputDataConfig`?
  - _Current direction:_ Already exported as the standalone type. Operators can `import { BedrockBatchS3InputFormat } from "@crossengin/ai-providers-bedrock"`.
- **Q6:** What about Bedrock-Marketplace-Model batch jobs (custom marketplace models)?
  - _Current direction:_ The same API accepts marketplace model ARNs in `modelId`. No separate code path needed.
- **Q7:** Async-iterable `submitAndPoll` helper in ai-router?
  - _Current direction:_ Watch usage. If three operators write essentially-identical polling loops, lift to ai-router as `pollUntilTerminal(provider, jobArn, terminalSet, opts)`.
