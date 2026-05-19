# ADR-0119: Chat REPL widens user input to LlmContentBlock[] (Phase 2 M5.10.5)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0088 (M2.X.5 LlmMessage.content discriminated union), ADR-0094 (M2.X.5.y ImageUrlContentBlock), ADR-0097 (M2.X.5.aa DocumentContentBlock), ADR-0098 (M2.X.5.aa.y DocumentUrlContentBlock), ADR-0102 (M2.X.5.aa.z OpenAI Files API + FileReferenceContentBlock) |

## Context

The kernel `LlmMessage.content` has accepted `string | readonly LlmContentBlock[]` since M2.X.5 (ADR-0088). Eight block variants have shipped (text, image, image_url, document, document_url, file_id, tool_use, tool_result). Provider translators on Anthropic + OpenAI Chat + OpenAI Responses + Bedrock all handle the union properly.

But `crossengin chat` — the AI Architect REPL in `apps/architect-cli` — still serialized every user turn as a plain `string`. Operators wanting to paste an image URL, file_id, or document_url into a turn had no way to do it. The investment in M2.X.5/.x/.y/.z/.aa/.aa.x/.aa.y/.aa.z/.aa.z.1 reached every provider EXCEPT the substrate operators actually use.

M5.10.5 closes that loop. The chat REPL now accepts inline `/attach <type> <value>` commands that build up pending content blocks; the next plain text line composes them into a `LlmContentBlock[]` for that turn.

## Decision

Five surface changes in `apps/architect-cli/src/chat.ts`:

### 1. New `UserContent` type alias

```ts
export type UserContent = string | readonly LlmContentBlock[];
```

Used by `ChatTurnInput.userInput` and `ChatExchangeOptions.userInput`. The kernel's existing `LlmMessage.content` type already accepts this union; passing through the chat substrate is a structural-typing pass.

### 2. New `parseUserLine(line)` function

Slash-command parser returning a discriminated union:

```ts
export type ParsedUserLine =
  | { kind: "attach"; block: LlmContentBlock }
  | { kind: "clear_attachments" }
  | { kind: "show_attachments" }
  | { kind: "exit" }
  | { kind: "send"; text: string }
  | { kind: "noop" }
  | { kind: "error"; message: string };
```

Slash commands:
- `/attach image_url <url>` — adds `{type: "image_url", url}`.
- `/attach document_url <url>` — adds `{type: "document_url", url}`.
- `/attach file_id <id>` — adds `{type: "file_id", fileId}`.
- `/attach text <text>` — adds `{type: "text", text}` (lets operators prepend prefatory context).
- `/clear-attachments` — drops all pending blocks.
- `/show-attachments` — lists pending blocks.
- `/exit` or `/quit` — exits.
- Plain text → `send`.
- Empty / whitespace → `noop`.

`/attach <unknown-type>` returns `error` rather than silently treating as text. Lines starting with `/` that don't match a known command (e.g., `/notacommand`) are treated as plain text — the prefix doesn't claim ownership of all slash-prefixed input.

### 3. New `composeUserContent(text, pendingBlocks)` function

```ts
export function composeUserContent(
  text: string,
  pendingBlocks: readonly LlmContentBlock[],
): UserContent;
```

- No pending blocks → returns plain string (preserves backwards-compat shape).
- Pending blocks + non-empty text → returns `[...pendingBlocks, {type: "text", text}]`.
- Pending blocks + empty text → returns `[...pendingBlocks]` (text block omitted).

### 4. New `userContentToTranscriptText(content)` function

Flattens `UserContent` for transcript storage. Strings pass through; blocks render as bracketed placeholders (`[image_url:https://...]`, `[file_id:file-abc]`, `[document:application/pdf:12345b]`). The transcript schema's `content` field stays string-typed (per ADR-0088's compatibility plan), so the chat substrate flattens.

Operators reading transcripts see the same placeholder representation regardless of which block types were attached — useful for grep / log review.

### 5. New `describeAttachment(block)` function

Human-readable single-line description for `/show-attachments` and the post-attach acknowledgment line. Text descriptions truncate at 80 chars with ellipsis.

### 6. REPL loop maintains `pendingBlocks: LlmContentBlock[]` state

```
> /attach image_url https://example.com/img.png
[attached image_url: https://example.com/img.png]
> /attach file_id file-abc123
[attached file_id: file-abc123]
> describe these two
Architect: ... (LlmContentBlock[] with 2 attachments + final text block)
```

After a successful send, pending blocks reset to empty. Attachments DO NOT leak into the next turn — operators wanting multi-turn attachments re-attach.

### 7. Existing API surface widened

- `ChatTurnInput.userInput`: `string` → `UserContent`.
- `ChatExchangeOptions.userInput`: `string` → `UserContent`.
- `buildCompletionRequest(input)` — no change needed; the type widening propagates through `LlmMessage.content`.
- `runChatTurn` — no change needed.
- `runChatExchange` — transcript `onMessage` content field flattened via `userContentToTranscriptText`.

## Cross-cutting invariants enforced

- **Backwards compat preserved.** Every existing test continues to pass without change. Operators passing plain strings get plain strings (no array wrapper imposed).
- **Pending state is per-turn.** Attachments clear after each send; never leak across turns.
- **Slash commands are unambiguous.** `/attach`, `/clear-attachments`, `/show-attachments`, `/exit`, `/quit` are reserved. Other `/`-prefixed lines fall through to plain text.
- **Parse errors don't crash the REPL.** Unknown block types or missing values surface as `[error: ...]` lines in human mode; the loop continues.
- **Transcript content stays string-typed.** Block-rich messages flatten to a readable placeholder representation. The DB schema is unchanged.
- **No kernel changes.** The widening is local to `apps/architect-cli`. Kernel types already supported this since M2.X.5.

