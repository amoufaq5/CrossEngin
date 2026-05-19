# ADR-0088: Kernel LlmMessage.content as discriminated union (Phase 2 M2.X.5)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0078 (M2.X attachments + vision), ADR-0053 (M2.7 Anthropic), ADR-0060 (M2.8 OpenAI), ADR-0071 (M2.9 Bedrock) |

## Context

M2.X added a user-side multimodal surface via `LlmMessage.attachments: MessageAttachment[]` — the kernel can accept user images alongside text in a single message. But the asymmetry was real:

- **User side** (input to the model): `attachments` field carries images. All three providers translate to their native image content block format.
- **Assistant side** (output from the model): `content: string` only. The model can return text but nothing else — image-generation models, structured-content responses, and any future multimodal output had no kernel representation.

The provider-side content block types (`AnthropicContentBlock`, `OpenAIContentPart`, `BedrockImageContentBlock`) already supported richer shapes. The kernel was the bottleneck.

M2.X.5 closes the asymmetry by lifting `content` to a discriminated union: `string | LlmContentBlock[]`. Either form is valid; existing callers passing strings continue to work; new callers can construct structured arrays for multimodal scenarios.

The design constraints:

- **Backwards compat is non-negotiable.** 90+ existing call sites pass `content: "..."`. None should need to change.
- **No new kernel error types.** This is a schema extension, not a behavior change.
- **All three providers should accept array content uniformly.** Operators shouldn't need to know which provider supports what.
- **`attachments` and array content are mutually exclusive.** Either use the M2.X attachments field (for legacy user-image scenarios) OR use array content blocks (the canonical M2.X.5 form). Not both.

## Decision

Six coordinated changes.

### 1. New `LlmContentBlock` discriminated union in `@crossengin/ai-providers`

```ts
export const TextContentBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});
export type TextContentBlock = z.infer<typeof TextContentBlockSchema>;

export const ImageContentBlockSchema = z.object({
  type: z.literal("image"),
  format: ImageAttachmentFormatSchema,   // reuse the M2.X format enum
  bytes: z.string().min(1),
});
export type ImageContentBlock = z.infer<typeof ImageContentBlockSchema>;

export const LlmContentBlockSchema = z.discriminatedUnion("type", [
  TextContentBlockSchema,
  ImageContentBlockSchema,
]);
export type LlmContentBlock = z.infer<typeof LlmContentBlockSchema>;
```

Text + image variants today. Future tool-result / audio / video / document variants slot in cleanly via the discriminator pattern. Empty text is allowed in text blocks (the type accepts `""`); empty bytes are rejected in image blocks (`.min(1)`).

### 2. `LlmContent` union + schema update

```ts
export const LlmContentSchema = z.union([
  z.string(),
  z.array(LlmContentBlockSchema).min(1),
]);
export type LlmContent = z.infer<typeof LlmContentSchema>;

export const LlmMessageSchema = z.object({
  role: z.enum([...]),
  content: LlmContentSchema,  // was: z.string()
  // ... rest unchanged
});
```

Empty arrays are REJECTED (`.min(1)`). Empty strings remain valid (a message with no text content). The discriminated union enforces shape at parse time; downstream code does `typeof content === "string" ? ... : ...` to switch on the variant.

### 3. New validation: array content + attachments mutually exclusive

The existing `superRefine` already enforced "attachments only on user messages." M2.X.5 adds:

```ts
if (
  Array.isArray(m.content) &&
  m.attachments !== undefined &&
  m.attachments.length > 0
) {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["attachments"],
    message: "attachments and array content blocks are mutually exclusive — use content blocks for new code",
  });
}
```

String content + attachments is still valid (M2.X backwards compat). Array content + no attachments is the canonical M2.X.5 form. Both together is an authoring error.

### 4. Helpers for downstream consumers

```ts
export function isStringContent(content: LlmContent): content is string;
export function isBlockContent(content: LlmContent): content is LlmContentBlock[];
export function normalizeContent(content: LlmContent): readonly LlmContentBlock[];
export function contentToText(content: LlmContent): string;
```

- `normalizeContent`: wraps a string in `[{type: "text", text}]`; passes arrays through. Useful when downstream code wants uniform array handling.
- `contentToText`: extracts plain text — returns string content unchanged, joins text blocks from arrays, ignores image blocks. Useful for tool-result content, telemetry, log lines.

