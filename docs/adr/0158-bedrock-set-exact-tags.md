# ADR-0158: Bedrock `setExactTags` operator helper (Phase 2 M6.8.y)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0145 (M2.X.5.aa.z.24 cross-resource tagging) |

## Context

ADR-0145 / M2.X.5.aa.z.24 shipped the three cross-resource Bedrock tag operations: `tagResource`, `untagResource`, `listTagsForResource`. Each is a raw transport primitive — operators call them one at a time. ADR-0145 Q5 lined up a higher-level operator helper:

> Q5: Should there be a `setExactTags` helper that diffs current vs desired and applies the minimum tag/untag set?
> _Current direction:_ Useful operator workflow. Build it operator-side or in a future helper milestone. Substrate is the raw transport.

Operator pain it solves:

1. **Convergence to a desired state.** Operators with `terraform apply`-style workflows want "make the tags on this resource look exactly like X" without writing the diff logic themselves.
2. **Minimum API calls.** Naïvely calling `tagResource(desired)` + `untagResource(allCurrentKeys)` double-bills: untag deletes tags that immediately get re-added. The diff helper minimizes round-trips.
3. **Idempotency.** Re-running `setExactTags` with the same desired set should be a no-op on the second run — the helper detects "nothing changed" and skips the tag/untag calls.
4. **Audit trail.** Operators want a result object showing what changed (`added`, `removed`, `unchanged`) for compliance + CI dashboards.

M6.8.y closes Q5.

## Decision

Standalone exported function `setExactTags(provider, input)` in a new `tagging-helpers.ts` file in `@crossengin/ai-providers-bedrock`. Keeps the substrate's three-tier layering: `tagging-api.ts` (pure types + builders + parsers), `provider.ts` (raw transport via `BedrockProvider` methods), `tagging-helpers.ts` (operator-facing composition).

```ts
export interface SetExactTagsInput {
  readonly resourceArn: string;
  readonly desiredTags: ReadonlyArray<BedrockTag>;
}

export interface SetExactTagsResult {
  readonly added: readonly BedrockTag[];
  readonly removed: readonly string[];
  readonly unchanged: readonly BedrockTag[];
}

export async function setExactTags(
  provider: BedrockProvider,
  input: SetExactTagsInput,
): Promise<SetExactTagsResult>;
```

### Algorithm

1. **Pre-flight validation.** Non-empty resourceArn + no duplicate desired keys.
2. **Read current state.** `provider.listTagsForResource({resourceArn})`.
3. **Diff.**
   - `added`: every desired tag whose key is absent from current OR whose value differs.
   - `removed`: every current key NOT present in desired.
   - `unchanged`: every desired tag whose key+value match a current tag exactly.
4. **Apply.**
   - If `added` non-empty → `tagResource({resourceArn, tags: added})`.
   - If `removed` non-empty → `untagResource({resourceArn, tagKeys: removed})`.
5. **Return audit object** — `{added, removed, unchanged}`.

The helper issues 1, 2, or 3 API calls depending on the diff:
- **1 call** (list only): no changes needed.
- **2 calls** (list + tag): only additions / value updates.
- **2 calls** (list + untag): only removals.
- **3 calls** (list + tag + untag): mixed changes.

### Why tag-then-untag ordering?

If a key transitions value (e.g., `env: staging → prod`), the helper treats it as a value update and includes it in `added`. AWS's `tagResource` OVERWRITES the value for an existing key — no untag-then-tag round-trip needed. The helper benefits from this AWS contract; `removed` only contains keys not in desired.

If a key moves to a fundamentally different key+value (e.g., key rename), it's two separate diff entries: `removed: ["old_key"]`, `added: [{new_key, value}]`. The helper issues tag THEN untag — but the order doesn't matter functionally since the keys are distinct.

### Why a standalone function (not a `BedrockProvider` method)?

Substrate layering. `BedrockProvider`'s methods are 1:1 with AWS API endpoints — each method maps to a single AWS call. Adding `provider.setExactTags(...)` mixes "raw transport" with "operator composition," blurring the substrate's interface contract.

A standalone helper preserves the separation: the substrate is the transport floor; helpers compose above. Operators wanting custom workflows write their own helpers without touching the substrate.

### Why a separate file (not in `tagging-api.ts`)?

