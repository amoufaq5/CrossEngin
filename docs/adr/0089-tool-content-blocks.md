# ADR-0089: tool_use + tool_result content block variants (Phase 2 M2.X.5.x)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0088 (M2.X.5 content discriminated union), ADR-0055 (M5.6 tool-driven chat), ADR-0078 (M2.X attachments) |

## Context

M2.X.5 lifted `LlmMessage.content` to a discriminated union supporting `text` + `image` blocks across all three real providers. That closed the multimodal asymmetry but left the tool-call surface split across multiple fields:

- **`LlmMessage.toolUses: ToolUse[]`** — assistant messages declare tool calls via a separate top-level field.
- **`LlmMessage.role: "tool"` + `toolCallId` + `content: string`** — tool results come back as a whole message dedicated to one result.

This works for the simple case (one tool call per assistant message, one result per tool message) but doesn't compose well:

- An assistant message that mixes text + multiple tool calls + more text can't be expressed naturally (the order of text and tool_uses is lost; toolUses is a flat array).
- A user message that bundles multiple tool results (e.g. one assistant turn invoked 3 tools in parallel) requires 3 separate tool-role messages, breaking the kernel's "one message per turn" intuition.
- Providers' native shapes (Anthropic `tool_use`/`tool_result` content blocks, Bedrock `toolUse`/`toolResult` content blocks) already model these inline. The kernel's separate-field structure forces the translators to denormalize.

M2.X.5.x adds `tool_use` and `tool_result` as content block variants in the discriminated union. Existing field-based code keeps working; new code can express tool calls + results inline.

The design constraints:

- **Both fields and content blocks must work simultaneously.** Operators using the M5.6 `toolUses` field shouldn't break. Operators using `role: "tool"` messages shouldn't break.
- **Role-bound semantics.** `tool_use` only on assistant. `tool_result` only on user or tool. Validated at parse time.
- **OpenAI's wire shape needs message-flattening.** OpenAI emits tool_calls on the assistant message envelope (not in content) and tool results as separate tool-role messages. One kernel `LlmMessage` with a `tool_result` block becomes multiple OpenAI messages.

## Decision

Eight coordinated changes.

### 1. Two new content block schemas

```ts
export const ToolUseContentBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
});

export const TOOL_RESULT_STATUSES = ["success", "error"] as const;
export const ToolResultStatusSchema = z.enum(TOOL_RESULT_STATUSES);

export const ToolResultContentBlockSchema = z.object({
  type: z.literal("tool_result"),
  toolUseId: z.string().min(1),
  content: z.string(),
  status: ToolResultStatusSchema.optional(),
});
```

The `id` / `name` fields are required + non-empty. `input` accepts `unknown` (provider-specific shapes). `content` on tool_result is a string (matches the existing tool-role message shape; recursive content not supported in this milestone — operators wanting structured output use JSON). `status` is optional `success | error` — Bedrock supports it natively; Anthropic doesn't emit it back but accepts it.

### 2. Discriminated union extension

```ts
export const LlmContentBlockSchema = z.discriminatedUnion("type", [
  TextContentBlockSchema,
  ImageContentBlockSchema,
  ToolUseContentBlockSchema,        // new
  ToolResultContentBlockSchema,     // new
]);
```

Four variants today: `text`, `image`, `tool_use`, `tool_result`.

### 3. Role-validation in `superRefine`

```ts
if (Array.isArray(m.content)) {
  for (let i = 0; i < m.content.length; i++) {
    const b = m.content[i]!;
    if (b.type === "tool_use" && m.role !== "assistant") {
      ctx.addIssue({ path: ["content", i], message: "tool_use only on assistant" });
    }
    if (b.type === "tool_result" && m.role !== "user" && m.role !== "tool") {
      ctx.addIssue({ path: ["content", i], message: "tool_result only on user or tool" });
    }
    if (b.type === "image" && m.role === "tool") {
      ctx.addIssue({ path: ["content", i], message: "image not allowed on tool" });
    }
  }
}
```

`tool_use` on user / system / tool → reject. `tool_result` on assistant / system → reject. `image` on tool → reject (tool messages are text-only by convention).

### 4. Bedrock translator (`translateKernelBlock`)

Bedrock has native `toolUse` + `toolResult` content blocks. The block-translation switch grows from 2 cases (text, image) to 4:

```ts
function translateKernelBlock(block: LlmContentBlock): BedrockContentBlock {
  if (block.type === "text") return { text: block.text };
  if (block.type === "image") return { image: { format: block.format, source: { bytes: block.bytes } } };
  if (block.type === "tool_use") return { toolUse: { toolUseId: block.id, name: block.name, input: block.input ?? {} } };
  return { toolResult: { toolUseId: block.toolUseId, content: [{ text: block.content }], ...(block.status !== undefined ? { status: block.status } : {}) } };
}
```

One kernel message → one Bedrock message (no flattening needed).

### 5. Anthropic translator (`translateKernelBlock`)

Anthropic has native `tool_use` + `tool_result` content blocks (same names as kernel). Translation is mostly verbatim:

