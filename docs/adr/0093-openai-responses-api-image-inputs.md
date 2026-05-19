# ADR-0093: OpenAI Responses API image inputs (Phase 2 M2.8.6)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0088 (M2.X.5 content discriminated union), ADR-0062 (M2.8.5 OpenAI Responses API), ADR-0078 (M2.X attachments + vision) |

## Context

M2.8.5 shipped OpenAI's Responses API as an opt-in alternative to Chat Completions. M2.X.5 lifted `LlmMessage.content` to `string | LlmContentBlock[]`, threaded through Anthropic + OpenAI Chat Completions + Bedrock. The Responses API path was the one provider surface where image content was silently dropped: ADR-0088 Q6 noted that `responses-api.ts` used `contentToText(m.content)` throughout, so any `ImageContentBlock` in user messages became... nothing.

The Responses API natively supports image inputs via a `{type: "input_image", image_url: "..."}` content shape — a different field name from Chat Completions' `image_url` content part, but the same idea: a base64 data URL. M2.8.6 closes the gap so vision requests can use the Responses API.

## Decision

Three coordinated changes to `@crossengin/ai-providers-openai`.

### 1. New `OpenAIResponsesContentImageInput` type

```ts
export interface OpenAIResponsesContentImageInput {
  readonly type: "input_image";
  readonly image_url: string;
}
```

`OpenAIResponsesContentBlock` discriminated union grows from 2 to 3 variants: `input_text` + `input_image` (new) + `output_text`.

### 2. New `buildUserInputBlocks` helper

The pre-M2.8.6 user-message handler did:
```ts
items.push({
  role: "user",
  content: [{ type: "input_text", text: contentToText(m.content) }],
});
```

This collapsed everything to a single text block — string content + array content + attachments all flattened through `contentToText` which drops image blocks.

Post-M2.8.6, a dedicated helper walks each block:
```ts
function buildUserInputBlocks(
  content: LlmContent,
  attachments: LlmMessage["attachments"],
): readonly (OpenAIResponsesContentInput | OpenAIResponsesContentImageInput)[];
```

- `typeof content === "string"` → single `input_text` block (if non-empty).
- Array content: walk blocks. `text` → `input_text` (skip empty texts). `image` → `input_image` with data URL. `tool_use` / `tool_result` skipped (not legal on user input for Responses API; tool_use is assistant-only per kernel rules; tool_result becomes a `function_call_output` top-level item via the existing path).
- `attachments` field (legacy M2.X path) → append `input_image` blocks.
- Empty result → emit a single empty `input_text` (Responses API rejects empty content arrays).

### 3. Data URL format

Image URL format matches Chat Completions:
```
data:image/<format>;base64,<bytes>
```

`<format>` ∈ `{png, jpeg, gif, webp}` (from `ImageAttachmentFormat`). Same encoding for both API paths means operators with images can switch between Chat Completions and Responses API without changing the image preparation step.

### Backwards compat

- Pre-M2.X.5 string content still works → `[{type: "input_text", text}]`.
- Pre-M2.X.5 string content + M2.X attachments still works → text input_text + image input_image blocks.
- M2.X.5 array content with text-only blocks works → input_text blocks per text variant.
- All pre-M2.8.6 tests for the Responses API path pass unchanged (19 existing tests).

## Cross-cutting invariants enforced

- **Image inputs flow on the Responses API.** Verified by 7 new tests covering string content, array content, attachments, all 4 image formats, mixed text+image ordering, empty text filtering, empty content handling.
- **Block order preserved.** A user message with `[text, image, text, image]` emits content in the same order — verified by test.
- **Empty text blocks are filtered.** Operators shouldn't emit `{type: "input_text", text: ""}` between image blocks; the helper drops them.
- **Tool_use / tool_result content blocks on user role are not emitted as content** (tool_use is invalid on user; tool_result becomes a top-level `function_call_output` item via the existing path). Defense-in-depth at the kernel schema layer + filtered in the builder.
- **Data URL format matches Chat Completions exactly.** Operators preparing images for one API path use the same bytes/format for the other.
- **No changes to streaming.** Responses API streaming (`readResponsesSseStream`) parses output events; input shape changes don't affect the stream path.

## End-to-end semantic

```ts
const provider = new OpenAIProvider({
  apiKey: "sk-...",
  defaultApiPath: "responses",  // opt into M2.8.5 Responses API
});

// Pre-M2.8.6: image silently dropped on the Responses path
// Post-M2.8.6: image flows correctly
const chunks: CompletionChunk[] = [];
for await (const chunk of provider.complete({
  task: "executor",
  tenantId: "...",
  sessionId: "...",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "describe this image" },
        { type: "image", format: "png", bytes: pngBase64 },
      ],
    },
  ],
})) {
  chunks.push(chunk);
}
```

