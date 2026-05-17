# ADR-0061: Architect CLI router integration (Phase 2 M6.5.5)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-17 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0053 (Anthropic provider), ADR-0059 (ai-router), ADR-0060 (OpenAI provider), ADR-0054 (chat mode) |

## Context

M5.5 wired `architect-cli`'s `chat` subcommand directly to `AnthropicProvider`. M2.7 made that real. M6.5 shipped the router. M2.8 shipped the OpenAI provider. The CLI never picked them up — it still hard-coded an Anthropic-only path with strict `isAnthropicModel` validation. Two things needed to change:

1. **Adaptive provider construction.** The CLI should support either or both API keys. With one key set, it builds a single provider (matching the M5.5 behavior). With both, it builds a router that fans out across them.
2. **Multi-provider model validation.** `--model=gpt-4o-mini` should work when `OPENAI_API_KEY` is set; `--model=claude-opus-4-7` should work when `ANTHROPIC_API_KEY` is set. The old check rejected anything that wasn't Claude.

Constraint shaping the design: **don't break the existing test suite**. The chat engine takes an `LlmProvider`; tests inject stub providers via `RunContext.providerOverride`. The router has a different shape (`LlmRouter` interface). Adapting requires wrapping the router back into an `LlmProvider`-shaped interface so the rest of the chat code is unchanged.

## Decision

New module `apps/architect-cli/src/router-setup.ts` plus minimal `commands.ts` rewiring.

### `router-setup.ts` — three exports

**`DEFAULT_TASK_POLICIES: TaskPolicyMap`** — the seven task kinds (`planner`, `executor`, `summarizer`, `diff-narrator`, `embedding`, `rerank`, `classifier`) mapped to primary + fallback model references:

- `planner` → Claude Opus → Claude Sonnet → GPT-4o (hard reasoning, premium chain)
- `executor` → Claude Sonnet → GPT-4o-mini (default chat; high-quality primary, cheap fallback)
- `summarizer` → GPT-4o-mini → Claude Haiku (cheap primary, cheap fallback)
- `diff-narrator` → Claude Haiku → GPT-4o-mini (cheap, prose-friendly)
- `embedding` → text-embedding-3-small (OpenAI only; Anthropic has no embeddings)
- `rerank` → Claude Haiku → GPT-4o-mini
- `classifier` → GPT-4o-mini → Claude Haiku

Operators override this at deploy time when they have stronger preferences.

**`buildChatCompleter({env, forceModel?, costCeiling?})`** — the decision tree:

1. Read `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from env. Construct an `AnthropicProvider` for whichever keys are set; same for `OpenAIProvider`.
2. If `forceModel` is supplied AND matches a known model for that provider, use it as the provider's `defaultModel` / `defaultChatModel`.
3. If **zero** providers configured → throw `NoProvidersConfiguredError` (the CLI exits 1 with a friendly message naming both env vars).
4. If **one** provider configured → return `{provider, providerKind: "single", availableProviders: [id]}`. No router; the CLI behaves like M5.5.
5. If **two+** providers configured → build a `DefaultLlmRouter` with `DEFAULT_TASK_POLICIES` filtered down to only reference available providers (so a chain entry like `openai/gpt-4o-mini` is dropped if OPENAI_API_KEY isn't set). Wrap the router in a `RouterAsProvider` adapter that exposes the `LlmProvider` interface; return `{provider, providerKind: "router", availableProviders: [...]}`.

**`RouterAsProvider`** — a thin adapter implementing `LlmProvider`:
- `id = "router"`, `models = union of all sub-provider models`.
- `capabilities = boolean OR across sub-providers` (any-true wins for chat/streaming/toolUse/jsonMode/embedding/supportsThinking; max() for maxContextTokens).
- `residency = union of regions`.
- `pricing = first provider's pricing` (the router's per-call pricing depends on which provider it actually picks, which is decided at request time; the static `pricing` field is a placeholder the chat engine doesn't use).
- `complete(req)` → delegates to `router.complete(req)`.
- `embed(req)` → delegates to `router.embed(req)`.

### `commands.ts.runChat` rewiring

1. Remove strict `isAnthropicModel` check. `--model` is now an opaque string passed through to `buildChatCompleter` as `forceModel`.
2. After provider construction, validate `model ∈ provider.models` (where `provider.models` is the union for the router case). Reject with exit 2 if the model isn't available in any configured provider.
3. New flag `--cost-ceiling-usd <N>` — parses to `{maxUsdPerRequest: N}` (passed only to the router; ignored for single-provider runs since cost ceilings live in the router today).
4. Session-end summary now includes `providerKind` ("single" or "router") + `availableProviders` so operators see whether the run fanned out.
5. Friendly error when no provider keys are set names both env vars (was Anthropic-only).

`RunContext.providerOverride` keeps existing test-inject semantics. When set, the test path bypasses `buildChatCompleter` entirely.

## Cross-cutting invariants enforced

