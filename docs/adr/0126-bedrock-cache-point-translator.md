# ADR-0126: Bedrock cachePoint translator for cacheBreakpoint (Phase 2 M2.X.11.x)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0125 (M2.X.11 cacheBreakpoint LlmContentBlock field), ADR-0071 (M2.9 Bedrock provider) |

## Context

M2.X.11 (ADR-0125) added a kernel `cacheBreakpoint?: LlmCacheBreakpoint` field on every `LlmContentBlock` variant. The Anthropic translator wires it to `cache_control: {type: "ephemeral"}` (inline on the same block). OpenAI silently drops (no per-block knob in their API). Bedrock was deferred: "future M2.X.11.x can extend the Bedrock translator to either insert `cachePoint` blocks or throw."

M2.X.11.x ships the Bedrock wiring. AWS Bedrock's Converse API exposes prompt caching via a SEPARATE block type:

```json
{
  "messages": [{
    "role": "user",
    "content": [
      {"text": "long context"},
      {"cachePoint": {"type": "default"}},
      {"text": "fresh question"}
    ]
  }]
}
```

Unlike Anthropic's inline `cache_control` field, Bedrock requires inserting a discrete `{cachePoint: {type: "default"}}` block AFTER each block that should mark a cache boundary. The supporting infrastructure (`BedrockCachePointBlock` type, `BEDROCK_CACHE_POINT` constant, `isCachePointBlock` discriminator) was already in place from M2.9 — only the translator wiring was missing.

## Decision