Operators switching between Chat Completions + Responses API (e.g., to use o1's reasoning features for vision tasks) get consistent behavior — both paths translate the same `LlmMessage` to their respective image-input shapes.

## Alternatives considered

- **Throw on image content blocks in the Responses path.**
  - **Considered.** Pre-M2.8.6 silently dropped them; throwing would force operators to know about the limitation.
  - **Cons.** Hostile API. The Responses API CAN handle image inputs; just need to use the right shape.
  - **Decision.** Translate them properly.

- **Add a `buildResponsesImageInput(format, bytes): OpenAIResponsesContentImageInput` factory helper.**
  - **Considered.** Reusable for operators constructing requests directly.
  - **Cons.** The translation is one line. Add a factory if external operators ask.
  - **Decision.** Inline. Helper not exported.

- **Support URL-based images (`image_url: "https://..."`) in addition to data URLs.**
  - **Considered.** Smaller payloads when images are already hosted somewhere.
  - **Cons.** The kernel `ImageContentBlock.bytes` is base64 bytes only. URL support requires a kernel-level extension — a new field on the block.
  - **Decision.** Out of scope. Future M2.X.5.y could add a `url` variant to `ImageContentBlock`.

- **Map image blocks to `output_text` placeholders ("[image]") when the model doesn't support vision.**
  - **Considered.** Graceful degradation for non-vision models.
  - **Cons.** Lossy + surprising. Operators choosing a non-vision model + sending images have an authoring error; failing loudly (via OpenAI's HTTP 400) is better.
  - **Decision.** Pass through; let OpenAI reject if model doesn't support vision.

- **Move the user-block-translation logic out of `splitMessages` and into a separate exported helper for symmetry with chat-api's `translateUserMessage`.**
  - **Considered.** Cleaner export surface.
  - **Cons.** The helper is private + internal. Exporting it would commit to its shape; not worth the API surface for one consumer.
  - **Decision.** Keep private.

- **Also handle assistant-side image content blocks** (an assistant message with image output → Responses API output).
  - **Considered.** Symmetry with M2.X.5's multimodal-output goal.
  - **Cons.** The Responses API input ITEM for assistant role uses the same `input_text` field — it's input-history, not output. The actual output shape (`output_text`) is for OUTPUT items, which the provider doesn't construct (the API does). Assistant input-history images would map to `input_image` blocks if needed, but no provider returns images as outputs in conversation-history input. Defer.
  - **Decision.** User-side only. Assistant + tool roles use text-only (via `contentToText`) since their content represents past turns, not new inputs.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,713 tests** (+7 from M2.8.6). All green, zero type errors.
- **ADR-0088 Q6 closed.** Image content blocks work on both OpenAI API paths.
- **OpenAI provider has full multimodal parity across Chat Completions + Responses.** Operators routing the same `LlmMessage` to either path get consistent behavior.
- **Empty-content-array protection added.** Pre-M2.8.6 a fully-empty user message would have produced `content: []` (Responses API would reject); now produces `content: [{type: "input_text", text: ""}]`.
- **`OpenAIResponsesContentBlock` union grew by one variant.** Downstream code that exhaustively switches on the discriminator should compile-error and force handling.
- **Pattern for future Responses-API extensions.** When OpenAI adds audio / document inputs, the same shape applies: new content variant + builder switch case.

## Open questions

- **Q1:** Should the Responses API path support URL-based images (`image_url: "https://..."`) instead of data URLs?
  - _Current direction:_ Requires a kernel-level change to `ImageContentBlock` (add `url` variant). Deferred to M2.X.5.y.
- **Q2:** Should the streaming path emit a `content_image_added` event analog?
  - _Current direction:_ Out of scope. The provider's `CompletionChunk` union doesn't carry image output today; the Responses API also doesn't emit image outputs in chat-style responses (image-generation is a separate `/v1/images/generations` endpoint).
- **Q3:** Auto-detect when the model doesn't support vision and refuse before sending?
  - _Current direction:_ Out of scope. The `ProviderCapabilities.vision` flag is the operator's surface; let OpenAI reject if the chosen model doesn't support it.
- **Q4:** Image input fidelity — should `detail: "low" | "high" | "auto"` be threaded through (OpenAI lets callers specify image-processing detail level)?
  - _Current direction:_ Out of scope. The kernel `ImageContentBlock` doesn't have a detail field; adding it would be a kernel-level extension.
- **Q5:** Multiple image batching (Responses API limit)?
  - _Current direction:_ OpenAI documents per-message limits (typically 10 images). Operators exceeding the limit get an HTTP 400; no client-side enforcement.
- **Q6:** Should `responses-streaming.ts` parse image content events from streaming responses?
  - _Current direction:_ The Responses API doesn't emit image-content events in chat completions (output is text-only via the `response.output_text.delta` event). If image-output streaming ever ships, that's a new milestone.
- **Q7:** Cost accounting for image inputs (vision tokens)?
  - _Current direction:_ OpenAI charges vision tokens via the normal `input_tokens` count in `usage`. The existing cost-accounting path captures it correctly without changes.
