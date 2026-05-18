# ADR-0078: Kernel `LlmMessage.attachments` + vision capability (Phase 2 M2.X)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-18 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0077 (M2.9.7 Bedrock multimodal + image content blocks), ADR-0060 (OpenAI provider), ADR-0053 (Anthropic provider), ADR-0055 (M5.6 cacheControl) |

## Context

ADR-0077 Q1 left the kernel-side multimodal-content extension explicitly open:

> When should the kernel `LlmMessage` schema be extended to support image content?
> _Current direction:_ When ≥ 2 providers support image input via their `LlmProvider.complete()` and we can converge on a kernel shape.

That bar is met now. All three real providers — Anthropic (M2.7), OpenAI (M2.8), Bedrock (M2.9 + M2.9.7) — accept image input via their native APIs:

- **Anthropic** Messages API: `content: [{type: "text", text}, {type: "image", source: {type: "base64", media_type, data}}]`
- **OpenAI** Chat Completions: `content: [{type: "text", text}, {type: "image_url", image_url: {url}}]` (URL can be `data:image/png;base64,<bytes>`)
- **Bedrock** Converse: `content: [{text}, {image: {format, source: {bytes}}}]` (M2.9.7 added the type machinery)

The kernel `LlmMessage.content: string` was the bottleneck. M2.X adds an optional `attachments?: MessageAttachment[]` field as a sibling of `content` (not a replacement), threads it through all three provider translators, and adds a `vision: boolean` capability flag.

Three constraints shaped the design:

- **Additive only.** Existing M5.6+ callers see no behavior change. A message without `attachments` produces byte-identical output to pre-M2.X for every provider.
- **User-role only.** All three providers accept image input on user messages only; the model doesn't emit image output today. The kernel schema enforces this via a `superRefine` — `attachments` on system/assistant/tool messages is a parse error.
- **Discriminated union for future extensibility.** `MessageAttachment` is a discriminated union with `kind: "image"` today. Audio / video / document attachments slot in without breaking existing consumers; unknown `kind` values reject cleanly.

## Decision

Four packages touched. All changes additive.

### 1. `@crossengin/ai-providers` — kernel schema

```ts
export const IMAGE_ATTACHMENT_FORMATS = ["png", "jpeg", "gif", "webp"] as const;
export const ImageAttachmentFormatSchema = z.enum(IMAGE_ATTACHMENT_FORMATS);

export const ImageAttachmentSchema = z.object({
  kind: z.literal("image"),
  format: ImageAttachmentFormatSchema,
  bytes: z.string().min(1),         // base64-encoded, non-empty
});

export const MessageAttachmentSchema = z.discriminatedUnion("kind", [
  ImageAttachmentSchema,
]);

export const LlmMessageSchema = z.object({
  // ... existing fields (role, content, name, toolCallId, toolUses)
  attachments: z.array(MessageAttachmentSchema).optional(),
}).superRefine((m, ctx) => {
  if (m.attachments !== undefined && m.attachments.length > 0 && m.role !== "user") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attachments"],
      message: `attachments only allowed on user messages (got role '${m.role}')`,
    });
  }
});

export function imageMediaType(format: ImageAttachmentFormat): string;
```

Empty `attachments: []` on any role is allowed (no-op). Non-empty `attachments` on a non-user role rejects with `attachments only allowed on user messages`.

`ProviderCapabilitiesSchema` gains `vision: z.boolean().default(false)` — additive with a default so existing capability literals don't need to specify it explicitly (the schema parser fills it in). The three real providers all flip `vision: true`; the mock provider keeps `vision: false`.

`imageMediaType(format)` is a helper returning `"image/<format>"` — used by the Anthropic + OpenAI translators.

### 2. `@crossengin/ai-providers-anthropic` — message translator

`splitSystem` extended in the user branch:

```ts
if (m.role === "user") {
  const attachments = m.attachments ?? [];
  if (attachments.length === 0) {
    conversation.push({ role: "user", content: m.content });  // backward-compat string content
    continue;
  }
  const blocks: AnthropicContentBlock[] = [];
  if (m.content.length > 0) blocks.push({ type: "text", text: m.content });
  for (const a of attachments) {
    if (a.kind === "image") {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: `image/${a.format}`, data: a.bytes },
      });
    }
  }
  conversation.push({ role: "user", content: blocks });
  continue;
}
```

`AnthropicContentBlock` discriminated union grows the `image` variant; `media_type` is the typed `"image/png" | "image/jpeg" | "image/gif" | "image/webp"` union derived from the format enum.

### 3. `@crossengin/ai-providers-openai` — message translator

`OpenAIChatMessage.content` widens from `string | null` to `string | null | readonly OpenAIContentPart[]`. New `OpenAIContentPart` union:

```ts
type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
```

Translator emits content-part arrays only when attachments are present:

