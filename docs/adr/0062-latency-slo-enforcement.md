# ADR-0062: Latency-target SLO enforcement (Phase 2 M8.6)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0060 (observability-runtime / availability burn), ADR-0061 (observability-runtime-pg), ADR-0037 (incident response), ADR-0045 (feature-flags runtime) |

## Context

M8 (ADR-0060) shipped availability-burn enforcement: a 5xx burst burns the error budget, declares an incident, pages, and rolls a flag back. M8's exit criterion was availability only. `@crossengin/observability`'s `SloLatencyTarget` — `{kind: "latency", endpointClass?, p50?, p95?, p99?, window}` with budgets like `"300ms"` / `"5s"` — stayed inert.

ADR-0060 had filed latency enforcement under M8.5, then ADR-0061 re-scoped it to **M8.6**, with the reasoning: latency enforcement is *pure compute* (compute percentiles, compare to budgets), so it belongs in `observability-runtime` next to availability burn — not in the `-pg` persistence package. This ADR delivers that.

Two design choices shaped the work:

1. **Latency rides the same outcome stream.** `RequestOutcome` already carries an optional `latencyMs`. The `RollingWindow` that counts successes/failures for availability is the natural place to also hold latency samples, so one `recordOutcome()` feeds both signals — no second ingest path.

2. **Keep availability untouched.** M8's `SloEnforcementEngine` and M8.5's `observability-runtime-pg` projector key on the availability `BurnRateVerdict`. Folding latency into that engine would change the `breach_opened` decision's `verdict` type and break the `-pg` projector. So latency gets its own pure evaluator and its own engine (`LatencySloEngine`) that *reuses the shared enforcement planners* — additive, zero changes to M8/M8.5 behavior.

## Decision

Three additions to `@crossengin/observability-runtime` (no new packages, no new META_ tables):

### `window.ts` — latency capture + percentiles (extended)

- `Sample` gains an optional `latencyMs`; `record()` stores it when the outcome carries one.
- `percentile(sortedAsc, p)` — nearest-rank, exported and unit-tested (null on empty, clamps p≤0 / p≥100).
- `RollingWindow.latencyStats(surface, windowMs, now)` → `{p50, p95, p99, count}` computed over latency-bearing samples inside the window. Samples without latency (or outside the window) are excluded from `count`.

### `latency.ts` — pure target evaluation (new)

- `parseLatencyBudgetMs("300ms" | "5s" | "1.5s")` → milliseconds (rejects bad units / non-positive).
- `LatencyThresholdSchema` + `DEFAULT_LATENCY_THRESHOLDS`: `latency-page` (≥2× budget → sev2) and `latency-ticket` (>1× budget → sev3), both `minSamples: 20`.
- `evaluateLatencyTarget(target, observed, thresholds)` → `LatencyVerdict`: for each declared percentile budget (p50/p95/p99) and each threshold, fires when `observedMs > budgetMs × multiplier` and `count ≥ minSamples`. Returns every breach plus the worst severity / threshold / percentile. Percentiles the target doesn't declare, or with no observed data, are skipped.

### `latency-engine.ts` — `LatencySloEngine` (new)

Mirrors `SloEnforcementEngine`: `recordOutcome()` + `evaluate(now)` → `LatencyEnforcementDecision[]` (`breach_opened` carrying a `LatencyVerdict` + `EnforcementPlan` / `breach_ongoing` / `recovered`). On a breach it reuses the shared planners from `enforcement.ts` — `planIncidentDeclaration` (category defaults to `performance`), `planPageDirective`, `planKillSwitchActivation` — and the same `formatIncidentId` / `formatKillSwitchId` minters. One incident per ongoing breach per surface (dedup via an `active` map), `recovered` when the percentile drops back under budget. Latency is sampled over a short `latencyWindow` (default `5m`), not the SLO's 30-day budget window — real-time breach detection wants a recent window.

## Cross-cutting invariants enforced

- **One outcome stream, two signals.** `recordOutcome({surface, outcome, at, latencyMs})` feeds availability counts and latency percentiles from the same sample. A deployment can share one `RollingWindow` between the availability and latency engines (both accept a `window` option).
- **Plans are valid by construction.** The latency engine builds incidents and kill switches through the same schema-`parse`-ing planners as availability, so every `LatencyEnforcementDecision.plan.incident` / `.killSwitch` passes its contract schema.
- **One incident per ongoing latency breach.** The `active` map dedups exactly like the availability engine; a still-breaching surface yields `breach_ongoing`, not a second `INC-`.
- **Minimum samples gate.** A percentile computed from `< minSamples` points cannot fire — low-traffic endpoints and cold starts don't page on a single slow request.
- **Determinism.** Same latency samples + same `FixedClock` ⇒ same severity, same percentile, same incident id. The engine test pins the instant and asserts exact sev2/sev3 outcomes.

