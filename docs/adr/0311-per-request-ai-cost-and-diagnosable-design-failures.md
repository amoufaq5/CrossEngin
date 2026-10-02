# ADR-0311: A per-request AI cost ceiling, and design failures that say what went wrong

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-02 |
| **Authors** | amoufaq5 |
| **Reviewers** | amoufaq5 |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0267, ADR-0280, ADR-0306 |

## Context

Two open ends from the in-production AI Architect, both about a question the system could not answer:

**There was no per-request cost ceiling** (ADR-0267). The guard admitted or refused against a *monthly*
tenant budget. That bounds the bill and not the request: one pathological prompt — a pasted schema, a
retry loop that keeps appending history — could consume a month's budget in a single call, and the only
signal was the next request being refused. The monthly ceiling tells you afterwards.

**A weak model that drifts out of JSON failed indistinguishably from any other design failure**
(ADR-0280). ADR-0306 made the local provider the default, which makes this materially more likely: a 7B
model asked for a manifest returns prose, a fenced block, a top-level array, or valid JSON that is not a
manifest — and all four produced the same "design failed". An operator could not tell "your model is too
small" from "the manifest was invalid" from "the provider timed out", which are three different actions.

## Decision

**`estimateRequestCost` → `admitRequestCost`, consulted before the call.** `ArchitectGuardRuntime` takes
an optional `perRequestCeiling` and refuses pre-flight when the estimate exceeds it.

The estimate is honest about which half it knows:

- The **output** side is an upper bound *by construction*: `maxTokens` is enforced by the provider, not
  guessed. A request that declares no `maxTokens` yields an `unbounded` estimate, which a ceiling
  refuses rather than admits — there is no number to compare.
- The **input** side is a heuristic: `ESTIMATED_CHARS_PER_TOKEN = 3.5`, deliberately pessimistic (real
  tokenizers average nearer 3.7 on English prose plus JSON) **because the number feeds a ceiling**.
  Over-counting delays a request; under-counting admits one that should have been refused. The asymmetry
  decides the constant.

Two mechanisms keep the heuristic from staying wrong:

- **`reconcileRequestCost`** compares the actual against the estimate after the call and yields a
  `CostOverrunVerdict`. The worst observed ratio feeds back as `inflation` on the next estimate, so an
  estimator caught being optimistic for a session stays corrected for that session.
- **`StreamCostMeter`** meters a stream as it arrives and answers `continue` / `abort`, so a response
  that runs past its budget mid-stream is cut rather than paid for. A pre-flight ceiling cannot do this:
  the provider enforces `maxTokens`, but a provider that ignores it would otherwise bill freely.

**`classifyDesignOutput` diagnoses a failure along two independent axes.** `shape` is what the payload
*is* (`empty`, `no_json`, `truncated_json`, `malformed_json`, `array_not_object`, `scalar_not_object`,
`object_not_manifest`, `manifest_shaped_object`); `wrapper` is how it was *delivered* (`none`,
`code_fence`, `surrounding_prose`).

Keeping them apart is the decision. Collapsed into one enum, a fenced manifest and a fenced array land
in the same bucket — but the first is recoverable (strip the fence) and the second is not (the model
answered the wrong question). Split, the recovery is mechanical and the diagnosis is specific.

`isUnreadableDesignOutput` is the single predicate for "no amount of retrying this prompt will help",
which is what distinguishes a model problem from a prompt problem.

`looksLikeManifest` is overridable via `ClassifyDesignOutputOptions.recognize`, so a caller targeting a
different document is not forced through the manifest's shape.

## Alternatives considered

- **Option A (cost):** count tokens properly with the provider's tokenizer.
  - **Pros:** exact input counts; no heuristic and no inflation correction.
  - **Cons:** a tokenizer per provider, each a dependency with a vocabulary file, in a package whose
    entire value is being pure and offline. Anthropic's is not published as a library; OpenAI's is
    `tiktoken`, a native module. And a local OpenAI-compatible endpoint (ADR-0306) uses whatever
    tokenizer its model shipped with, which we cannot know.
  - **Why not:** the dependency cost is real and the benefit is bounded — the estimate feeds a ceiling,
    and a pessimistic bound is a correct ceiling. The reconciliation loop closes the gap that matters.