### 5. Provider translators thread both shapes

All three provider message-builders gained a private `appendKernelBlocks(out, content)` helper that branches on `typeof content`:

- **Bedrock** (`converse-api.ts`): `appendKernelBlocks` pushes `{text}` for text blocks, `{image: {format, source: {bytes}}}` for image blocks. The user / assistant / system branches all use it. Tool messages use `contentToText` (Bedrock tool results take string text).
- **Anthropic** (`messages-api.ts`): pushes `{type: "text", text}` or `{type: "image", source: {type: "base64", media_type: "image/<format>", data: bytes}}`. Same shape as M2.X but now reachable from kernel array content, not just from the `attachments` field.
- **OpenAI** (`chat-api.ts`): pushes `{type: "text", text}` or `{type: "image_url", image_url: {url: "data:image/<format>;base64,<bytes>"}}` content parts. Assistant messages with array content emit OpenAI content parts instead of a string.

The OpenAI Responses API (`responses-api.ts`) uses `contentToText` throughout — its top-level shape doesn't support inline image parts the same way, so image content is silently dropped (consistent with M2.X.6's lossy text-only behavior on the Responses path).

### 6. Backwards compat preserved across all three providers

Existing tests with string content (90+ sites) pass unchanged. The provider message-builders detect `typeof m.content === "string"` and emit the same wire format as M2.X. Verified by test in each provider:

- Bedrock: "string content for assistant continues to work (backwards compat with M2.X)"
- Anthropic: "string content for assistant continues to map to plain string (backwards compat)"
- OpenAI: "string content for assistant continues to map to plain string (backwards compat)"

## Cross-cutting invariants enforced

- **`LlmMessage.content` is a discriminated union at parse time.** Zod rejects malformed shapes.
- **Empty arrays are invalid.** A message with no content blocks fails parse.
- **Image blocks work on any role.** Pre-M2.X.5 the only image path was `attachments` (user-only); M2.X.5's content blocks have no role restriction. Assistant CAN emit images now.
- **`attachments` is mutually exclusive with array content.** Authoring error caught at parse time.
- **String + `attachments` still valid.** M2.X-shaped user messages continue to parse + translate.
- **All three providers handle both shapes uniformly.** Verified by test for each.
- **Zero wire-format changes for string-only callers.** Verified by existing 6,500+ tests passing unchanged.

## End-to-end semantics

```ts
// Pre-M2.X.5 (still works):
const msg1: LlmMessage = { role: "assistant", content: "hello" };

// Pre-M2.X.5 user with image (still works via attachments):
const msg2: LlmMessage = {
  role: "user",
  content: "what's this?",
  attachments: [{ kind: "image", format: "png", bytes: "..." }],
};

// M2.X.5 canonical: structured array content
const msg3: LlmMessage = {
  role: "user",
  content: [
    { type: "text", text: "what's this?" },
    { type: "image", format: "png", bytes: "..." },
  ],
};

// M2.X.5 unblocks: assistant emits an image (e.g. from an image-generation model)
const msg4: LlmMessage = {
  role: "assistant",
  content: [
    { type: "text", text: "Here is the generated image:" },
    { type: "image", format: "png", bytes: "..." },
  ],
};
```

All four parse successfully under `LlmMessageSchema`. All four translate correctly to Anthropic / OpenAI / Bedrock wire formats.

## Alternatives considered

- **Make content always an array.**
  - **Considered.** Cleaner type — no union, no `typeof` branching.
  - **Cons.** Breaks ~90 existing call sites. Migration would be mechanical but noisy.
  - **Decision.** Union for backwards compat. `normalizeContent` lets downstream code work uniformly if it wants.

- **Drop the `attachments` field entirely; require array content for images.**
  - **Considered.** Eliminates the mutual-exclusivity edge case.
  - **Cons.** Same backwards-compat hit as above. Plus the chat substrate + tests rely on `attachments`.
  - **Decision.** Keep `attachments` for backwards compat; document that new code should prefer content blocks.

- **Use a tagged-union shape like `content: {text: string} | {blocks: LlmContentBlock[]}`.**
  - **Considered.** Explicit tag at the content layer.
  - **Cons.** Adds nesting for the common case (just text). The `string | array` union is direct + JavaScript-idiomatic.
  - **Decision.** Direct union.

