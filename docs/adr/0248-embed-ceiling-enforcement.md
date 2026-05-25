# ADR-0248: Cost-ceiling enforcement on the embed() path

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-25 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0157 (`ceiling_resolved`, future Q1), ADR-0152 (embed instrumentation), ADR-0135/0137 (cost ceilings) |

## Context

ADR-0135/0137 gave `DefaultLlmRouter` cost-ceiling enforcement (per-request,
per-tenant, tier, global) via `enforceCeilingPreflight`, and ADR-0157 added the
`ceiling_resolved` instrumentation event emitted from it (before the check, so
the audit trail records the resolution even when a request is blocked). Both are
wired into `complete()` only. ADR-0157 explicitly flagged the gap as future Q1:
**`embed()` does not call `enforceCeilingPreflight`** — so embeddings (a) bypass
cost ceilings entirely and (b) emit no `ceiling_resolved` audit event.

That gap matters. Embeddings are cheap per call but high-volume (RAG ingest,
semantic search, re-indexing); a tenant at its budget ceiling for `complete()`
can still run unbounded embedding spend, and operators auditing "why was this
tenant blocked / what ceiling applied" see nothing for the embed path. ADR-0152
already added `embed_call_started/completed/failed` instrumentation, so the embed
path is observable — it just isn't gated.

## Decision

Enforce ceilings on `embed()` exactly as on `complete()`.

1. **Generalize `enforceCeilingPreflight`.** It only ever used `tenantId`,
   `sessionId`, and `task` from the `CompletionRequest`. Change its first
   parameter from `CompletionRequest` to a context object
   `{ tenantId: string; sessionId: string; task: TaskKind }`. Same body: resolve
   the effective ceiling, emit `ceiling_resolved` (even when `source: "none"`),
   then `checkCeiling` and throw `CostCeilingExceededError` on breach.

2. **Wire it into `embed()`.** After `chooseProviders("embedding", …)` and
   before the attempt loop, call `enforceCeilingPreflight({ tenantId,
   sessionId: req.sessionId ?? "", task: "embedding" }, choices[0], estimate)`.
   `resolveProviders` throws `ProviderResolutionError` on an empty result, so
   `choices[0]` is always present (same as `complete()`) — no guard needed.

3. **`estimateEmbedPreflightCost`.** Embeddings are priced on input tokens only
   (no output), so estimate `ceil(Σ len(texts)/4) × inputPerMillionTokens / 1e6`
   — the complete() estimate minus the output term. The real cost is recorded
   post-call from `usage_final` (unchanged).

Wire ordering on a blocked embed: `ceiling_resolved` only (then the throw — no
`embed_call_started`). On an allowed embed: `ceiling_resolved` →
`embed_call_started` → `embed_call_completed`, mirroring complete()'s
`ceiling_resolved` → `llm_call_started` → `llm_call_completed`.

## Alternatives considered

- **A parallel `enforceEmbedCeilingPreflight`.**
  - **Cons:** duplicates the resolve + emit + check logic; drift risk.
  - **Why not:** the method is request-shape-agnostic; generalizing to a context
    object is DRY and keeps complete/embed in lockstep.

- **Reuse the complete() estimator (with an output term) for embed.**
  - **Cons:** embeddings have no output tokens; an output term overestimates.
  - **Why not:** input-only is correct; the estimate is approximate anyway (real
    cost comes from `usage_final`).

- **Enforce per-provider inside the embed attempt loop.**
  - **Cons:** the ceiling is a tenant/cost concept, not provider-specific;
    re-checking per fallback would emit duplicate `ceiling_resolved` events.
  - **Why not:** once, before the loop — matches complete().

- **Leave embed unenforced (status quo).**
  - **Why not:** that is the gap; high-volume embedding spend must respect the
    same budget as completions.

- **Guard `choices.length > 0` before the preflight in embed.**
  - **Why not:** `resolveProviders` already throws on empty, so it's unreachable;
    a guard would be dead code (and complete() doesn't have one).

## Consequences

- **Positive:** embeddings now respect per-request / per-tenant / tier / global
  ceilings and emit `ceiling_resolved` — symmetric with `complete()`; ADR-0157
  Q1 closed.
- **Negative:** `enforceCeilingPreflight`'s signature changed (private method —
  no external surface); one existing embed test updated for the new leading
  `ceiling_resolved` event.
- **Neutral:** complete() and embed() share the preflight + the
  resolve/emit/check path; the embed estimate is approximate (provider-level
  pricing, same as complete()).
- **Reversibility:** trivial — drop the `embed()` preflight call.

## Implementation notes

- `packages/ai-router/src/router.ts`: `enforceCeilingPreflight(ctx, choice,
  estimatedCostUsd)`; `complete()` passes `{ tenantId, sessionId, task }` from
  the request; `embed()` passes `{ tenantId, sessionId: req.sessionId ?? "",
  task: "embedding" }`. New private `estimateEmbedPreflightCost`.
- Tests (`router.test.ts`): new "embed — cost ceiling (ADR-0248)" block (6) —
  blocks over `maxUsdPerRequest`, allows under, honors per-tenant ceiling,
  `ceiling_resolved` precedes `embed_call_started`, `source: "none"` emitted
  with no ceiling (still embeds), no `embed_call_started` when blocked. The
  embed happy-path instrumentation test now expects a leading `ceiling_resolved`.
  Test count 9,394 → 9,400 (+6).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Per-model embedding pricing for the estimate (router uses provider-level pricing today) | platform | _deferred_ |
| Expose the embed preflight estimate via a dry-run / `--explain`-style path | platform | _deferred_ |
| Tokenizer-accurate input estimate vs. `chars/4` heuristic | platform | _deferred_ |

## References

- ADR-0157 — `ceiling_resolved` (this closes its future Q1).
- ADR-0152 — embed instrumentation. ADR-0135/0137 — cost ceilings.
- `packages/ai-router/src/router.ts`.
