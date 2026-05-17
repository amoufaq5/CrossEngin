# ADR-0055: Architect CLI tool-driven chat (Phase 2 M5.6)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-17 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0053 (Anthropic provider), ADR-0054 (chat mode), ADR-0027 (developer SDK), ADR-0051 (architect-cli) |

## Context

M5.5 wired chat against Claude but the assistant could only produce text. The CLI already exposes `validate / hash / diff / summarize` as subcommands — exactly the operations a developer drafting a manifest needs to verify their work. Without tool dispatch, every check requires the developer to copy text out of chat, save it, run a subcommand, paste the output back. That's not a real authoring loop.

Three constraints shaped the design:

1. **The assistant's tool_use blocks must round-trip cleanly.** Anthropic's API requires the previous assistant turn's `tool_use` blocks to be present in the conversation when supplying `tool_result`. The existing `LlmMessage` schema only had `role + content + name + toolCallId` — no way to encode the tool_use blocks an assistant produced. Without that, the second turn would fail with "Each tool_use must have a corresponding tool_result".

2. **Tool execution is local and side-effectful.** Validate / hash / diff are pure (compute over the supplied manifest JSON), but a future `read_file` is real I/O against the developer's filesystem. The tool catalog needs an opt-in for filesystem access + per-extension allowlist + size cap.

3. **Tool loops can run forever.** A misbehaving assistant could keep calling tools without producing terminal text. The CLI needs a per-exchange iteration cap (default 5) so a single user message can't burn the API budget.

## Decision

Three changes across two packages plus the CLI app:

### Change 1 — `@crossengin/ai-providers`: extend `LlmMessageSchema` with optional `toolUses`

```ts
toolUses: z.array(z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
})).optional(),
```

Assistant messages now carry zero or more tool_use blocks alongside their text content. Providers are responsible for mapping these into their wire format. The schema change is additive — existing `LlmMessage` consumers that don't set the field see no behavior change.

### Change 2 — `@crossengin/ai-providers-anthropic`: emit tool_use blocks in `buildAnthropicRequest`

When an assistant message has `toolUses.length > 0`, the build helper emits a content-block array instead of a plain string:

```ts
[
  ...(text.length > 0 ? [{type: "text", text}] : []),
  ...toolUses.map(u => ({type: "tool_use", id, name, input})),
]
```

Empty-text + tool_use cases drop the text block entirely (Anthropic rejects empty `text` content blocks). Text + no tool_use cases keep the existing plain-string path (no regression).

### Change 3 — `architect-cli`: tool catalog + tool-dispatch loop

**`src/tools.ts`** — the local tool catalog:

- `buildToolCatalog({allowFileRead?, fileRootDir?, maxFileBytes?})` returns the default four tools:
  - **`validate_manifest({manifest_json})`** — `tryValidateManifest` → `{ok: true, summary}` or `{ok: false, errors}`.
  - **`hash_manifest({manifest_json})`** — `manifestHash` → `{hash}`.
  - **`diff_manifests({old_manifest_json, new_manifest_json})`** — `computeManifestDiff` → the diff object.
  - **`summarize_manifest({manifest_json})`** — `buildManifestSummary` without full validation, useful for quick orientation.
  - Plus optional **`read_file({path})`** when `allowFileRead === true` — reads `.json|.yaml|.yml|.txt|.md` only, resolves relative to `fileRootDir ?? process.cwd()`, capped at `maxFileBytes` (default 1 MiB). Disallowed extensions / oversized files → error envelope.
- `toolsToLlmTools(catalog)` strips the `execute` function, leaving `{name, description, inputSchema}` for the request.
- `executeToolCall(catalog, {id, name, input})` returns `{id, name, output: <JSON string>, isError}`. Tool exceptions are caught and converted to `{error: message}` envelopes — Claude sees the error in the tool_result and can react.
- `ToolExecutionError` for typed thrown errors inside tool implementations.

**`src/chat.ts`** — the tool-dispatch loop:

