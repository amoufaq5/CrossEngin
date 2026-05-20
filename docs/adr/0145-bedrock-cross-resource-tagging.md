# ADR-0145: Bedrock cross-resource tagging — tagResource + untagResource + listTagsForResource (Phase 2 M2.X.5.aa.z.24)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0108 (createBatch + tags), ADR-0131 (createModelCustomizationJob + tags), ADR-0142 (createInferenceProfile + tags) |

## Context

The Bedrock control plane has accumulated 26 operations across 24 milestones (M2.9 through M2.X.5.aa.z.23). Every CREATE method accepts an optional `tags` array — `createBatch` (ADR-0108), `createModelCustomizationJob` (ADR-0131), `createInferenceProfile` (ADR-0142), and others. Operators can SET tags at create time, but they **cannot mutate tags post-creation** without dropping to the AWS CLI or rebuilding the resource:

- An operator who forgot to tag a fine-tune job can't add a `team=platform` tag retroactively.
- A custom model migrating between projects needs its `project=alpha` tag swapped for `project=beta`.
- Auditing a resource's current tag state requires either the resource's GET endpoint (which returns tags inline for SOME but not all surfaces) or going outside the substrate.

AWS Bedrock exposes three cross-resource tag operations that work against every Bedrock ARN: `TagResource`, `UntagResource`, `ListTagsForResource`. These are the **first multi-resource operations on the Bedrock control plane** — a single endpoint applies to any ARN: custom-models, imported-models, guardrails, inference-profiles, batches, customization-jobs, import-jobs, all of them.

M2.X.5.aa.z.24 ships all three.

## Decision

Three new methods on `BedrockProvider`:

```ts
async tagResource(input: BedrockTagResourceInput): Promise<void>;
async untagResource(input: BedrockUntagResourceInput): Promise<void>;
async listTagsForResource(
  input: BedrockListTagsForResourceInput,
): Promise<BedrockListTagsForResourceResponse>;
```

