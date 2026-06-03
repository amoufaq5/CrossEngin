# ADR-0073: Per-turn provider + cost attribution in chat (Phase 2 M2.8.6)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0072 (multi-vendor router in chat), ADR-0059 (ai-router), ADR-0054 (architect-cli chat mode) |

## Context

M2.8.5 (ADR-0072) wired the multi-vendor `DefaultLlmRouter` into chat: with both keys set, a turn routes Anthropic→OpenAI with transparent fallback. The chat footer already showed per-turn cost (`usage_final.cost` via `formatUsageLine`). But it didn't show **which provider actually served the turn** — and with a router that can fall back mid-conversation, "did this turn run on Anthropic or OpenAI?" is exactly what an operator wants to see. The router knew (it picked the provider) but didn't surface it; the chunk stream carries cost but not provider identity.

M2.8.6 closes that: the router reports the resolved provider per `complete()` via an observer, and chat appends `via <provider>/<model>` to the per-turn footer.

## Decision

Two additive changes — a router observer, and a chat footer label.

### `@crossengin/ai-router` — `onResolved` observer

`DefaultLlmRouterOptions` gains an optional `onResolved?: (resolution: RouterResolution) => void`, invoked **once per successful `complete()`** with the provider that actually served it:

```ts
interface RouterResolution {
  task: TaskKind;
  providerId: string;
  modelId: string | null;
  latencyMs: number;
  fallbackDepth: number; // 0 = primary served; >0 = that many fallbacks were used
}
```

It fires after the cost/latency is recorded and before the buffered chunks are yielded, so the resolution is known by the time the consumer drains the stream. It does **not** fire when all providers are exhausted (`AllProvidersExhaustedError`), since no provider served the call. No change to the `CompletionChunk` contract or the `LlmProvider` interface — the observer is a side channel on the router.

### `architect-cli` — `via <provider>` in the footer

- `buildChatProvider` now returns `describeLastTurn: () => string | null` alongside the provider. For a single provider it's a static `anthropic/<model>` / `openai/<model>`; for the router it closes over a mutable `lastResolution` updated by `onResolved`, formatting `providerId/modelId` plus ` (fallback)` when `fallbackDepth > 0`; for a `providerOverride` (tests) it returns `null`.
- `formatUsageLine(usage, providerLabel?)` appends `via <label>` when a non-empty label is supplied.
- The label is threaded `runChat → ChatReplOptions.providerLabel → ChatExchangeOptions.providerLabel`, evaluated when the per-turn human footer prints — so it reflects the provider that served *that* turn.

## Cross-cutting invariants enforced

- **Attribution reflects the actual turn.** `onResolved` fires during the turn's `complete()`, so when the footer prints, the label is the provider that just served — including OpenAI when a router fell back from a rate-limited Anthropic.
- **No contract churn.** The chunk union and `LlmProvider` interface are untouched; provider identity rides an opt-in router observer, not the data stream. Consumers that don't pass `onResolved` are unaffected.
- **Fallback is visible.** `fallbackDepth > 0` surfaces as `(fallback)` in the label, so a degraded primary is obvious at the prompt, not buried in logs.
- **JSON mode is unchanged.** The label is human-footer-only; `--format=json` (the NDJSON chunk stream) is byte-identical. The `usage_final` chunk still carries the canonical cost.
- **Offline-safe.** `providerOverride` returns a `null` label, so stub-backed CI tests print no `via` and assert on cost exactly as before.

## Alternatives considered

- **Add `provider`/`model` to the `usage_final` chunk.**
  - **Considered.** The most direct attribution path.
  - **Decision.** Rejected — it changes the `CompletionChunk` contract in `@crossengin/ai-providers` and forces every provider to populate it, for a CLI-footer feature. The router observer is a smaller, opt-in side channel; the provider already self-reports nothing about routing (it doesn't know it's behind a router).
- **Read the router's `latencyTracker` for the last provider.**
  - **Decision.** No — the tracker is aggregate per-provider, not per-call, and is racy under concurrency. An explicit per-call observer is unambiguous.
- **Expose attribution only in `--format=json`.**
  - **Decision.** The human footer is where a person reads it; JSON consumers can compute cost from `usage_final` and don't need a synthesized label. Keeping JSON untouched avoids changing a machine-read format.
- **Always build the router (so single-provider turns also report via the observer).**
  - **Decision.** Single providers use a static label (no router indirection, per ADR-0072). The static `anthropic/<model>` is accurate without the observer.

## Consequences

- **55 packages + 1 app, 122 meta-schema tables, 6,115 tests** (was 55 / 122 / 6,108; +7 tests, 0 new packages/tables). Chat now answers "what served this turn, and what did it cost?" in one footer line.
- **Routing is observable at the prompt.** `[tokens in=… out=… cost=$… via openai/gpt-4o (fallback)]` tells an operator, mid-conversation, that Anthropic was unavailable and OpenAI picked up the turn — the M2.8.5 failover made visible.
- **The observer is reusable.** `onResolved` is a general router hook; an observability sink (per-tenant provider mix, fallback rate) can consume it beyond the CLI.
- **Cost was already there; provenance completes it.** The footer now pairs the existing per-turn cost with its provider, so a session's spend is attributable per vendor at a glance.

## Open questions

- **Q1:** Should the session-end summary aggregate cost *per provider* (e.g., "$0.03 Anthropic, $0.01 OpenAI")?
  - _Current direction:_ Follow-up. `onResolved` carries enough to bucket per-provider cost; the session summary can split the aggregate once there's demand.
- **Q2:** Surface `latencyMs` in the footer too?
  - _Current direction:_ Available in `RouterResolution`; left out of the footer for brevity. A `--verbose` chat mode could include it.
- **Q3:** Should `fallbackDepth > 0` also emit a warning line (not just a label suffix)?
  - _Current direction:_ Label suffix only for now. A persistent fallback (primary down for the whole session) could warrant a one-time notice; deferred.
- **Q4:** JSON-mode attribution for programmatic consumers?
  - _Current direction:_ Not yet — they have `usage_final.cost`. If a consumer needs provider provenance, a synthesized `resolution` NDJSON line (from `onResolved`) is a clean addition.
