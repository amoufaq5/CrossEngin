# ADR-0054: Architect CLI chat mode (Phase 2 M5.5)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-17 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0027 (LLM provider router), ADR-0051 (architect-cli M5), ADR-0053 (Anthropic provider M2.7) |

## Context

M5 shipped `apps/architect-cli` with eight working subcommands plus a stubbed `chat` that printed "not implemented in M5; ships in M5.5". M2.7 shipped the real `AnthropicProvider`. M5.5 wires the two together so `crossengin chat` actually talks to Claude.

Three constraints shaped the design:

1. **The chat code must be testable without making real API calls.** The CLI's test suite runs offline in CI — no live Anthropic key, no network. Every chat-mode test must use a stubbed `LlmProvider` injected via `RunContext`. The Anthropic SDK binding is constructed only at the bin layer when no override is supplied.

2. **The CLI must be useful in both interactive and scripted contexts.** Interactive: a developer types `crossengin chat`, sees a banner, types a question, sees the response stream back, hits `/exit`. Scripted: a CI job runs `crossengin chat --prompt "summarize this manifest" --format=json --max-tokens=512` and parses the result. Both modes share the same turn-execution code.

3. **Errors must be friendly.** Missing `ANTHROPIC_API_KEY`, an unknown model, a malformed `--max-tokens` — each fails with a single human-readable line and a non-zero exit code (1 for runtime errors, 2 for argument misuse, mirroring the rest of the CLI).

## Decision

`apps/architect-cli/src/chat.ts` exports the chat engine; `commands.ts.runChat` wires it to flags + env + provider construction. Two layers:

### Layer 1 — `chat.ts` (transport-agnostic)

- **`DEFAULT_ARCHITECT_SYSTEM_PROMPT`.** Primes Claude as the CrossEngin Architect — "produce manifest fragments that conform to the kernel schema, cite ADRs by number, never invent fields that aren't in the meta-schema." Overridable via `--system` / `--system-file`.

- **`buildCompletionRequest({userInput, history, systemPrompt, tenantId, sessionId, model, maxTokens})`.** Pure helper: prepends the system prompt, appends `history`, appends the new user message. Sets `task: "executor"`. The resulting `CompletionRequest` is the contract `@crossengin/ai-providers` requires.

- **`StreamRenderer` interface.** Five callbacks: `onText` / `onToolCallStart` / `onToolCallArg` / `onToolCallEnd` / `onUsage`. Two built-ins:
  - **`plainTextRenderer(io)`** — writes text directly to stdout (typewriter effect), emits bracketed `[tool_call:name]` / `[/tool_call]` markers, suppresses raw arg deltas, defers usage rendering to the outer loop.
  - **`jsonChunkRenderer(io)`** — emits one NDJSON line per chunk so callers can pipe through `jq -c` and consume the same shape `@crossengin/ai-providers` defines.

- **`runChatTurn(provider, input, renderer)`.** Iterates `provider.complete(request)`, forwards each chunk to the renderer, accumulates assistant text + tool calls + usage. Returns `{record, history}` — the new history (with user + assistant appended) becomes the input to the next turn.

- **`runChatRepl({provider, io, stdin, systemPrompt, tenantId, sessionId, model, maxTokens, format, prompt, oneShot})`.** Two paths:
  1. If `prompt` is supplied — run a single turn, return.
  2. Else — print a banner, read lines from `stdin` until `/exit` / `/quit` / EOF. Each non-blank line is a turn. Aggregate usage across turns.

- **`linesFromReadable(stream)`.** Async-generator helper that wraps a Node `ReadableStream` and yields one string per `\n`-delimited line. Handles the trailing partial line without a final newline. Used by the bin to convert `process.stdin` into the abstract `AsyncIterable<string>` the REPL expects.

### Layer 2 — `commands.ts.runChat`

- Parses `--model` / `--max-tokens` / `--system` / `--system-file` / `--tenant-id` / `--session-id` / `--prompt` / `--one-shot` / `--format`.
- Validates `--model` via `isAnthropicModel`; rejects unknown ids with exit 2.
- Validates `--max-tokens` as a positive integer; rejects with exit 2.
- Reads `--system-file` from disk (exit 1 on read failure).
- Looks up `ANTHROPIC_API_KEY` from env. If missing — friendly error + exit 1. If `ctx.providerOverride` is set (test mode), use it instead.
- Constructs `AnthropicProvider({apiKey, defaultModel: model})`.
- Selects stdin: `ctx.stdin` if provided (test mode), else `linesFromReadable(process.stdin)` for REPL, else an empty async iterable for one-shot (so the REPL loop has nothing to iterate).
- Calls `runChatRepl(...)`. On error — exit 1 with the error message.
- On success — print aggregate-usage line (human) or JSON summary (json).

The `RunContext` type gains two optional fields: `stdin?: AsyncIterable<string>` and `providerOverride?: LlmProvider`. Both default to undefined; the bin doesn't set them, so production behavior is unchanged.

## Cross-cutting invariants enforced