- **Option B (cost):** rely on the monthly ceiling alone and refuse after the fact.
  - **Pros:** no estimation at all; the number is exact because it is the actual.
  - **Cons:** this was the state, and the failure is a single request eating the month.
  - **Why not:** a budget you can only discover you have exceeded is a bill, not a control.

- **Option C (cost):** make the per-request ceiling mandatory with a default.
  - **Pros:** the protection is on everywhere; nobody forgets it.
  - **Cons:** a wrong per-request ceiling refuses *legitimate* designs, and a large manifest is a
    legitimately large request. The monthly ceiling never does that — it only ever fires after real
    spend.
  - **Why not:** opt-in. The monthly ceiling always applies and is the one that cannot be wrong in a
    harmful direction; the per-request one is for a deployment that knows its own request shape.

- **Option D (diagnosis):** one flat `DesignFailureReason` enum.
  - **Pros:** one axis, one switch, fewer combinations to test.
  - **Cons:** `shape × wrapper` is 24 combinations expressed as 11 values; flattened it is either an
    8-value enum that loses the wrapper (and with it the mechanical recovery) or a 24-value enum nobody
    can hold in their head.
  - **Why not:** the two axes are genuinely independent, and the pair is what makes the response
    actionable.

- **Option E (diagnosis):** retry with a stricter prompt and only report a failure after N attempts.
  - **Pros:** recovers from transient drift without bothering anyone.
  - **Cons:** it spends the budget this ADR's other half exists to bound, and for an
    `isUnreadableDesignOutput` shape every retry is certain to fail the same way.
  - **Why not:** the diagnosis is the precondition for retrying *selectively*. Retrying blindly is what
    makes the per-request ceiling necessary.

## Consequences

- **Positive:** one prompt can no longer consume a month's budget. A design failure names what the model
  produced, so "use a bigger model" and "your description was ambiguous" are distinguishable — which is
  the whole operational difference ADR-0306 created a need for.
- **Negative:** the input estimate is a heuristic and will sometimes refuse a request that would have
  fit. `ESTIMATED_CHARS_PER_TOKEN` is one constant for every model and every language — it is notably
  wrong for CJK text, where it under-counts, which is the dangerous direction.
- **Neutral:** `StreamCostMeter` only helps a streaming call; a non-streaming request is bounded by
  `maxTokens` alone.
- **Reversibility:** both are additive and opt-in. The ceiling is a constructor option with no default;
  the classifier is a pure function nothing is obliged to call.

## Implementation notes

- `packages/ai-architect-runtime/src/request-cost.ts`, `design-output.ts`. Both pure: no clock, no
  network, pricing injected as `ProviderPricing`.
- `ArchitectGuardRuntime.perRequestCeiling` is consulted only when `request.request !== undefined`, so a
  caller that does not describe its request gets the monthly check alone rather than a spurious refusal.
- Wired as `--ai-max-request-dollars <n>` on `operate-server`, off unless set; it does not replace
  `--ai-max-usd-per-month`, which still applies.
- `ESTIMATED_CHARS_PER_TOKEN` is pessimistic *for the ceiling's direction*; the comment states why, so a
  future reader does not "correct" it to 3.7 and silently loosen the control.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| `ESTIMATED_CHARS_PER_TOKEN` under-counts for CJK, which is the unsafe direction. Per-locale constants, or a per-provider override? | amoufaq5 | _unscheduled_ |
| `classifyDesignOutput` diagnoses but nothing yet retries selectively on a recoverable `wrapper`. | amoufaq5 | _unscheduled_ |
| `reconcileRequestCost`'s inflation is per session and not persisted, so a restart forgets that the estimator was optimistic. | amoufaq5 | _unscheduled_ |

## References

- ADR-0267 (monthly ceiling; per-request named as an open end), ADR-0280 (a weak model's drift being
  indistinguishable), ADR-0306 (the local provider as the default, which made it likely).