- **Add `audio` / `video` / `document` / `tool_result` / `tool_use` content block variants now.**
  - **Considered.** Future-proof.
  - **Cons.** No real provider supports `audio` / `video` / `document` content blocks yet through the chat path. Adding them speculatively means defining types that have no consumer. `tool_use` / `tool_result` already exist on `LlmMessage` as separate fields (`toolUses`, `toolCallId` + content).
  - **Decision.** Text + image only today. Future M2.X.5.x ships additional variants when providers actually support them.

- **Provider-side type union including their native blocks** (`type AnthropicContentInput = string | LlmContentBlock[] | AnthropicContentBlock[]`).
  - **Considered.** Let callers pass provider-native blocks for fidelity.
  - **Cons.** Defeats the kernel abstraction. Operators routing across providers can't construct one block format that works everywhere.
  - **Decision.** Kernel blocks are the public contract. Each provider translates internally.

- **Lazy validation: don't enforce `.min(1)` on arrays.**
  - **Considered.** Lets callers send empty-block messages.
  - **Cons.** An empty content message is a bug; rejecting at parse time is correct fail-fast behavior.
  - **Decision.** `.min(1)`.

- **Move `attachments` validation to require non-null array if present.**
  - **Considered.** Tidy the field's shape.
  - **Cons.** Out of scope. M2.X.5 is about lifting content; the attachments field is preserved as-is.
  - **Decision.** Leave attachments unchanged.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,621 tests** (+33 from M2.X.5: 24 kernel + 3 Bedrock + 3 Anthropic + 3 OpenAI). All green, zero type errors.
- **Multimodal assistant outputs unblocked.** Image-generation models, structured-response APIs, and future multimodal surfaces have a kernel representation.
- **`contentToText` + `normalizeContent` + discriminator helpers are reusable.** The chat substrate, telemetry layer, and downstream tooling get a uniform way to handle either shape.
- **Provider translators are slightly larger but cleaner.** The `appendKernelBlocks` helper per provider centralizes the kernel-block-to-native-block translation; the user/assistant branches just call it.
- **Backwards compat is rock-solid.** All 90+ existing string-content call sites pass without modification. Verified by the full pre-M2.X.5 test suite continuing to pass at 6,588.
- **Pattern set for future content variants.** Adding `audio` / `video` / `document` content blocks means appending to the discriminated union and updating each provider's translator — same shape as M2.X.5.

## Open questions

- **Q1:** Should the chat substrate prefer constructing array content over string + attachments?
  - _Current direction:_ The CLI's chat engine currently builds string content. Updating it to emit blocks is a future M5.x task — operators wanting blocks construct the message themselves.
- **Q2:** Should `MessageAttachment` be deprecated in favor of content blocks?
  - _Current direction:_ Not yet. The field still works; deprecation would require coordinated updates across the chat substrate + tests. Revisit in a future M2.X.5.x.
- **Q3:** Should `contentToText` accept an option to include image-block placeholders (e.g. `"[image]"`)?
  - _Current direction:_ Out of scope. Operators wanting alternative serialization implement their own walker. The default text-only extraction is the common case.
- **Q4:** Should we ship typed image-block builders (`textBlock(text)` / `imageBlock({format, bytes})`)?
  - _Current direction:_ Object literals are concise enough. Builders are syntactic sugar; add if call sites get noisy.
- **Q5:** What about audio content blocks for STT / TTS providers?
  - _Current direction:_ Out of scope. No current provider exposes audio through chat. Future M2.X.5.x when an audio provider ships.
- **Q6:** Should the Responses API path translate image blocks to a Responses-API-compatible image input shape?
  - _Current direction:_ OpenAI Responses API has a different input shape; image inputs work but require a separate translation. Out of scope for M2.X.5; closes in a future M2.8.6 or M2.X.5.x. Current behavior: image blocks on the Responses path are silently dropped via `contentToText`.
- **Q7:** Should the router's prompt-cache layer hash by content shape or by `contentToText`?
  - _Current direction:_ Out of scope. The router caches by request hash; shape changes flow through naturally. If shape-aware caching becomes important, it's an M6.6+ enhancement.