- `CapturedToolCall = {id, name, input}` replaces the prior `{id, name}` shape so tool inputs assembled from `tool_call_arg_delta` chunks are visible to consumers.
- `streamCompletion(provider, request, renderer)` is extracted from `runChatTurn`: drives the provider stream, accumulates text + tool calls (with assembled JSON inputs) + usage.
- `runChatTurn` now sets the assistant message's `toolUses` field when calls are present, so the next turn's history round-trips.
- `runChatExchange({provider, renderer, io, format, history, userInput, systemPrompt, ..., toolCatalog, maxToolIterations})` is the new top-level abstraction:
  1. Run the first turn with `tools` supplied (if catalog given).
  2. While the assistant produced tool calls AND iterations < cap:
     - Execute each tool locally via `executeToolCall`.
     - Render the result (plain-text bracketed status + truncated payload; or NDJSON `{kind: "tool_result", id, name, is_error, output}` in json mode).
     - Append tool-role `LlmMessage` per call to history (carries `toolCallId` for Anthropic's `tool_use_id` matching).
     - Call the provider again with the extended history; capture another (text + maybe tool calls + usage) round.
  3. Return `{history, assistantText, toolInvocations, usage, iterations, truncated}`.
- `runChatRepl` is now a thin wrapper around `runChatExchange` per user message, threading the catalog through.

**`src/commands.ts.runChat`** — new flags:
- `--no-tools` — disable the catalog (text-only mode).
- `--allow-file-read` — include `read_file` in the catalog.
- `--max-tool-iterations N` — cap loops per user message (default `DEFAULT_MAX_TOOL_ITERATIONS = 5`).

Constructor short-circuit for tests via `RunContext.providerOverride` remains; the catalog is still constructed (since it's pure), so test paths exercise the dispatch logic without needing a real Anthropic key.

## Cross-cutting invariants enforced

- **Iteration cap is always finite.** `DEFAULT_MAX_TOOL_ITERATIONS = 5`. Past the cap, `runChatExchange` returns `{truncated: true}` and stops — the CLI never spins forever even if the assistant misbehaves.
- **Tool errors don't terminate the exchange.** A tool throwing returns `{isError: true, output: JSON.stringify({error})}`. The error is sent back to Claude as a tool_result; Claude can apologize, retry with different input, or give up. The CLI doesn't crash.
- **Tool inputs are JSON objects.** Non-object inputs (string / array / null) return an error envelope. Empty / missing fields the tool requires get rejected at the tool boundary via `parseManifestArg` / per-tool checks.
- **File access is opt-in + extension-gated.** `read_file` only ships when `--allow-file-read` is set; even then, only `.json / .yaml / .yml / .txt / .md` and ≤1 MiB. No tool can write, delete, exec, or list directories. Code execution is not exposed.
- **Anthropic round-trip is correct.** The previous assistant turn's `tool_use` blocks are encoded in the next request, matching what Anthropic requires for `tool_use_id` references in user-role `tool_result` blocks. Verified by the new messages-api tests.
- **No-op for text-only chat.** When `toolCatalog` is undefined (`--no-tools`, or test paths that don't pass one), `runChatExchange` runs exactly one turn and skips the dispatch loop. The new abstraction is strictly additive over M5.5.
- **Aggregate usage spans every iteration.** Per-iteration `usage_final` chunks are summed; the exchange's reported `usage` covers all turns the user's single message triggered. The session-level aggregate in the REPL then sums per-exchange totals.

## Alternatives considered

- **Use `completeNonStreaming` for tool-using turns.**
  - **Pros.** The full `AnthropicResponse` with content blocks is in hand at end of turn; no need to assemble tool inputs from arg deltas.
  - **Cons.** Loses the typewriter effect for the assistant's narration around the tool call. Also splits the code path between text-only (streaming) and tool-using (non-streaming) — two flows to maintain.
  - **Decision.** Stay streaming. Assemble tool inputs from `tool_call_arg_delta` chunks. The `parseToolInputJson` helper falls back to `{__raw: buffer}` if the JSON is malformed (the tool will then reject it cleanly).

- **Bake tool dispatch into `@crossengin/ai-providers-anthropic`.**
  - **Considered.** A `provider.completeWithTools(req, catalog)` method.
  - **Decision.** Tool dispatch is consumer logic, not provider logic. Different consumers will dispatch differently (locally / via job queue / via gateway routes). The provider's job is to stream chunks; the consumer's job is to orchestrate.

- **Define tools in the manifest schema instead of in the CLI.**
  - **Considered.** A `tools: {...}` section in the manifest that the kernel emits.
  - **Decision.** Out of scope for M5.6. CLI tools are a developer-time concern (validate / hash / diff); manifest-level tools are a runtime concern (per-tenant integrations, function definitions). Phase 3's `@crossengin/integrations` package handles the latter.

- **Make `read_file` always on.**
  - **Considered.** Convenience for developers.
  - **Decision.** Opt-in via `--allow-file-read`. Even with extension + size limits, exposing the filesystem to an LLM is something the developer should explicitly request. Friction here is a feature.

- **Persist tool invocations to a JSONL file by default.**
  - **Considered.** A `chat-trace.jsonl` per session.
  - **Decision.** Operators redirect stdout if they want a log (`crossengin chat --format=json > trace.jsonl`). Built-in file writing is M5.7's concern when chat persistence to META_ARCHITECT_SESSIONS lands.

- **Allow tools to mutate the on-disk manifest directly.**
  - **Considered.** A `write_manifest({path, manifest_json})` tool.
  - **Decision.** No. M5.6 keeps the loop strictly read-only. M5.8 (when it lands) can add `propose_edit` that emits a diff for human approval — keeping the human in the loop for any write.

- **Surface a higher iteration cap by default.**
  - **Considered.** 10 or 20.
  - **Decision.** 5 is enough for the common "validate → hash → summarize → wrap up" flow. Power users override with `--max-tool-iterations`.

## Consequences

- **The chat is now a real authoring loop.** A developer types "validate the manifest I just init'd at /tmp/m.json (read it for me, then validate, then tell me the hash)" and the assistant chains `read_file → validate_manifest → hash_manifest → text response` in one turn.
- **`@crossengin/ai-providers.LlmMessage` is the canonical contract for tool round-trips.** Adding `toolUses?` here means every future provider (OpenAI / Bedrock / Vertex) gets a single, consistent way to encode assistant tool calls. Each provider just needs to map `toolUses` into its native format.
- **+26 tests (5,580 → 5,606).** Three new test surfaces: `LlmMessage.toolUses` round-trip in the Anthropic provider, the tool catalog itself (16 tests), and the tool-dispatch loop in chat (5 tests). No new META_ tables.
- **Pattern set for `@crossengin/ai-providers-openai`.** When M2.8 lands, OpenAI's `tool_calls` array maps to `toolUses` the same way. Symmetric with the Anthropic mapping; no schema changes needed.
- **Iteration cap exposes a soft SLO.** If a real exchange routinely hits `truncated: true`, that's a signal the system prompt or tool descriptions need tightening. The CLI doesn't enforce a hard limit on token spend (that's the M6.5 router's job), but iteration count is a useful coarse circuit breaker.

## Open questions

- **Q1:** Should tools support streaming output (e.g., a long file-read trickling tokens back)?
  - _Current direction:_ Not in M5.6. Tool results are buffered + emitted as a single `tool_result` chunk. Streaming tool results would change the renderer surface; revisit in M5.8 when manifest editing lands.
- **Q2:** How does the CLI handle tool calls Claude makes in parallel (multiple `tool_use` blocks in one turn)?
  - _Current direction:_ Each call is executed in order (not parallel), each result appended as a separate tool-role message. Claude's Messages API accepts multiple `tool_result` blocks under one user-role message; we currently emit one user-role message per tool. Both are valid per the API; sequential is simpler to reason about. Parallel execution is a Phase 3 concern.
- **Q3:** Should `read_file` enforce a path prefix (e.g., only files under `cwd`)?
  - _Current direction:_ Defaults to `cwd` as the root; absolute paths outside are NOT blocked (a developer chatting from their own machine can already read any file they want). Phase 3's tenant-aware chat sets `fileRootDir` strictly to a per-tenant sandbox.
- **Q4:** Does the iteration cap include the initial turn?
  - _Current direction:_ Yes — `iterations: 1` after the first turn, `iterations: 2` after the first tool round-trip. Cap of 5 means up to 4 tool round-trips per user message.
- **Q5:** What happens if Claude returns text AND tool_use in the final iteration before truncation?
  - _Current direction:_ The text is returned as `assistantText` + `truncated: true`. Operators can detect both conditions and decide how to surface to the user.