- **No live API call in tests.** Every chat-mode test injects `providerOverride: new StubProvider([...])` so `process.env.ANTHROPIC_API_KEY` is irrelevant in CI. The one test that asserts the missing-key error sets no provider override and an empty `env`.
- **Tenant id is required input, never auto-detected.** Defaults to a fixed nil-uuid sentinel (`00000000-0000-4000-8000-000000000000`) for the developer's interactive workstation, but production deployments override via `--tenant-id`. The chat code never reads tenant from message bodies (untrusted).
- **Session id is unique per run.** Defaults to `cli-${Date.now().toString(36)}`. Operators wiring chat into longer-lived telemetry can pin a stable id via `--session-id`.
- **Streaming first.** The CLI always sets `task: "executor"` and lets the provider stream chunks. Even in `--format=json` mode, output is NDJSON (one chunk per line) — not a single JSON document — so consumers can react to partial output.
- **Aggregate usage is rounded.** Per-turn usage values are summed; the aggregate `cost` is rounded to 6 decimal places (the same precision the provider's `computeUsageCost` uses) so the printed total never has 15-digit float artifacts.
- **Empty / blank lines don't burn API calls.** The REPL skips lines that trim to `""`. A user mashing Enter is free.

## Alternatives considered

- **Use `node:readline` for the REPL.**
  - **Pros.** Tab completion, history, line editing.
  - **Cons.** `readline` interactivity is hard to test deterministically (event-driven, requires TTY emulation). Hooks like `\x1b` keys make CI flaky.
  - **Decision.** Plain line-iteration via `linesFromReadable`. Tests pass an `AsyncIterable<string>` directly. Future M5.6 can layer a TTY-aware adapter on top without changing the engine.

- **Implement multi-turn tool-use loops (Claude calls a tool → CLI executes → feed result back).**
  - **Considered.** Wire `crossengin validate`, `crossengin hash`, `crossengin apply --dry-run` as tools the Architect can invoke during chat.
  - **Decision.** Out of scope for M5.5. The chat captures tool-call events but doesn't dispatch them. M5.6 (chat-driven manifest editing) is the next milestone.

- **Persist transcripts to a META_ARCHITECT_SESSIONS table.**
  - **Considered.** Every chat turn writes a row.
  - **Decision.** No. The CLI is local; persistence is a Phase 3 concern (`@crossengin/ai-architect` already defines the session contract). For now, transcripts are ephemeral — operators redirect stdout if they want a log.

- **Default to streaming in `--format=json`.**
  - **Considered.** Buffer the whole response, emit one JSON envelope at end.
  - **Decision.** NDJSON streaming is better for: progress indication, partial-response handling, pipe-to-`jq`. The trade-off — consumers need a line-oriented parser, but every modern stack ships one.

- **Pin a single model.**
  - **Considered.** Hard-code `claude-sonnet-4-6`.
  - **Decision.** `--model` flag with `isAnthropicModel` validation. Defaults to sonnet-4-6 (best cost/quality for the Architect's typical task), opus-4-7 for heavy planning, haiku-4-5 for quick lookups.

- **Make the provider an interface the CLI doesn't import directly.**
  - **Considered.** `RunContext.providerFactory: (env) => LlmProvider` so other providers can be plugged in.
  - **Decision.** Premature. M2.7 ships Anthropic only; M2.8 adds OpenAI/Bedrock/Vertex. When the second provider lands, we add a factory boundary — until then, direct construction keeps the code straight.

- **Wire `@crossengin/ai-architect`'s policy + safety gates.**
  - **Considered.** Run every chat turn through the policy from ADR-0027 (refusal copy, cost ceilings, eval gate).
  - **Decision.** Out of scope for M5.5. The CLI is a developer tool, not a tenant-facing surface. Policy gating ships in M5.6 when the chat dispatches manifest-edit tools.

## Consequences

- **The CLI is now actually useful.** `crossengin chat --prompt "What entity fields are required to model a hospital admission?"` returns an answer with token-accurate cost. The Architect agent has a real binding to a real model.
- **+28 tests (5,552 → 5,580).** No new META_ tables; chat mode is stateless client code.
- **48 packages + 1 app remains accurate** — the chat module lives inside `architect-cli`, not a new package.
- **Pattern set for tool-driven chat.** `runChatTurn` already collects tool-call events; M5.6 only needs to add a dispatch loop (read tool_call → execute → reply with tool_result → continue).
- **ANTHROPIC_API_KEY is now a real prerequisite for the `chat` subcommand.** Documented in `crossengin help`. Missing-key path returns exit 1 with a one-line hint (no stack trace).
- **Streaming chunks line up with `@crossengin/ai-providers` discriminated union.** `--format=json` emits the exact `CompletionChunk` JSON shape — operators piping to `jq` see `{"kind":"text","text":"..."}` and `{"kind":"usage_final","usage":{...}}` directly.

## Open questions

- **Q1:** Should `/exit` be `:exit`, `quit`, `q`, or all of the above?
  - _Current direction:_ `/exit` + `/quit` work. Slash-prefix matches IRC / Discord / Slack conventions. Future M5.6 may add `/save`, `/system`, `/clear`.
- **Q2:** When should the CLI prompt-cache a long system prompt?
  - _Current direction:_ Not in M5.5. The Anthropic provider already supports `cacheControl` on `CompletionRequest`; once the chat hits >2,048-token system prompts (e.g., a full manifest pinned as context), M5.6 turns on `cacheControl.systemPrompt` automatically.
- **Q3:** Should `--system-file` accept stdin (`-`)?
  - _Current direction:_ Not in M5.5. Out of scope; can be added without breaking changes.
- **Q4:** How does the CLI handle Ctrl-C mid-stream?
  - _Current direction:_ Today the default Node behavior — SIGINT terminates. M5.6 wires an `AbortController` into `provider.complete` so partial output is rendered + usage is reported before exit.
- **Q5:** Should the CLI emit a `crossengin-chat-trace.jsonl` file by default?
  - _Current direction:_ No — operators redirect stdout if they want a log (`crossengin chat --format=json > trace.jsonl`). A dedicated trace file is M5.6's concern when tool-dispatch lands.
