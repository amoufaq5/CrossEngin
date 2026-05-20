# ADR-0125: cacheBreakpoint field on LlmContentBlock + Anthropic prompt caching (Phase 2 M2.X.11)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0088 (M2.X.5 LlmMessage.content discriminated union), ADR-0089 (M2.X.5.x tool_use/tool_result blocks), ADR-0119 (M5.10.5 chat substrate content blocks) |

## Context

Anthropic supports per-block prompt caching via the `cache_control: {type: "ephemeral"}` field. Setting it on a content block instructs the API to cache the prefix UP TO AND INCLUDING that block — subsequent identical prefixes get charged at the discounted cached-input rate (~10x cheaper) instead of full input cost.

Use cases:

1. **Long static context.** Embed a 50-token-page document into a chat substrate; mark a `cacheBreakpoint` on the document block. Every subsequent turn that includes the same document hits the cache.
2. **Multi-turn tool sessions.** Mark a `cacheBreakpoint` on the last tool_result that contains expensive search output. Subsequent turns retrieving the same conversation history benefit.
3. **Few-shot prefixes.** Mark a `cacheBreakpoint` on the final example in a few-shot prompt template. Different operator inputs after the example all hit cache for the prefix.

Operators have been writing workarounds — pasting `cache_control` into raw Anthropic-shaped messages and bypassing the kernel — because the kernel `LlmContentBlock` didn't expose it. M2.X.11 fixes that with a tiny additive field.

OpenAI's prompt caching is implicit (no per-block control on Chat / Responses APIs). Bedrock's Converse API supports caching via a SEPARATE `cachePoint` block type (different wire shape entirely). For tight scope, M2.X.11 ships the kernel field + Anthropic translator only; OpenAI silently drops it, Bedrock translation is deferred.

## Decision

One new optional field on `LlmContentBlock` + Anthropic translator wiring.

### 1. `LlmCacheBreakpoint` type + schema

```ts
export const LLM_CACHE_BREAKPOINT_TYPES = ["ephemeral"] as const;
export type LlmCacheBreakpointType = (typeof LLM_CACHE_BREAKPOINT_TYPES)[number];

export const LlmCacheBreakpointSchema = z.object({
  type: LlmCacheBreakpointTypeSchema,
});
export type LlmCacheBreakpoint = z.infer<typeof LlmCacheBreakpointSchema>;
```

Single-value tuple today (`ephemeral`). Future Anthropic extensions (persistent caching, named-key caching) extend the tuple without breaking call sites.

### 2. Optional field on every LlmContentBlock variant

```ts
readonly cacheBreakpoint?: LlmCacheBreakpoint;
```

Added to all 8 block schemas:
- `TextContentBlockSchema`
- `ImageContentBlockSchema`
- `ImageUrlContentBlockSchema`
- `DocumentContentBlockSchema`
- `DocumentUrlContentBlockSchema`
- `FileReferenceContentBlockSchema`
- `ToolUseContentBlockSchema`
- `ToolResultContentBlockSchema`

Why on every block: Anthropic's `cache_control` is valid on every block type. Restricting the kernel field would over-constrain operators.

### 3. Anthropic translator emission

`@crossengin/ai-providers-anthropic/src/messages-api.ts`:
- `translateKernelBlock(block)` refactored to call `translateKernelBlockShape(block)` then post-process via `withCacheControl(block, shaped)`.
- `withCacheControl` shallow-spreads the shaped block and adds `cache_control: {type: block.cacheBreakpoint.type}` when present.
- `AnthropicCacheControl` type alias exported.
- `AnthropicContentBlock` union widened — every variant gains an optional `cache_control?: AnthropicCacheControl` field.

### 4. OpenAI + Bedrock — silent drop

OpenAI translators (`chat-api.ts` + `responses-api.ts`) ignore the field. OpenAI handles caching implicitly via prefix-stability heuristics; there's no per-block knob to wire.

Bedrock translator (`converse-api.ts`) ignores the field for now. Bedrock's Converse API exposes caching via a SEPARATE `cachePoint` block type (`{cachePoint: {type: "default"}}` inserted into the content array), which is a structurally different wire shape from Anthropic's inline `cache_control`. Future M2.X.11.x can extend the Bedrock translator to either insert `cachePoint` blocks or throw with actionable guidance.

The field is OPTIONAL on every block — operators writing cross-provider portable code can include it; providers that don't honor it gracefully drop. Anthropic-targeted code gets cache hits; OpenAI / Bedrock get the same correctness without the cache discount.

## Cross-cutting invariants enforced

- **Additive on all 8 block variants.** Every kernel content block gains the optional field.
- **No breaking change.** Existing call sites that don't set `cacheBreakpoint` produce byte-identical wire output for every provider.
- **Strict enum tuple.** `LLM_CACHE_BREAKPOINT_TYPES` is case-sensitive; unknown values reject at parse time.
- **Anthropic-native wire shape preserved.** `cache_control: {type: "ephemeral"}` matches AWS's documented Anthropic API contract verbatim.
- **OpenAI + Bedrock silently drop.** No throws — operators with cross-provider code keep the field set everywhere.
- **Per-block granularity.** Operators can set breakpoints on multiple blocks for partial caching strategies.

## End-to-end semantic