```ts
function translateKernelBlock(block: LlmContentBlock): AnthropicContentBlock {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "image") return { type: "image", source: { type: "base64", media_type: `image/${block.format}`, data: block.bytes } };
  if (block.type === "tool_use") return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  return { type: "tool_result", tool_use_id: block.toolUseId, content: block.content };
}
```

One kernel message → one Anthropic message.

### 6. OpenAI translator (flatMap refactor)

OpenAI's chat-completions wire format doesn't allow tool_use or tool_result blocks inside the content array:

- **tool_use** → must be hoisted to the assistant message's `tool_calls` envelope field.
- **tool_result** → must become a separate `tool`-role message; can't be inline.

`translateMessage` signature changed from `LlmMessage → OpenAIChatMessage` to `LlmMessage → OpenAIChatMessage[]`. `buildOpenAIChatRequest` switched from `.map` to `.flatMap`.

The new `translateUserMessage` walks the user's content blocks:
- `tool_result` blocks → emit a tool-role OpenAI message (with `tool_call_id`)
- everything else → accumulate into user-role parts
- Order preserved: tool-role messages first (they "answer" the preceding assistant), then user-role message with the remaining text + images

The new `translateAssistantMessage`:
- `tool_use` blocks inline → merge with `m.toolUses` field; both populate `tool_calls` envelope
- `tool_result` blocks (parse-time invalid; defense in depth) → silently filtered
- Remaining text/image blocks → become the assistant's `content` (string when there's only one text part; null when only tool_calls; array of content parts otherwise)

### 7. Bidirectional field compat

The existing `LlmMessage.toolUses` field + `role: "tool"` messages continue to work unchanged. Operators can mix:

- Old style: `{role: "assistant", content: "Let me search", toolUses: [{id, name, input}]}` + `{role: "tool", toolCallId, content: "..."}`
- New style: `{role: "assistant", content: [{type: "text", text: "Let me search"}, {type: "tool_use", id, name, input}]}` + `{role: "user", content: [{type: "tool_result", toolUseId, content: "..."}]}`
- Hybrid: `{role: "assistant", toolUses: [{id: "tu_a"}], content: [{type: "tool_use", id: "tu_b"}]}` — both merged into `tool_calls`

The OpenAI test "tool_use inline content blocks merge with toolUses field for tool_calls" verifies the hybrid case.

### 8. ToolUseContentBlock + ToolResultContentBlock + ToolResultStatus exports

All new types public from `@crossengin/ai-providers`.

## Cross-cutting invariants enforced

- **`tool_use` content blocks are assistant-only.** Verified by test.
- **`tool_result` content blocks are user/tool-only.** Verified by test.
- **`image` content blocks are not allowed on tool messages.** Verified by test.
- **Empty `id` / `name` / `toolUseId` rejected.** Verified by test.
- **Status enum restricted to `success | error`.** Verified by test.
- **Existing field-based code unchanged.** All pre-M2.X.5.x tests pass at 6,621.
- **OpenAI translator preserves tool-call ordering.** Tool-role messages immediately follow the assistant message they answer to; verified by test.
- **OpenAI hybrid: `toolUses` field + inline `tool_use` blocks merge into one `tool_calls` array.** Verified by test.

## End-to-end semantics

```ts
// Pre-M2.X.5.x style (still works):
const assistantOld: LlmMessage = {
  role: "assistant",
  content: "Let me search",
  toolUses: [{ id: "tu_1", name: "search", input: { q: "x" } }],
};
const toolResultOld: LlmMessage = {
  role: "tool",
  toolCallId: "tu_1",
  content: "result here",
};

// M2.X.5.x canonical inline style:
const assistantNew: LlmMessage = {
  role: "assistant",
  content: [
    { type: "text", text: "Let me search" },
    { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } },
  ],
};
const toolResultNew: LlmMessage = {
  role: "user",
  content: [
    { type: "tool_result", toolUseId: "tu_1", content: "result here" },
  ],
};

// Parallel tools in one assistant turn:
const parallel: LlmMessage = {
  role: "assistant",
  content: [
    { type: "tool_use", id: "tu_a", name: "search", input: { q: "x" } },
    { type: "tool_use", id: "tu_b", name: "fetch", input: { url: "y" } },
  ],
};
// → All three providers emit both tool calls correctly.

// Bundled tool results in one user turn:
const bundled: LlmMessage = {
  role: "user",
  content: [
    { type: "tool_result", toolUseId: "tu_a", content: "search result" },
    { type: "tool_result", toolUseId: "tu_b", content: "fetch result" },
    { type: "text", text: "now do something with both" },
  ],
};
// → Bedrock + Anthropic: one message with 3 blocks
// → OpenAI: 3 messages (2 tool-role + 1 user-role)
```

## Alternatives considered

- **Deprecate `LlmMessage.toolUses` field in favor of content blocks.**
  - **Considered.** Cleaner single-path model.
  - **Cons.** Breaks M5.6 chat substrate + tool-driven test suites that rely on the field. Migration would be noisy.
  - **Decision.** Keep both. Field is the legacy path; content blocks are the canonical path going forward.