`tagging-api.ts` contains PURE code: types, builders that just validate + serialize, parsers that just deserialize. It has no network dependency, no I/O. It's testable as a unit without mocks.

`setExactTags` ORCHESTRATES three API calls. It's impure (network I/O). Keeping it in a separate `tagging-helpers.ts` preserves the purity invariant of the api modules.

## Cross-cutting invariants enforced

- **Idempotent.** Re-running with the same desired set on a converged resource issues 1 API call (list) and returns `added=[], removed=[], unchanged=desired`.
- **Minimum API calls.** Never both tag AND untag a same key in a single run. Value updates use a single `tagResource` call.
- **Tag-then-untag ordering.** Additions before removals — important for resources with tag-count limits where temporarily exceeding the limit would fail.
- **Pre-flight validation.** Duplicate desired keys + empty resourceArn rejected BEFORE any AWS call (saves cost on bad inputs).
- **Audit trail in the return value.** `SetExactTagsResult` is the operator's record of what changed — ready to log, store in workflow rows, or surface in dashboards.
- **No substrate creep.** `BedrockProvider` remains a 1:1 wrapper of AWS endpoints. Helper sits above.
- **No swallowed errors.** Any underlying AWS error (404, 403, 429, etc.) propagates as the corresponding `BedrockError` kind.
- **Empty value handling.** AWS allows empty tag values — the helper preserves this through the diff (treats empty-vs-undefined as a value mismatch).
- **AWS tagResource overwrites existing values.** The helper doesn't need an explicit untag-then-tag flow for value updates.

## End-to-end semantic

```ts
import { setExactTags, BedrockProvider } from "@crossengin/ai-providers-bedrock";

const bedrock = new BedrockProvider({...});

// Make the tags look EXACTLY like the desired set:
const result = await setExactTags(bedrock, {
  resourceArn: "arn:aws:bedrock:us-east-1:123:custom-model/abc",
  desiredTags: [
    { key: "env", value: "prod" },
    { key: "team", value: "platform" },
    { key: "compliance", value: "soc2" },
  ],
});

console.log(result.added);     // [{ key: "compliance", value: "soc2" }]
console.log(result.removed);   // ["stale-tag"]
console.log(result.unchanged); // [{ key: "env", value: "prod" }, { key: "team", value: "platform" }]

// CI safety gate — refuse to apply if it would remove > 5 tags:
const preview = await setExactTags(bedrock, { resourceArn, desiredTags });
if (preview.removed.length > 5) {
  throw new Error(`Too many tag removals (${preview.removed.length}); aborting`);
}

// Idempotent — running again is a 1-call no-op:
const second = await setExactTags(bedrock, { resourceArn, desiredTags });
// second.added = [], second.removed = [], second.unchanged = desired
```

The helper is safe to wire into convergence loops (workflows, CI/CD apply steps, scheduled reconciliation jobs).

## Alternatives considered

- **Add `setExactTags` as a method on `BedrockProvider`.**
  - **Considered.** Operator ergonomics.
  - **Cons.** Mixes "raw transport" with "operator composition." Provider methods are AWS-endpoint-shaped; adding composed helpers breaks the 1:1 contract.
  - **Decision.** Standalone function.

- **Always issue tag + untag regardless of diff.**
  - **Considered.** Simpler implementation.
  - **Cons.** Wasteful AWS calls. Double-billing on round-trips. Operators paying for unnecessary mutations.
  - **Decision.** Diff-aware minimization.

- **Issue untag BEFORE tag (remove stale before adding new).**
  - **Considered.** Avoids temporary tag-count-limit overflow.
  - **Cons.** AWS's 50-tag-per-resource limit is unlikely to be hit in real workflows. Tag-first preserves audit ("what's the new state look like before we clean up?") and matches operator mental model ("add what I want, then prune what I don't").
  - **Decision.** Tag then untag.

- **Atomic transaction-like semantics (all-or-nothing).**
  - **Considered.** Either all changes apply or none do.
  - **Cons.** AWS doesn't expose multi-resource transactions for tags. Partial failure is operator-handled (e.g., retry with the same input — helper is idempotent).
  - **Decision.** Best-effort, with results showing what changed.