```ts
if (m.role === "user") {
  const attachments = m.attachments ?? [];
  if (attachments.length === 0) return { role: "user", content: m.content };  // backward compat
  const parts: OpenAIContentPart[] = [];
  if (m.content.length > 0) parts.push({ type: "text", text: m.content });
  for (const a of attachments) {
    if (a.kind === "image") {
      parts.push({
        type: "image_url",
        image_url: { url: `data:image/${a.format};base64,${a.bytes}` },
      });
    }
  }
  return { role: "user", content: parts };
}
```

`extractTextFromResponse` updated to handle content-part array responses (joins text-typed parts, ignores image_url parts) for the case where vision-model responses return structured content.

### 4. `@crossengin/ai-providers-bedrock` — converse translator

`buildBedrockConverseRequest` user branch extended to append `BedrockImageContentBlock` entries (the type already existed from M2.9.7):

```ts
if (m.role === "user") {
  const userBlocks: BedrockContentBlock[] = [];
  if (m.content.length > 0) userBlocks.push({ text: m.content });
  for (const a of m.attachments ?? []) {
    if (a.kind === "image") {
      userBlocks.push({
        image: { format: a.format, source: { bytes: a.bytes } },
      });
    }
  }
  if (userBlocks.length === 0) userBlocks.push({ text: m.content });  // empty-string edge case
  messages.push({ role: "user", content: userBlocks });
}
```

M2.9.7 already had `BedrockImageContentBlock` types + `buildBedrockImageBlock` factory + extractor skip-logic. M2.X just wires the kernel-side data into the builder.

### 5. Router union update

`apps/architect-cli/src/router-setup.ts` `unionCapabilities` extended to `OR` the `vision` field across all configured providers. When all three providers are configured, the router exposes `vision: true` to the chat substrate.

## Cross-cutting invariants enforced

- **Backward compat: zero behavior change without attachments.** A message with no `attachments` field produces byte-identical request bodies on all three providers (regression-tested in each translator).
- **User-role only.** Schema-level rejection catches misconfigurations at parse time. The runtime path never sees attachments on a system/assistant/tool message.
- **Format → media-type mapping is one-to-one.** PNG → image/png, JPEG → image/jpeg, GIF → image/gif, WEBP → image/webp. No format aliases; no auto-detection.
- **Empty `attachments: []` is a no-op.** Schema accepts it on any role; translators skip the entire attachments loop. Keeps callers from having to delete the field conditionally.
- **Image-only prompts work.** When `content: ""` + non-empty attachments, all three translators emit the array-content shape without an empty text block. Tests pin this for each provider.
- **`MessageAttachment` is a discriminated union.** Adding `AudioAttachment`, `VideoAttachment`, `DocumentAttachment` later requires only a new schema in the union — existing providers naturally narrow on `if (a.kind === "image")` and forward-pass the rest.
- **`vision: boolean` capability is additive with default false.** `ProviderCapabilitiesSchema.parse(legacyShape)` still succeeds; the parser fills in `vision: false`. Tests pin this backward-compat behavior.

## Alternatives considered

- **Replace `content: string` with `content: string | ContentPart[]` (kernel-side discriminated union).**
  - **Pros.** Single field; matches OpenAI / Anthropic shape directly.
  - **Cons.** Breaks every existing caller; every message-building helper across the workspace would need updating; the chat REPL + tool dispatch + transcript persistence all assume `content: string`. Massive blast radius for a non-additive change.
  - **Decision.** Sibling `attachments` field. Content stays a string; attachments compose with it.

- **Allow attachments on assistant messages (for vision-model output).**
  - **Pros.** Symmetry with user-side.
  - **Cons.** No provider emits image content from the model today (vision is input-only across Anthropic / OpenAI / Bedrock). Allowing it on assistant role would let callers construct invalid messages that no model produces.
  - **Decision.** User-role only. Revisit if/when a provider ships image-output models.