A single-line wiring change in `appendKernelBlocks` (the Bedrock translator's content-block emission loop).

### `appendKernelBlocks` augmentation

```ts
function appendKernelBlocks(
  out: BedrockContentBlock[],
  content: LlmContent,
): void {
  if (typeof content === "string") {
    if (content.length > 0) out.push({ text: content });
    return;
  }
  for (const b of content) {
    out.push(translateKernelBlock(b));
    if (b.cacheBreakpoint !== undefined) {
      out.push(BEDROCK_CACHE_POINT);
    }
  }
}
```

After emitting each translated block, if the kernel block carries `cacheBreakpoint`, append the shared `BEDROCK_CACHE_POINT` constant. AWS treats the cache_control type as `"default"` (only documented value) — the kernel's `cacheBreakpoint.type` is currently `"ephemeral"` (matching Anthropic vocabulary); the translator maps both to Bedrock's `"default"`.

### Vocabulary asymmetry

| Layer | Type value |
|---|---|
| Kernel `LlmCacheBreakpoint.type` | `ephemeral` |
| Anthropic wire `cache_control.type` | `ephemeral` |
| Bedrock wire `cachePoint.type` | `default` |

The kernel uses Anthropic's term because Anthropic was the first provider integration. Bedrock's `default` is the only currently-documented value. Translator maps kernel → provider wire vocabulary.

### tool-role messages

The kernel allows `role: "tool"` messages with block content. The existing Bedrock translator converts tool messages to a single `toolResult` block via `contentToText` — flattening any block array into a string. M2.X.11.x does NOT special-case the tool-role path (caching on tool-result content is deferred). Operators wanting to cache an expensive tool result on Bedrock use an `assistant`-role message with a `tool_use` block (which IS wired in this milestone).

## Cross-cutting invariants enforced

- **Cross-provider parity at the kernel layer.** Operators set `cacheBreakpoint` once; Anthropic emits inline `cache_control`, Bedrock inserts a `cachePoint` block, OpenAI drops. Same operator code targets all three.
- **No new transport.** Pure translator change.
- **No new types.** Reuses M2.9's `BedrockCachePointBlock` + `BEDROCK_CACHE_POINT` constant + `isCachePointBlock` discriminator.
- **Backwards compat preserved.** All pre-M2.X.11.x tests pass without modification. Translator behavior is byte-identical for blocks WITHOUT `cacheBreakpoint`.
- **Unsupported-block kernel blocks still throw.** Setting `cacheBreakpoint` on an `image_url` block still throws (image_url is Bedrock-unsupported per M2.X.5.y). The cachePoint insertion only runs AFTER translateKernelBlock succeeds.

## End-to-end semantic

```ts
import type { CompletionRequest } from "@crossengin/ai-providers";

// Same kernel code targeting Anthropic + Bedrock.
const req: CompletionRequest = {
  task: "executor",
  messages: [{
    role: "user",
    content: [
      {
        type: "document",
        format: "pdf",
        bytes: pdfBase64,
        cacheBreakpoint: { type: "ephemeral" },  // mark cache breakpoint
      },
      { type: "text", text: "What's our vacation policy?" },
    ],
  }],
  tenantId, sessionId,
};

// Anthropic translator emits:
// {type: "document", source: {...}, cache_control: {type: "ephemeral"}}
// {type: "text", text: "..."}
await anthropic.complete(req);

// Bedrock translator emits:
// {document: {...}}
// {cachePoint: {type: "default"}}
// {text: "..."}
await bedrock.complete(req);

// OpenAI translator: cacheBreakpoint dropped (no equivalent in OpenAI API).
await openai.complete(req);
```

## Alternatives considered

- **Throw on Bedrock when `cacheBreakpoint` is set.**
  - **Considered.** Surfaces caching unsupported for operators.
  - **Cons.** Cross-provider portable code becomes a minefield. Anthropic ALREADY accepts it; rejecting at Bedrock makes the field provider-specific.
  - **Decision.** Wire it correctly.

- **Insert `cachePoint` BEFORE the kernel block (cache key = blocks UP TO that point).**
  - **Considered.** Matches some interpretations of "breakpoint."
  - **Cons.** AWS docs explicitly state `cachePoint` marks the end of a cacheable prefix — content BEFORE the cachePoint block is what gets cached. Operator setting `cacheBreakpoint` on block N expects blocks 0..N (inclusive) to be cached. Insert-after matches.
  - **Decision.** Insert AFTER. Matches Anthropic semantic.

- **Auto-detect duplicate cacheBreakpoints + collapse.**
  - **Considered.** Operators marking every block as cached would emit one cachePoint per block.
  - **Cons.** Bedrock enforces a per-request limit (typically 4 cachePoints); operators violating it get a 400. Collapsing would hide their over-marking.
  - **Decision.** No auto-collapse. Surface AWS's limit.

- **Skip `cachePoint` insertion when the previous block was already a cachePoint.**
  - **Considered.** Defensive against same-block-twice errors.
  - **Cons.** Operators don't add cacheBreakpoint twice; if they did, AWS surfaces 400.
  - **Decision.** Strict 1:1 mapping. Operators control their cache strategy.

- **Map `LlmCacheBreakpoint.type` to Bedrock's `cachePoint.type` field.**
  - **Considered.** Future-proof if Bedrock adds non-default cachePoint types.
  - **Cons.** Currently only `"default"` is documented. Hardcoding it for now is simpler; when AWS ships new types, ADR can extend.
  - **Decision.** Hardcoded `"default"` via the shared `BEDROCK_CACHE_POINT` constant.

- **Wire `cacheBreakpoint` on tool-role messages too.**
  - **Considered.** Operators wanting to cache expensive tool results.
  - **Cons.** Bedrock's tool-role path flattens content via `contentToText`. Restructuring to preserve block array on tool messages would touch the M2.9 translator's tool-message handling.
  - **Decision.** Defer. Operators with cacheable tool results use assistant-role with `tool_use` block (which IS wired).

## Consequences

- **55 packages + 1 app, 120 meta-schema tables, 7,407 tests** (+8 from M2.X.11.x: all in `converse-api.test.ts`). All green, zero type errors.
- **Cross-provider cacheBreakpoint parity now achieved on Anthropic + Bedrock.** OpenAI continues to silently drop (no per-block knob in their API).
- **All four prior M2.X.5.* multimodal block variants benefit.** Image / document / file_id / tool_use blocks all support `cacheBreakpoint` end-to-end on Bedrock now.
- **No new code surface to operators.** The kernel API didn't change; this is a pure translator-side update.
- **Pattern set for future Bedrock-specific block annotations.** When AWS adds new block-level annotations (guardrail-scoped caching, region-pinning hints, etc.), the same translator-level insertion pattern applies.
- **The M2.9 infrastructure earns its keep.** `BedrockCachePointBlock` + `BEDROCK_CACHE_POINT` + `isCachePointBlock` were pre-built in M2.9; this milestone is the call site that finally uses them.

## Open questions

- **Q1:** Wire `cacheBreakpoint` on tool-role messages (preserve block array instead of flattening)?
  - _Current direction:_ Defer. Restructuring tool-message handling is its own milestone.
- **Q2:** Surface AWS's per-request cachePoint limit (typically 4) as a translator-side warning?
  - _Current direction:_ No. AWS surfaces 400 with a clear error. Kernel doesn't enforce.
- **Q3:** Should `cacheBreakpoint` also affect the Bedrock `system` block array?
  - _Current direction:_ Defer. Current kernel surface treats system prompt as plain string; widening would touch the M2.9 system-block path.
- **Q4:** Future Bedrock cachePoint types beyond `"default"`?
  - _Current direction:_ Watch AWS docs. The shared `BEDROCK_CACHE_POINT` constant can be replaced by a mapping function if needed.
- **Q5:** Should the translator dedupe consecutive `cachePoint` blocks (e.g., when an operator inadvertently marks every block)?
  - _Current direction:_ No. AWS validates; operators get clear feedback.
- **Q6:** Cross-region inference profile caching — does it work the same?
  - _Current direction:_ Per AWS docs, yes — inference profiles route to regional models that share the same cache_control semantic.