- **Recursive `content: LlmContent` on tool_result (not just string).**
  - **Considered.** Tool results sometimes carry structured data (images, nested results).
  - **Cons.** Recursive content makes schema parsing + provider translation significantly more complex. The provider native shapes mostly take strings or array-of-text. Operators wanting structured output JSON-encode the result.
  - **Decision.** String content. Future M2.X.5.y could lift to recursive if a concrete provider supports it.

- **Make `tool_use` allowed on user messages too (for "synthetic" tool calls from user input).**
  - **Considered.** Some agentic patterns synthesize tool calls in the user turn.
  - **Cons.** No real provider accepts user-emitted tool_use. The synthetic pattern is better expressed as an assistant message in a fake-history shape.
  - **Decision.** Assistant-only.

- **Combine `toolUses` field + inline `tool_use` blocks into ONE source (require operators to choose).**
  - **Considered.** Single source of truth.
  - **Cons.** Backwards-compat hit. M5.6 chat substrate uses field; new code might use blocks; mixing is reasonable during migration.
  - **Decision.** Both work; OpenAI merges; Bedrock + Anthropic respect the source (field for legacy code, content for new code).

- **Status field as discriminator (`{type: "tool_result_success", ...}` vs `{type: "tool_result_error", ...}`).**
  - **Considered.** Cleaner type-level discrimination.
  - **Cons.** Tools that return BOTH (partial success + recoverable error) would be ambiguous. Anthropic / OpenAI / Bedrock all use a single block type with an optional status field.
  - **Decision.** Single `tool_result` type with optional `status`.

- **Auto-translate field-based `toolUses` → inline `tool_use` blocks at parse time.**
  - **Considered.** Eliminates the dual-path internal complexity.
  - **Cons.** Surprising — operators looking at parsed messages would see their `toolUses` field gone, replaced with content blocks. Lossy round-trip.
  - **Decision.** Preserve both fields; provider translators handle the merge.

- **OpenAI: error instead of message-flatten when tool_result blocks appear.**
  - **Considered.** Operators have to use `role: "tool"` messages for OpenAI.
  - **Cons.** Asymmetric experience — kernel users would have to know which provider they're targeting. Message-flattening is mechanical and preserves the abstraction.
  - **Decision.** Flatten. Tool-role messages emitted in the correct position.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,639 tests** (+18 from M2.X.5.x: 12 kernel + 2 Bedrock + 2 Anthropic + 4 OpenAI). All green, zero type errors.
- **Tool calls + results expressible inline.** Parallel tools, mixed text + tool sequences, bundled results — all become natural content-block constructions.
- **Provider translator parity.** Bedrock + Anthropic accept the new blocks natively (no special handling). OpenAI's message-flattening is mechanical + tested.
- **`LlmMessage.toolUses` field is now redundant in the new model.** Future M2.X.5.y could deprecate it once the chat substrate migrates; for now, both paths coexist.
- **OpenAI translator architecture changed.** `translateMessage` returns an array; `buildOpenAIChatRequest` uses `flatMap`. This is the foundation for future per-LlmMessage-to-multi-OpenAI-message expansions (e.g. structured content split).
- **Pattern set for future block variants.** Adding `audio` / `video` / `tool_call_id` / `reasoning` content blocks slots in cleanly via the discriminated union + per-provider translator switch.

## Open questions

- **Q1:** Should `LlmMessage.toolUses` field + `role: "tool"` messages be formally deprecated?
  - _Current direction:_ Not yet. Mark as legacy in docs; coordinate deprecation with M5.x chat substrate migration.
- **Q2:** Recursive `content` on tool_result (so a tool can return an image or structured text + image)?
  - _Current direction:_ Out of scope. String content is the lowest common denominator. Future M2.X.5.y.
- **Q3:** Should `tool_result.status: "error"` propagate to the provider with stronger semantics (e.g. Anthropic's `is_error` field)?
  - _Current direction:_ Bedrock has `status`; Anthropic + OpenAI don't have a direct field. For now, status is passed where supported and dropped otherwise. Future provider-specific shaping could improve fidelity.
- **Q4:** A standalone helper `partitionContentByType(content): {text, images, toolUses, toolResults}` for downstream walkers?
  - _Current direction:_ Out of scope. Operators implement their own walker as needed.
- **Q5:** Streaming: can `tool_use` content blocks stream alongside text deltas in `CompletionChunk`?
  - _Current direction:_ Out of scope. The `CompletionChunk` discriminated union already handles tool_call_start / tool_call_arg_delta / tool_call_end. Streaming content blocks beyond that requires a future M2.X.5.y.
- **Q6:** OpenAI message-flattening: what if multiple kernel user messages each carry tool_results in non-adjacent positions?
  - _Current direction:_ Tested + works — each kernel user message expands independently, preserving relative order. Tool-role messages stay attached to their kernel message's position.
- **Q7:** What about `cache_control` on tool_result blocks (for prompt caching)?
  - _Current direction:_ Out of scope. The kernel `cacheControl` field handles cache breakpoints at the request level; per-block caching is provider-specific.