```ts
import type { CompletionRequest } from "@crossengin/ai-providers";

// Long static context cached across turns.
const longDocBytes = "..."; // base64 PDF
const messages: CompletionRequest["messages"] = [
  {
    role: "user",
    content: [
      {
        type: "document",
        format: "pdf",
        bytes: longDocBytes,
        name: "company-handbook.pdf",
        cacheBreakpoint: { type: "ephemeral" },  // cache from here back
      },
      { type: "text", text: "What's our vacation policy?" },
    ],
  },
];

const req: CompletionRequest = {
  task: "executor",
  messages,
  tenantId: "ten-x",
  sessionId: "sess-1",
};

// On Anthropic: emits cache_control on the document block.
// On OpenAI: silently drops cacheBreakpoint; works correctly without cache discount.
// On Bedrock: silently drops for now (future milestone wires cachePoint).
await provider.complete(req);

// Subsequent turn with the same document → cache hit on Anthropic (10x cheaper).
messages.push({ role: "assistant", content: "..." });
messages.push({ role: "user", content: "What about parental leave?" });
await provider.complete({ ...req, messages });
```

## Alternatives considered

- **Add `cacheBreakpoint` only to TextContentBlock + DocumentContentBlock.**
  - **Considered.** Most caching value is in long static text/document context.
  - **Cons.** Operators caching expensive tool_result outputs would have to wrap the result in a text block. Less idiomatic.
  - **Decision.** All 8 variants get the field. ~10 lines of schema additions.

- **Field name `cacheControl` instead of `cacheBreakpoint`.**
  - **Considered.** Matches Anthropic's wire field name.
  - **Cons.** "Control" implies a runtime knob; what the field actually does is mark a BREAKPOINT (boundary) in the cache key. "cacheBreakpoint" describes the semantic.
  - **Decision.** `cacheBreakpoint`. The Anthropic translator maps to Anthropic's wire name.

- **Make the field non-optional with a `null` default.**
  - **Considered.** Always-present field is easier to read.
  - **Cons.** Forces every operator to write `cacheBreakpoint: null` on every block. Optional with `undefined` is idiomatic TS.
  - **Decision.** Optional.

- **Bundle Bedrock cachePoint wiring into this milestone.**
  - **Considered.** Cross-provider symmetry.
  - **Cons.** Bedrock's cachePoint is a structurally different wire shape (separate block type inserted into the array, not an inline field). Requires translator logic that doesn't reuse Anthropic's shape. Larger lift than the kernel field addition.
  - **Decision.** Anthropic-only in M2.X.11. Bedrock in a follow-up.

- **Throw on Bedrock / OpenAI when `cacheBreakpoint` is set (actionable guidance).**
  - **Considered.** Surfaces unsupported caching to operators.
  - **Cons.** Cross-provider portable code becomes a minefield — operators have to wrap every cacheBreakpoint in a provider check.
  - **Decision.** Silent drop. Operators who care about cache hits inspect provider responses + usage telemetry.

- **Validate that no two breakpoints exist within N blocks of each other (Anthropic's 4-breakpoint-per-request limit).**
  - **Considered.** Catch limit violations at kernel layer.
  - **Cons.** Limit is Anthropic-specific; operators retargeting to other providers shouldn't run into kernel validation. Anthropic's API surfaces the limit clearly on 400 responses.
  - **Decision.** No kernel-side limit enforcement. Anthropic surfaces violations.

## Consequences

- **55 packages + 1 app, 120 meta-schema tables, 7,399 tests** (+23 from M2.X.11: 14 ai-providers/types.test.ts + 9 anthropic/messages-api.test.ts). All green, zero type errors.
- **Anthropic prompt caching now accessible through the kernel.** Operators stop bypassing the kernel to set `cache_control`.
- **Backwards compat fully preserved.** All existing tests pass without modification.
- **Cross-provider portable code.** Operators can set `cacheBreakpoint` on every relevant block; Anthropic honors it, others ignore.
- **Pattern set for future caching extensions.** When Anthropic adds `cache_control: {type: "persistent"}` or named-key caching, `LLM_CACHE_BREAKPOINT_TYPES` extends + translator handles the new type.
- **Token economics improvement.** Operators with long-context chat workloads (10k+ input tokens repeated across turns) see ~10x input-cost reduction on cache hits.

## Open questions

- **Q1:** Wire `cacheBreakpoint` through the Bedrock translator (insert `{cachePoint: {type: "default"}}` blocks)?
  - _Current direction:_ Follow-up milestone. Requires understanding Bedrock's documented behavior on cachePoint position + cache_key derivation.
- **Q2:** Expose `usage.cacheWriteTokens` more prominently when operators set `cacheBreakpoint`?
  - _Current direction:_ Already surfaced via M2.X.11-pre `normalizeUsage` (it returns `cachedInputTokens` when Anthropic reports cache hits). Operators inspect usage to verify cache effectiveness.
- **Q3:** Add a `cacheKeyHint` field for named-key caching when Anthropic ships it?
  - _Current direction:_ Add when Anthropic documents it. The single-value tuple makes extension easy.
- **Q4:** Should the kernel warn (not throw) when `cacheBreakpoint` is set on providers that don't honor it?
  - _Current direction:_ No — kernel surface stays silent. Operators check `usage.cachedInputTokens` to verify cache hits.
- **Q5:** Should chat REPL's `/attach` (M5.10.5) accept a `--cache` flag to set the breakpoint inline?
  - _Current direction:_ Defer. Operators with complex caching strategies use the kernel API directly; REPL stays focused on plain attachments.
- **Q6:** What about Anthropic's 4-breakpoint-per-request limit?
  - _Current direction:_ Surface as Anthropic 400 error (kernel doesn't enforce; provider validates).
- **Q7:** Should `LlmMessage.content` plain-string user inputs also support a top-level cache hint?
  - _Current direction:_ No. Operators wanting per-block caching use blocks; plain string is the simple path.