## Alternatives considered

- **Extend `SloEnforcementEngine` to evaluate both signals.**
  - **Considered.** One engine, one `evaluate()`, decisions tagged with a `signal` field.
  - **Decision.** Rejected. The `breach_opened` decision carries `verdict: BurnRateVerdict`, which M8.5's `observability-runtime-pg` projector reads to write evaluation snapshots. A latency verdict has a different shape; tagging the union would either break the projector or force an awkward `verdict: BurnRateVerdict | LatencyVerdict`. A separate `LatencySloEngine` keeps M8/M8.5 byte-for-byte stable and the two verdict types cleanly apart.
- **Single latency threshold (just "over budget → alert").**
  - **Decision.** Two thresholds (ticket at 1×, page at 2×), mirroring the availability fast/slow split. A mild p95 regression opens a ticket; a 2× blowout pages. Operators can override with a custom threshold list.
- **Evaluate over the SLO's declared 30-day window.**
  - **Decision.** Evaluate over a short rolling `latencyWindow` (default 5m). The 30-day window is the *budget* horizon; real-time enforcement needs to react to a regression now, not to a month-long average. The budget-horizon view is a reporting concern, not an enforcement one.
- **Histogram / t-digest percentiles instead of exact nearest-rank.**
  - **Considered.** Bounded memory at high cardinality.
  - **Decision.** Exact nearest-rank over the in-window samples. The `RollingWindow` is already bounded by `maxSamplesPerSurface`; for the 5-minute enforcement window the sample count is small. A t-digest is a Phase 3 optimization if a surface's QPS makes exact sorting expensive.
- **Persist latency verdicts now.**
  - **Decision.** Deferred. M8.6 is pure, matching the ADR-0061 scoping. A latency projector for `observability-runtime-pg` (writing into `meta.slo_evaluations` with a signal discriminator, or a sibling table) is a clean follow-up once the enforcement shape is settled.

## Consequences

- **53 packages + 1 app, 121 meta-schema tables, 5,930 tests** (was 53 / 121 / 5,897; +33 tests, 0 new packages, 0 new tables). The latency story lands entirely inside the existing `observability-runtime` package.
- **The SLO loop now covers latency, not just availability.** A surface whose p95 crosses `2× budget` over 20+ samples in 5 minutes declares a `performance` SEV2, pages on-call, and (if a rollback is configured) flips the offending flag — the latency analogue of M8's 5xx exit criterion.
- **Availability and latency compose.** Wire both `SloEnforcementEngine` and `LatencySloEngine` over one shared `RollingWindow` and a single `recordOutcome()` fans out to both. They mint independent incidents (availability vs performance) for the same surface when both signals break.
- **No regression surface.** M8 and M8.5 are untouched; `observability-runtime-pg` continues to consume the availability `EnforcementDecision` exactly as before.
- **Latency persistence is the obvious next step.** When wanted, a `LatencySloEngine` wrapper in `observability-runtime-pg` projects latency decisions the same way the availability persisting engine does.

## Open questions

- **Q1:** Should latency decisions persist (M8.6.5)?
  - _Current direction:_ Not yet. The pure verdict is in hand; a projector into `meta.slo_evaluations` (with a `signal` column) or a `meta.slo_latency_evaluations` sibling is a small additive follow-up.
- **Q2:** Should `endpointClass` on the latency target drive different default budgets / thresholds?
  - _Current direction:_ `endpointClass` is carried but not yet consulted for threshold selection. A per-class default threshold map (read endpoints stricter than admin) can layer on without an interface change.
- **Q3:** What's the right default `latencyWindow`?
  - _Current direction:_ 5m. Long enough to accumulate `minSamples` on a moderately busy surface, short enough to react. Configurable per engine; per-SLO override is a future addition to `LatencyRegistration`.
- **Q4:** Should a sustained-duration requirement (like the alert contract's `sustainedFor`) gate latency paging?
  - _Current direction:_ The rolling window *is* the sustain mechanism — a percentile over 5m won't fire on one spike. An explicit multi-window confirm (like availability's long+short pair) can be added if flapping shows up in practice.
