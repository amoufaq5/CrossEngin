# ADR-0072: Multi-vendor router in architect-cli chat (Phase 2 M2.8.5)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0059 (ai-router), ADR-0064 (OpenAI provider), ADR-0054 (architect-cli chat mode), ADR-0053 (Anthropic provider) |

## Context

M6.5 (ADR-0059) shipped `@crossengin/ai-router`'s `DefaultLlmRouter` — provider selection, retry, fallback, cost ceilings — built provider-agnostic so a second provider could slot in. M2.8 (ADR-0064) added the OpenAI provider. But `architect-cli`'s `chat` command still constructed a single `AnthropicProvider` directly: the router and the second vendor existed but were unused at the one place a human actually talks to a model. ADR-0064 Q3 named the follow-up.

M2.8.5 wires the router into chat: when both vendor keys are present, chat routes through a `DefaultLlmRouter` (Anthropic primary, OpenAI fallback); flags let a user force a single vendor.

## Decision

Two small changes — narrow the chat engine's provider type, and build a router in the chat command.

### `chat.ts` — `CompletionProvider`

The chat engine only ever calls `provider.complete()`, and `LlmRouter.complete()` has the same signature as `LlmProvider.complete()`. So the engine's provider parameter is narrowed from `LlmProvider` to a structural `CompletionProvider = { complete(req): AsyncIterable<CompletionChunk> }`. Both a concrete provider (`AnthropicProvider` / `OpenAiProvider`) and a `DefaultLlmRouter` satisfy it — the chat substrate becomes provider- *or* router-agnostic with no adapter. The test stub (`LlmProvider`) and `RunContext.providerOverride` keep working unchanged.

### `commands.ts` — `buildChatProvider`

A new builder picks the completion source:

1. `providerOverride` (tests) wins.
2. `--provider anthropic` / `--provider openai` forces a single vendor (errors if its key is absent).
3. `--provider auto` (default): if **both** `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are set, build a `DefaultLlmRouter`; if only one key is set, use that single provider; if neither, error.

The router config: `providers = {anthropic, openai}`; a `TaskPolicyMap` mapping the text task kinds (`executor` — what chat uses — plus planner/summarizer/diff-narrator/classifier/rerank) to a `{primary: "anthropic/<model>", fallback: ["openai/<openai-model>"]}` chain, and `embedding` to `openai/text-embedding-3-small` (Anthropic can't embed); `getTenantResidency → "unrestricted"`. New flags: `--provider` (validated against `{auto, anthropic, openai}`) and `--openai-model` (default `gpt-4o`, validated via `isOpenAiChatModel`).

## Cross-cutting invariants enforced

- **Provider-agnostic chat.** The engine depends only on `complete()`; swapping a single provider for a router (or a future Bedrock/Vertex provider) needs no engine change. `CompletionProvider` is the seam.
- **The test seam is intact.** `providerOverride` short-circuits `buildChatProvider`, so CI runs offline with a stub exactly as before — every existing chat/commands test passes unchanged.
- **Graceful degradation.** Chat works with one key (single provider) or two (router with cross-vendor fallback); it only errors when *no* key is available. A user who has only OpenAI no longer hits the old "ANTHROPIC_API_KEY is not set" wall.
- **Explicit override beats auto.** `--provider openai` forces OpenAI even when both keys are present, so a user can pin a vendor regardless of env.
- **Real failover at the human boundary.** With both keys, an Anthropic rate-limit / overload during a chat turn now transparently falls over to OpenAI via the router's retry+fallback — the M6.5 behavior, finally exercised where it matters.

## Alternatives considered

- **Wrap the router in a full `LlmProvider` adapter (id/models/capabilities/pricing).**
  - **Considered.** Keep the engine's `LlmProvider` type and adapt the router to it.
  - **Decision.** Rejected — the engine uses only `complete()`, so a full adapter would be dead surface (placeholder capabilities/pricing). Narrowing to `CompletionProvider` is honest and smaller.
- **Always build the router (single-provider chains too).**
  - **Considered.** Uniform path.
  - **Decision.** Use a bare provider when only one key is present — no reason to pay the router's resolution/retry indirection for a one-element chain, and it keeps the single-vendor path identical to before.
- **Default to a vendor (e.g., always Anthropic) and require a flag to opt into the router.**
  - **Decision.** `auto` default that routes when both keys exist is the least-surprise behavior — a user who exports both keys gets fallback for free; one who exports one gets that one.
- **Add cost ceilings / latency tracking to the chat router now.**
  - **Decision.** Out of scope. The router supports them (M6.5); wiring `--cost-ceiling` into chat is a follow-up. M2.8.5 is about *using* the router, not configuring every knob.
- **A new `--fallback <ref>` flag for an arbitrary chain.**
  - **Decision.** Deferred. `--provider` + `--openai-model` cover the two-vendor case; an arbitrary multi-provider chain flag waits until a third provider lands.

## Consequences

- **55 packages + 1 app, 122 meta-schema tables, 6,108 tests** (was 55 / 122 / 6,101; +7 tests, 0 new packages/tables). `architect-cli` gains `@crossengin/ai-providers-openai` + `@crossengin/ai-router` deps.
- **The router is no longer shelf-ware.** The M6.5 router + the M2.8 OpenAI provider now do real work at the chat prompt — cross-vendor fallback, provider selection — instead of sitting unused.
- **Chat is multi-vendor.** `crossengin chat` with both keys routes Anthropic→OpenAI; `--provider openai` runs pure OpenAI; `--provider anthropic` pins Claude. One command, three postures.
- **Resilient chat.** An Anthropic outage mid-conversation falls over to OpenAI transparently (retry + fallback), so a chat session survives a single-vendor incident.
- **The abstraction paid off.** Narrowing to `CompletionProvider` means the next provider (Bedrock/Vertex) drops into the chain via `buildChatRouter` with zero engine changes.

## Open questions

- **Q1:** Should `--cost-ceiling` / per-tenant budgets be wired into the chat router?
  - _Current direction:_ Follow-up. The router enforces ceilings (M6.5); exposing `--cost-ceiling-usd` + a window flag on chat is a small addition once there's demand.
- **Q2:** Should the model flags accept provider-qualified refs (`--model openai/gpt-4o`) instead of separate `--model` / `--openai-model`?
  - _Current direction:_ Separate flags for now (clear, validated per-vendor). A unified `provider/model` ref parser can replace them when a third vendor makes the matrix unwieldy.
- **Q3:** Per-turn provider/cost attribution in the chat output?
  - _Current direction:_ The router tracks per-provider latency + the `usage_final.cost`; surfacing "this turn ran on OpenAI, $0.004" in the chat footer is a nice follow-up (the data is there).
- **Q4:** Should `embedding` tasks (RAG over the manifest) be exposed in chat?
  - _Current direction:_ The router's embedding policy points at OpenAI, but chat doesn't embed yet. A retrieval-augmented chat mode is a separate feature; the policy is ready for it.