- **Use a content-block array type on `LlmMessage` (kernel-side, fully structured).**
  - **Pros.** First-class structured content; future-proof.
  - **Cons.** OpenAI, Anthropic, Bedrock all have different structured-content shapes. A kernel-level normalized form would lose per-provider features (Anthropic cache_control, OpenAI image_url's optional `detail: "high"|"low"`, Bedrock cachePoint blocks). The provider translators are the right place to normalize; the kernel side stays opinion-free.
  - **Decision.** `content: string + attachments: MessageAttachment[]` is the kernel-level shape. Provider translators handle structured-content quirks.

- **Encode images as data URLs in `bytes`.**
  - **Pros.** Self-describing.
  - **Cons.** OpenAI accepts data URLs; Anthropic + Bedrock want raw base64 bytes separate from `media_type` / `format`. Storing data URLs in the kernel would force the Anthropic + Bedrock translators to parse them back out. Cleaner to keep `bytes` as raw base64 + `format` as the discriminator.
  - **Decision.** Raw base64 + format enum. Translators construct data URLs as needed.

- **Accept image URLs (not just inline bytes).**
  - **Considered.** OpenAI supports HTTP(S) URLs; Anthropic doesn't (base64 only); Bedrock doesn't.
  - **Decision.** Inline base64 only for now. Two of three providers don't support URLs; adding kernel-level URL support would either force the Anthropic + Bedrock translators to fetch + base64-encode (with SSRF concerns + latency) or fail loudly. Provider-native APIs can layer URL support if a specific use case emerges; M2.X stays bytes-only.

- **Add per-message `vision_detail: "high" | "low" | "auto"` to control OpenAI's image processing detail.**
  - **Considered.** OpenAI's only multimodal-tuning knob.
  - **Decision.** Out of scope. OpenAI uses "auto" by default; rare cases that need explicit control can subclass the provider. Adding a kernel-level field for a single-provider knob is the same anti-pattern as ADR-0073's "promote Bedrock to primary" question.

- **Validate that `bytes` is actually valid base64.**
  - **Considered.** Strict-mode parser.
  - **Decision.** Length check only. Each provider's API validates the bytes at the boundary; replicating the check client-side risks false rejections (some encoders use URL-safe base64 or omit padding). Operators with malformed bytes get a clear provider-side error.

- **Add `MessageAttachmentSchema` to the M2.9.7 Bedrock image block types instead of the kernel.**
  - **Considered.** Provider-local.
  - **Decision.** No — that's where M2.9.7 left it. The whole point of M2.X is to move the abstraction up to the kernel so all three providers consume it uniformly.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,425 tests** (+29 from M2.X; was 6,396 after M2.9.7). All green, zero type errors.
- **Vision-LLM chat works cross-provider.** A caller constructs `LlmMessage` with `attachments: [{kind: "image", format: "png", bytes: "..."}]` and routes through the M6.5 router. Anthropic Claude 4.x / OpenAI gpt-4o / Bedrock Claude / Llama vision all see the same structured request shape; each provider translates to its native wire format.
- **M2.9.7 Bedrock image content blocks are now reachable from the kernel.** The type machinery shipped in M2.9.7 was sitting unused; M2.X wires it.
- **Pattern set for future attachment kinds.** Audio (Whisper-style), video (Gemini), documents (Claude PDF) all slot into the `MessageAttachment` union without breaking existing consumers. Each provider translator narrows on `a.kind === "audio"` etc. and adds the per-provider translation.
- **Router exposes vision union correctly.** With all three providers configured, `provider.capabilities.vision === true`. A future M6.5.x could add per-model capability gating (e.g., gate `vision` to gpt-4o not o1-mini) — for now, provider-level union is good enough.
- **Tool tests confirm no regressions.** All 119 OpenAI tests + 69 Anthropic tests + 203 Bedrock tests pass; the existing tool-use round-trip behavior (M5.6) is unaffected.
- **Architect REPL needs no changes.** The chat engine, transcript persistence, and tool dispatcher all consume `LlmMessage` as opaque records; `attachments` rides through transparently. When a future UI surfaces multimodal input, the kernel side is ready.
- **ADR-0077 Q1 + M2.9.7 chat image content block forward-compat marker both closed.**

## Open questions

- **Q1:** Should the chat REPL expose `--attach <path>` / `--attach-image <path>` flags?
  - _Current direction:_ Defer. The kernel shape is ready; CLI affordances are a separate UI concern. A future M5.X could add file-path → base64 encoding for the REPL.
- **Q2:** What about model-level vision gating?
  - _Current direction:_ Provider-level only for M2.X. `OpenAIProvider.capabilities.vision === true` regardless of which model is active — even though `o1` doesn't accept images. A future M6.5.x could add per-model capability tables; the router would gate fallback chains accordingly.
- **Q3:** Should `extractTextFromResponse` (OpenAI) also assemble content from any future vision-output responses?
  - _Current direction:_ Already handles content-part arrays (returns text parts joined, ignores image_url parts). Same forward-compat as M2.9.7 Bedrock extractors.
- **Q4:** What about transcript persistence (`@crossengin/ai-architect-pg`)?
  - _Current direction:_ The transcript stores `LlmMessage` records as JSON. Image bytes will go into the message_data column — base64-encoded means ~33% storage overhead vs raw. Consumers querying the transcript see attachments naturally. M5.X observability work can layer separate image-storage if size becomes a concern.
- **Q5:** Image size limits?
  - _Current direction:_ Provider-side. AWS Bedrock caps at ~5 MB per image; OpenAI at 20 MB; Anthropic at 5 MB. Kernel-level validation is brittle (limits change); operators get a clear provider-side error.
- **Q6:** Should `MessageAttachmentSchema` be exported from the helpers module too?
  - _Current direction:_ Already exported from `types.js`. Helpers can compose attachments via the imported schema.
- **Q7:** Anthropic-side `cache_control` markers on image content blocks?
  - _Current direction:_ Out of scope. Anthropic supports caching on image blocks via the same `cache_control: {type: "ephemeral"}` marker; threading the M5.6 `cacheControl` field onto specific image attachments would need per-attachment cache hints. A future M2.X.5 could thread this.