A new `tagging-api.ts` file hosts the types, builders, and parser. AWS contract is preserved verbatim including the **wire-shape asymmetry** between the three endpoints (this is the interesting part — AWS doesn't use a uniform shape):

| Operation | Path | Query | Body |
|---|---|---|---|
| TagResource | `POST /tags` | `?resourceARN={arn}` | `{tags: [...]}` |
| UntagResource | `POST /untag` | `?resourceARN={arn}` | `{tagKeys: [...]}` |
| ListTagsForResource | `POST /listTagsForResource` | _(none)_ | `{resourceARN: "..."}` |

The first two carry `resourceARN` in the QUERY string. The third carries `resourceARN` in the BODY. AWS's reasons aren't documented but the asymmetry is real. Substrate mirrors it.

### Transport extension

`signedControlPlanePost` (ADR-0108's POST transport) is extended to accept an optional `query?: Record<string, string>` parameter. The query string is signed via Sig v4 (already supported by `signRequest`'s `query` field). URL is rebuilt with `?qs` when query is non-empty. **No new transport — additive extension.** Existing callers (createBatch, createInferenceProfile, etc.) continue without changes; the new query param defaults to `{}`.

### Boundary validation (pure, pre-flight)

`buildTagResourceBody`, `buildUntagResourceBody`, `buildListTagsForResourceBody` enforce all AWS-documented constraints BEFORE fetch:

| Field | Constraint |
|---|---|
| `resourceArn` | length [1, 1011], starts with `arn:aws` |
| `tags` (TagResource) | length [1, 200] |
| `tagKeys` (UntagResource) | length [1, 200] |
| Tag key | length [1, 128], pattern `^[a-zA-Z0-9\s_.:/=+@-]*$` |
| Tag value | length [0, 256] (CAN be empty per AWS contract), pattern same |

Validation errors throw `BedrockError` with `kind: "invalid_request_error"` BEFORE any AWS call. Saves cost + load + crisp local error messages with the **index of the bad tag** in the error path:

```
tagResource: invalid tag key at index 2
```

### `BedrockTag` is the canonical cross-resource shape

Existing per-resource tag types (`BedrockBatchTag`, `BedrockInferenceProfileTag`, `BedrockModelCustomizationJobTag`) remain — they were defined alongside their CREATE endpoints for documentation clarity. The new generic `BedrockTag` lives in `tagging-api.ts` and is the shape returned by `listTagsForResource`. Structurally they're all `{key: string, value: string}`; the duplication is intentional for self-documenting per-resource APIs.

## Cross-cutting invariants enforced

- **AWS wire-shape asymmetry preserved verbatim.** TagResource + UntagResource use the query for the ARN; ListTagsForResource uses the body. Substrate doesn't paper over the asymmetry; operators reading AWS docs see the same shape they get.
- **Pure boundary validation.** All length / pattern / count checks happen pre-fetch. The validators are pure helpers — testable without a mock fetch.
- **Index-aware error messages.** "invalid tag key at index 2" lets operators with 200-tag batches find the bad entry without bisecting.
- **Empty tag value is valid.** AWS allows empty string values; substrate respects that. Empty key is rejected (length [1, 128]).
- **Multi-resource by construction.** No URI templating per resource type — the ARN goes in the query or body. Same three methods cover custom-models + imported-models + guardrails + inference-profiles + jobs + batches.
- **Symmetric error propagation.** 404 → `not_found_error` (ARN doesn't exist), 403 → `permission_error` (no `bedrock:TagResource` IAM permission), 429 → `rate_limit_error`, 5xx → `server_error`.
- **No partial mutations.** `tagResource` either succeeds for all provided tags or fails atomically. `untagResource` is similarly atomic across `tagKeys`. AWS enforces this server-side; substrate doesn't override.
- **First multi-resource Bedrock operations.** Pattern set for future cross-resource operations (e.g., a hypothetical `migrateResource`).

## End-to-end semantic

```ts
import { BedrockProvider } from "@crossengin/ai-providers-bedrock";
import { isNotFoundError } from "@crossengin/ai-providers";

const bedrock = new BedrockProvider({...});

const customModelArn = "arn:aws:bedrock:us-east-1:123:custom-model/abc";

// Add tags to an existing resource.
await bedrock.tagResource({
  resourceArn: customModelArn,
  tags: [
    { key: "env", value: "prod" },
    { key: "team", value: "platform" },
    { key: "owner", value: "" },  // empty value valid
  ],
});

// Read back the current tag state.
const { tags } = await bedrock.listTagsForResource({
  resourceArn: customModelArn,
});
console.log(tags);  // [{key:"env",value:"prod"}, ...]

// Remove a specific tag.
await bedrock.untagResource({
  resourceArn: customModelArn,
  tagKeys: ["owner"],
});

// Idempotent-tag (silent on resource-already-gone):
try {
  await bedrock.tagResource({ resourceArn, tags: [{key: "k", value: "v"}] });
} catch (err) {
  if (!isNotFoundError(err)) throw err;
  // Resource gone; no tags to set; operator workflow continues.
}
```

The three methods work across every Bedrock-owned ARN. No URI templating, no resource-specific overloads.

## Alternatives considered

- **Per-resource tag methods (e.g., `tagCustomModel(modelId, tags)`).**
  - **Considered.** Stronger typing on resource identity.
  - **Cons.** AWS exposes the cross-resource surface; substrate would have to fabricate per-resource methods on top. 7+ resource types × 3 verbs = 21 methods for no real benefit. The unified surface IS the AWS contract.
  - **Decision.** Cross-resource methods, one per verb.

- **Use a single `manageTags(input: {op: "set"|"remove"|"list", ...})` method.**
  - **Considered.** One method, discriminated union.
  - **Cons.** Loses type narrowness on inputs (TagResource needs `tags`, UntagResource needs `tagKeys`, ListTagsForResource needs neither). Three separate methods compile-check the operator's intent better.
  - **Decision.** Three named methods.

- **Hide the wire-shape asymmetry behind a uniform interface (all three take a `tags: {...}` body).**
  - **Considered.** Cleaner from the substrate's perspective.
  - **Cons.** AWS sees a malformed request and 400s. The substrate can't paper over AWS's contract.
  - **Decision.** Mirror AWS verbatim.

- **Add `tagResource` to the `signedControlPlanePost` transport directly (no new file).**
  - **Considered.** Less plumbing.
  - **Cons.** `tagging-api.ts` is the right home for the types + validators + parsers. Keeping them separate matches the existing pattern (batch-api.ts, guardrails-api.ts, etc.).
  - **Decision.** New file.

- **Validate resourceArn against a regex that enforces the Bedrock ARN shape (e.g., `arn:aws:bedrock:.*`).**
  - **Considered.** Tighter pre-flight.
  - **Cons.** Bedrock resources include cross-region ARNs, customer-owned KMS keys, S3 buckets used as data sources — operators may pass non-Bedrock ARNs that AWS happily tags. Length + `arn:aws` prefix is the safest minimum check; AWS rejects malformed ARNs with a clear 400.
  - **Decision.** Length + prefix check only.

- **Auto-retry idempotent operations (TagResource is naturally idempotent — re-applying the same tag returns success).**
  - **Considered.** Hide transient failures.
  - **Cons.** Out of scope. Idempotency lives in the router retry layer (M6.6 onward). Provider-level retry would duplicate.
  - **Decision.** No provider-level retry.

- **Combine ListTagsForResource into the per-resource GET methods.**
  - **Considered.** "I just want one round-trip."
  - **Cons.** Some GET surfaces (e.g., `getModelImportJob`) DON'T return tags inline. AWS provides ListTagsForResource as the canonical surface. Operators wanting one-shot use `getX` + `listTagsForResource` in parallel.
  - **Decision.** Keep separate.

- **Return the updated tag set from `tagResource` / `untagResource` (like a PUT with body).**
  - **Considered.** Save the operator a second round-trip.
  - **Cons.** AWS's response is empty for both. Substrate would have to fabricate the response by calling `listTagsForResource` internally — extra round-trip the operator can opt into themselves.
  - **Decision.** Return void on tag/untag. Operators call `listTagsForResource` if they need the updated state.

## Consequences

- **56 packages + 1 app, 127 meta-schema tables, 7,781 tests** (+53 from M2.X.5.aa.z.24: 32 in `tagging-api.test.ts` covering all boundary validations + parser shape; 21 in `provider.test.ts` covering wire shape + error propagation across all three methods).
- **Bedrock control plane: 18 read + 2 stop + 2 create + 4 delete + 3 tag = 29 operations.** Cross-resource tagging round-trips for every Bedrock ARN.
- **First multi-resource operations on the substrate.** Pattern set for future cross-resource verbs.
- **Closes ADR-0142 Q2.**
- **`signedControlPlanePost` transport extended additively.** Now supports optional query strings; existing callers unaffected.
- **Operator workflow: post-creation tag mutation is now first-class.** Forgot a tag? Add it. Moving projects? Swap tags. Audit needed? List them.
- **Empty value semantics preserved.** Some operator workflows use empty values as "tag exists, intentionally has no value."

## Open questions

- **Q1:** Should there be a `tagAllResources` helper for batch tagging across many ARNs?
  - _Current direction:_ No — AWS doesn't expose a batch API. Operator iterates with a 3-line wrap.
- **Q2:** Should the substrate validate that the ARN is a Bedrock ARN specifically (e.g., `arn:aws:bedrock:` prefix)?
  - _Current direction:_ No — operators might pass cross-service ARNs that AWS happens to tag (rare but real). AWS rejects non-taggable ARNs server-side with a clear 400.
  - _Caveat:_ If real-world misuse becomes common, tighten the check.
- **Q3:** Should `untagResource` accept a `tagKeys: ["*"]` wildcard meaning "remove all tags"?
  - _Current direction:_ AWS doesn't support wildcard. Operators call `listTagsForResource` then iterate.
- **Q4:** Should the result of `listTagsForResource` be sorted (currently passes through whatever AWS returns)?
  - _Current direction:_ Passes through. AWS doesn't document an order; operators sort client-side if needed.
- **Q5:** Should there be a `setExactTags` helper that diffs current vs desired and applies the minimum tag/untag set?
  - _Current direction:_ Useful operator workflow. Build it operator-side or in a future helper milestone. Substrate is the raw transport.
- **Q6:** Should the response on `listTagsForResource` include pagination (`nextToken`)?
  - _Current direction:_ AWS doesn't paginate tags (200-tag max per resource is small enough). If AWS adds pagination later, additive change.
- **Q7:** Should empty-string tag values be normalized (e.g., trim, coerce to `null`)?
  - _Current direction:_ No — preserve AWS contract verbatim. Operators choosing empty values mean it.
- **Q8:** Should the substrate emit a `RouterInstrumentation`-style event on tag operations?
  - _Current direction:_ Out of scope. RouterInstrumentation (ADR-0141) is LLM-call-scoped, not control-plane-mutation-scoped. A separate `BedrockControlPlaneInstrumentation` could be added if operators ask.