## End-to-end semantic

```
$ crossengin chat --provider anthropic
CrossEngin Architect chat. Type your message; Ctrl-D to exit; /exit to quit.
Attach blocks with /attach <type> <value>; /show-attachments; /clear-attachments.

> /attach image_url https://example.com/diagram.png
[attached image_url: https://example.com/diagram.png]
> /attach text Here is an architecture diagram for context:
[attached text: Here is an architecture diagram for context:]
> Walk me through the request flow shown in this diagram.

Architect: The diagram shows a three-tier request flow...
```

The model receives a single user message with three content blocks (image_url, text, text). Anthropic's translator handles all three natively; OpenAI Responses path handles image_url + text + text; Bedrock throws on image_url with actionable guidance (operator pre-fetches bytes).

## Alternatives considered

- **Wrap operator turns in JSON for block input.**
  - **Considered.** `{"text": "hello", "attachments": [{"type": "image_url", ...}]}` per turn.
  - **Cons.** Operators type JSON poorly at a REPL. Slash commands match shell conventions.
  - **Decision.** Slash commands.

- **Make `/attach` consume the SAME line's text after the value.**
  - **Considered.** `/attach image_url https://example.com/img.png describe this` in one line.
  - **Cons.** Ambiguous — how does the parser know where the URL ends and the text begins? Quote escaping at a REPL is fragile.
  - **Decision.** Two-line: attach first, then text.

- **Auto-detect URLs in plain text and convert to `image_url` / `document_url`.**
  - **Considered.** Operators paste URLs frequently.
  - **Cons.** False positives (URLs in code blocks, in quoted text); requires media-type sniffing. Explicit `/attach` is unambiguous.
  - **Decision.** Explicit only.

- **Persist pending blocks across turns until explicitly cleared.**
  - **Considered.** Operators may want a "context image" present for many turns.
  - **Cons.** Surprise blocks attached to a turn where the operator forgot they were pending leads to confusing model behavior. Per-turn semantics matches how most chat UIs work.
  - **Decision.** Per-turn reset.

- **Widen the transcript schema to store blocks as JSON.**
  - **Considered.** Lossless storage.
  - **Cons.** DB migration; query/grep tooling assumes string content; substantial blast radius for a feature most operators won't use for most turns.
  - **Decision.** Flatten to string placeholders for transcript. Future ADR can widen if demand justifies.

- **Add an `/attach image <path>` that base64-encodes a local file.**
  - **Considered.** Operators with local images shouldn't have to upload them first.
  - **Cons.** File I/O introduces error surfaces (permissions, encoding, size limits) that the REPL doesn't otherwise touch. Operators can use Files API (`uploadFile`) + `/attach file_id` instead.
  - **Decision.** No local-file path attachment in this milestone.

- **JSON output mode emits the parsed-line events.**
  - **Considered.** Lets toolchains drive the REPL programmatically.
  - **Cons.** Out of scope. Tools driving the REPL pass `userInput` directly through `runChatExchange`, bypassing slash-command parsing entirely.
  - **Decision.** Slash commands are human-input only.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 7,252 tests** (+34 from M5.10.5: all in `chat.test.ts`). All green, zero type errors.
- **The M2.X.5 investment is now end-to-end available to operators.** Every multimodal block variant (image_url, file_id, document_url, text) is reachable from the REPL.
- **Backwards compat fully preserved.** Existing string-input call sites compile + run unchanged. The 42 pre-existing chat tests pass without modification.
- **Slash-command vocabulary established.** `/attach`, `/clear-attachments`, `/show-attachments`, `/exit`, `/quit`. Future commands (`/export`, `/save`, `/system`) follow the same shape.
- **Transcript stays compatible.** Block-rich turns flatten to placeholder strings; DB schema unchanged.
- **Pattern set for future multimodal kernel additions.** When M2.X.5.aa.z.x adds the next block variant (e.g., video_url), the REPL gets a new `/attach video_url <url>` branch in `parseUserLine` — ~5 lines of code + tests.

## Open questions

- **Q1:** Should `/attach image <path>` base64-encode a local file?
  - _Current direction:_ Deferred. Operators with local files use `uploadFile` + `/attach file_id`. Add if demand surfaces.
- **Q2:** Should attachments persist across turns by default?
  - _Current direction:_ No. Per-turn reset is less surprising. Q1 follow-up: add `/sticky-attach` if operators need persistent context blocks.
- **Q3:** Should the transcript schema migrate to store blocks as JSON?
  - _Current direction:_ Deferred. Flattening is enough for the audit use case; widening would require a meta-schema migration.
- **Q4:** Should `/attach` accept a `--label` flag for human-readable annotation?
  - _Current direction:_ No. The kernel doesn't have a label field; adding one would require a kernel-level change.
- **Q5:** Should JSON-mode REPL accept a `{kind: "user_blocks", blocks: [...]}` event from stdin?
  - _Current direction:_ Out of scope. Tools should call `runChatExchange` directly.
- **Q6:** Should `/attach text` use the same trim semantics as plain text input?
  - _Current direction:_ Both currently trim leading/trailing whitespace. Consistent.
- **Q7:** Should `parseUserLine` accept multi-line input for `/attach text` (heredoc-style)?
  - _Current direction:_ Single-line for now. Heredoc parsing complicates the REPL loop substantially.