- **One key works; two keys fan out.** The decision is purely env-driven. No `--enable-router` flag — if both keys are present, the router is used; otherwise direct.
- **Model validation against actual capabilities.** `--model=gpt-4o` with only `ANTHROPIC_API_KEY` set → exit 2. With `OPENAI_API_KEY` also set, the model resolves through the router. The error message lists the available model union so the developer sees what's possible right now.
- **Tests stay offline.** All 162 architect-cli tests run without an API key. `providerOverride` short-circuits provider construction; the router-setup module is exercised by its own tests with non-empty stub keys (no fetch ever fires because the test only inspects the constructed object, never calls `complete()`).
- **`DEFAULT_TASK_POLICIES` is filtered per request.** A chain entry referencing a provider that isn't configured is silently dropped — the resolver in `@crossengin/ai-router` already does this, but `buildChatCompleter` also pre-filters at construction time so the router never sees stale references.
- **Cost ceilings are router-only.** Single-provider mode skips the router entirely — there's no place to enforce a ceiling without re-implementing it locally. If a developer needs cost limits with a single key, they set both `--cost-ceiling-usd` AND a second key (even a placeholder); the router activates and enforces. Alternative: add a single-provider `CostGuardProvider` wrapper. Out of scope for M6.5.5.

## Alternatives considered

- **Always construct a router, even with one provider.**
  - **Pros.** Uniform code path. Cost ceilings work everywhere. Latency tracking applies.
  - **Cons.** The router adds non-trivial overhead (resolution + retry orchestration) for a case where there's nothing to route. The chunk-buffering retry semantics also reshape the stream slightly. Single-provider mode benefits from being a pass-through.
  - **Decision.** Branch on provider count. The router activates only when it has something to route between.

- **Move `RouterAsProvider` into `@crossengin/ai-router` so other consumers can reuse it.**
  - **Considered.** A web app would want the same adapter.
  - **Decision.** Keep it CLI-local for M6.5.5. Promote to `ai-router` when a second consumer arrives.

- **Use a JSON file (e.g., `~/.crossengin/router.json`) instead of env vars + flags.**
  - **Considered.** Config files are nicer for long task-policy declarations.
  - **Decision.** Env vars + flags only for M6.5.5. Config file support is a deploy concern; the CLI is a dev tool that runs in shells where env vars are the native idiom.

- **Validate `--model` against the union of ALL known provider models, not just the configured ones.**
  - **Considered.** `--model=gpt-4o-mini` should suggest "set OPENAI_API_KEY" instead of "model not available".
  - **Decision.** Currently the error lists `provider.models` (only configured providers' models). A future polish pass could detect "model exists but in an unconfigured provider" and emit a more specific hint.

- **Add `--task <kind>` to override the task kind.**
  - **Considered.** Useful for testing summarizer routing without a real RAG pipeline.
  - **Decision.** Defer. The chat engine always sets `task: "executor"`. A future M6.5.6 can add `--task` once there's a real use case beyond testing.

- **Make `--cost-ceiling-usd` apply to single-provider mode too.**
  - **Considered.** Build a `CostGuardProvider` wrapper that pre-flights estimates before forwarding to the wrapped provider.
  - **Decision.** Out of scope. The router's value composition is already the right shape; replicating it in single-provider mode would duplicate the math. Operators who want ceilings configure two providers.

## Consequences

- **The CLI is now usable with either or both providers.** A developer with only OpenAI can run `OPENAI_API_KEY=... crossengin chat` without setting up an Anthropic account. A developer with both keys sees the router fan out automatically.
- **+14 tests (5,842 → 5,856).** 10 in `router-setup.test.ts` covering policy invariants + provider construction across the four key-combination cases + model threading + union model lists. 4 in `commands.test.ts` updates covering missing-keys error, Claude model acceptance, cost-ceiling validation (good + bad).
- **Session summary now exposes routing.** `--format=json` includes `providerKind` and `availableProviders`. Human mode prints `(router over anthropic + openai)` after the turn count when applicable. Operators can grep audit logs for which sessions used routing.
- **Pattern set for future provider additions.** Bedrock, Vertex, local Llama all just get an `if (env[X_API_KEY])` branch in `buildChatCompleter` plus an entry in `DEFAULT_TASK_POLICIES`. No structural changes needed.
- **The CLI now exercises every M2 / M6 / M7 milestone end-to-end.** A developer running `OPENAI_API_KEY=... ANTHROPIC_API_KEY=... crossengin chat --persist --allow-file-write --cost-ceiling-usd=0.10` exercises: M2.7 (Anthropic) + M2.8 (OpenAI) + M5.5 (chat) + M5.6 (tools) + M5.7 (persistence) + M5.8 (write approval) + M6.5 (router) + M6.5.5 (this milestone) in one session.

## Open questions

- **Q1:** Should `--cost-ceiling-usd` accept a per-window form (e.g., `--cost-ceiling-usd-per-day=5`)?
  - _Current direction:_ Not in M6.5.5. Per-window ceilings are operationally interesting but rarely useful for one-shot CLI runs. Defer.
- **Q2:** How does the CLI surface which provider the router actually picked for a given turn?
  - _Current direction:_ It doesn't. The chat engine sees one `provider.complete()` call; the router decides internally. M6.5.6 can extend `runChatExchange` to surface the chosen provider per turn for observability.
- **Q3:** Should single-provider mode support cost ceilings via a local wrapper?
  - _Current direction:_ Documented as a follow-up. Operators today configure two providers (or set `OPENAI_API_KEY=placeholder` to activate the router) to get ceilings.
- **Q4:** What happens if `DEFAULT_TASK_POLICIES` references a model that's not in the provider's model list (e.g., Anthropic adds a new model and the pin goes stale)?
  - _Current direction:_ The resolver in `@crossengin/ai-router` doesn't validate model names against `provider.models` — it just passes the model string through to the provider. If Anthropic doesn't recognize the model, the provider's local model check rejects with `invalid_request_error`. The router falls back to the next chain entry. Self-healing.