- **Support diff-only mode (no apply, just return what WOULD change).**
  - **Considered.** Useful for CI safety gates.
  - **Cons.** Operators run the actual `setExactTags` once — the result tells them what changed. For pre-apply preview, they could call `listTagsForResource` themselves + compute the diff. Adding a `dryRun: boolean` option to the helper would be additive — defer.
  - **Decision.** Apply mode only. Defer `dryRun` to a follow-up.

- **Validate desired tags against AWS constraints (length, pattern) inside the helper.**
  - **Considered.** Catch errors earlier.
  - **Cons.** Duplicates the validation in `tagResource`'s body builder. AWS rejects with clear 400; substrate's `tagResource` validates pre-fetch already. No need to duplicate.
  - **Decision.** Defer to the underlying `tagResource` builder.

- **Use Map instead of array for desired tags (key uniqueness enforced by type).**
  - **Considered.** Compile-time uniqueness guarantee.
  - **Cons.** AWS docs treat tags as ordered-ish arrays. The helper validates uniqueness at runtime. Map would require operator-side conversion (verbose).
  - **Decision.** Array with runtime uniqueness check.

- **Cache `listTagsForResource` results to enable batch operations.**
  - **Considered.** Multi-resource workflows.
  - **Cons.** Operators wanting bulk processing iterate themselves. Helper is single-resource by design.
  - **Decision.** No cache.

- **Add `expectedTags` parameter for optimistic-concurrency (refuse if current doesn't match expected).**
  - **Considered.** Operator safety on concurrent edits.
  - **Cons.** AWS doesn't expose ETags for tags. Substrate can't fabricate optimistic concurrency. Operator-side workaround: read tags via `listTagsForResource`, verify, then call `setExactTags`.
  - **Decision.** No expectedTags.

## Consequences

- **56 packages + 1 app, 128 meta-schema tables, 8,068 tests** (+14 from M6.8.y: all in `tagging-helpers.test.ts`). All green, zero type errors.
- **Closes ADR-0145 Q5.**
- **No schema change, no new dependency.** Pure code addition in `@crossengin/ai-providers-bedrock`.
- **The substrate's tagging surface is now operator-friendly.** Three raw methods + one orchestration helper.
- **Index exports cleaned up.** Previously-missing exports (tagging-api, provisioned-throughput-api, foundation-models-api) added alongside the new tagging-helpers. Operators importing from `@crossengin/ai-providers-bedrock` now see the full type surface.
- **Pattern set for future operator helpers.** Diff-then-apply composition pattern reusable for inference-profile property updates, PT migrations, etc.
- **Idempotent + minimal-API-call composition.** Safe to wire into convergence loops, CI apply steps, scheduled reconciliation.

## Open questions

- **Q1:** Should there be a `dryRun: boolean` option that returns the diff without applying?
  - _Current direction:_ Useful for CI safety gates. Additive. Defer.
- **Q2:** Should the helper support bulk operations (`setExactTagsBulk(provider, [{arn, tags}, ...])`)?
  - _Current direction:_ Operator iterates. Substrate stays single-resource by design.
- **Q3:** Should there be a `mergeTags` variant (add desired, leave others alone — no removals)?
  - _Current direction:_ Operators call `tagResource` directly for that workflow. Helper is "make it look like X exactly."
- **Q4:** Should the helper validate AWS's 50-tags-per-resource limit?
  - _Current direction:_ `tagResource`'s builder validates against the upper bound (200) defined in `tagging-api.ts`. AWS enforces its own per-resource limit server-side.
- **Q5:** Should `setExactTags` emit instrumentation events (e.g., `tags_synced`)?
  - _Current direction:_ Operator-side wrapping if needed. Helper stays focused on the diff/apply.
- **Q6:** Should the helper support per-tag-action callbacks (`onTagAdd`, `onTagRemove`) for fine-grained logging?
  - _Current direction:_ The result object (`added`, `removed`, `unchanged`) gives the operator the same info post-hoc. Callbacks add complexity for marginal benefit.
- **Q7:** Should there be an `expectedCurrentTags` parameter for optimistic concurrency?
  - _Current direction:_ AWS doesn't expose ETag for tags. Out of scope.
- **Q8:** Should the helper live in a separate `@crossengin/bedrock-helpers` package?
  - _Current direction:_ Single file in `ai-providers-bedrock` is fine. Operators wanting a separate package can fork. If helpers proliferate (>5 functions), revisit.
