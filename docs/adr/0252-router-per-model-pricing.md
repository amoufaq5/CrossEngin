# ADR-0252: Per-model pricing for router cost estimates

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-26 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0248 (embed-path ceiling — Q1 is this), ADR-0157/0154 (ceiling resolution + attribution), ADR-0137 (per-tenant ceiling) |

## Context

ADR-0248 (M6.8.x.trace.embed) added cost-ceiling enforcement to `embed()` with a
preflight estimate `estimateEmbedPreflightCost = ceil(Σ len(texts)/4) ×
inputPerMillionTokens / 1e6`, reading `choice.provider.pricing`. But
`LlmProvider.pricing` is a **single per-provider** `ProviderPricing` — and the
real providers set it from their *default chat model* (OpenAI from
`OPENAI_CHAT_PRICING[defaultChatModel]`, Bedrock from
`BEDROCK_CHAT_PRICING[defaultModel]`). A provider serves many models at very
different prices:

- OpenAI: `text-embedding-3-small` $0.02/M vs `text-embedding-3-large` $0.13/M;
  the default chat model `gpt-4o-mini` is $0.15/M.
- Bedrock: Titan v2 $0.02/M vs Cohere $0.10/M; the default Claude chat model is
  dollars-per-million.

So the embed estimate used the **wrong basis** — typically a large
over-estimate (e.g. 7.5× for OpenAI, 100×+ for Bedrock), making the ceiling more
conservative than reality. ADR-0248 Q1: "per-model embedding pricing for the
estimate." The same gap exists on `complete()` — `estimatePreflightCost` uses the
provider default, so routing a cheap task to `gpt-4o-mini` while the provider
default is `gpt-4o` over-estimates.

## Decision

Add per-model pricing as a **general, optional** capability on `LlmProvider`,
motivated by the embed Q but applied to both estimates.

1. **`LlmProvider.pricingFor?(modelId): ProviderPricing | undefined`** — returns
   the model's rate, or `undefined` for models unknown to the provider (callers
   fall back to the provider-level `pricing`). Optional, so existing / mock /
   third-party providers without it keep working.

2. **Real providers implement it from their existing per-model tables** — the
   data already lived internally; `pricingFor` just surfaces it:
   - OpenAI: `OPENAI_CHAT_PRICING` (input/output/cached) + `OPENAI_EMBEDDING_PRICING`.
   - Bedrock: `BEDROCK_CHAT_PRICING` + `BEDROCK_EMBEDDING_PRICING` +
     `BEDROCK_MULTIMODAL_EMBEDDING_PRICING` (the multimodal model maps its
     `textUsdPerMillion`; the per-image component isn't representable in
     `ProviderPricing` and the preflight estimate is text-input-based).
   - Anthropic: `ANTHROPIC_PRICING` (chat-only).
   Embedding models return `outputPerMillionTokens: 0` (no output).

3. **Router uses it in both estimates** —
   `choice.provider.pricingFor?.(choice.modelId) ?? choice.provider.pricing` in
   `estimateEmbedPreflightCost` (the goal) **and** `estimatePreflightCost`
   (consistency — using accurate per-model rates for embed but the stale
   provider default for chat would be a half-measure; the change is one
   fallback-safe line).

4. **`MockLlmProvider`** gains an optional `modelPricing` map + `pricingFor`, so
   test harnesses can exercise per-model estimation.

## Alternatives considered

- **A per-model pricing registry inside `ai-router`** (hard-code the rates).
  - **Why not:** duplicates each provider's pricing table and drifts; the
    provider owns its pricing.

- **Make `LlmProvider.pricing` itself per-model** (`Record<model, …>`).
  - **Why not:** a breaking change to a widely-implemented field; the optional
    method is additive + backward-compatible.

- **Embed-only (leave `complete()` on the provider default).**
  - **Why not:** `pricingFor` is general; once per-model rates are available,
    using them for embed but not chat is inconsistent. The wiring is the same
    fallback-safe one-liner. (`complete()` accuracy is a bonus; the embed
    estimate is the ADR-0248 Q1 goal.)

- **Prefer `req.model` over `choice.modelId` for the lookup.**
  - **Why not (now):** `choice.modelId` is the routed model the estimate already
    keys on; a per-request `model` override is niche. Left as a future Q.

- **Require `pricingFor` on the interface.**
  - **Why not:** would force every `LlmProvider` (incl. mocks / third-party) to
    implement it; optional + `?? pricing` fallback is non-breaking.

## Consequences

- **Positive:** embed ceiling estimates use the chosen embedding model's real
  rate (`text-embedding-3-small` $0.02/M, not the $0.15/M chat default — 7.5×
  tighter; Bedrock Titan vs a Claude default is 100×+). `complete()` estimates
  use the routed chat model's rate. The real cost is still recorded post-call
  from `usage_final` — this only sharpens the *preflight* estimate.
- **Neutral:** backward-compatible — providers / mocks without `pricingFor` fall
  back to `.pricing`, so every existing router test is unchanged. Test count
  9,415 → **9,427** (+12: router +2, openai +3, bedrock +4, anthropic +1,
  mock +2).
- **Negative:** one more optional method on the `LlmProvider` contract (a third-
  party provider gets no per-model accuracy until it implements it — but it
  still works via fallback).
- **Reversibility:** trivial — drop the method + revert the two router lines to
  `choice.provider.pricing`.

## Implementation notes

- `pricingFor` is pure (no I/O) — a table lookup mapping the provider's internal
  `*UsdPerMillion` fields to the `ProviderPricing` shape.
- The multimodal-embedding model maps `textUsdPerMillion` → `inputPerMillionTokens`;
  the per-image cost is out of band for a token-based estimate.
- Cross-package `tsc` resolves `@crossengin/ai-providers` via its built `dist`, so
  `pnpm -r typecheck` must run after a build (the CI workflow builds first; a bare
  `pnpm -r typecheck` against a stale dist will report the new method missing).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Prefer `req.model` over `choice.modelId` for the rate lookup when the request overrides the routed model | platform | _deferred_ |
| Surface the estimate basis (model + per-million rate) in the `ceiling_resolved` trace attributes | platform | _deferred_ |
| Expose a typed per-model pricing map on `LlmProvider` for bulk consumers (dashboards) | platform | _deferred_ |

## References

- ADR-0248 — embed-path ceiling enforcement (Q1 is this per-model pricing).
- `packages/ai-providers/src/provider.ts` (`pricingFor`), `…/mock.ts`,
  `packages/ai-providers-openai|bedrock|anthropic/src/provider.ts`,
  `packages/ai-router/src/router.ts` (both estimate methods).
