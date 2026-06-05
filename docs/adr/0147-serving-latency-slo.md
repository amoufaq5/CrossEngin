# ADR-0147: serving-latency SLO in operate-server (Phase 3 P2.38)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-05 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0141 (operate-server SLO incidents), ADR-0062 (latency-target SLO enforcement in observability-runtime), ADR-0140 (incident-response-pg package), ADR-0060 (observability-runtime SLO loop), ADR-0087 (apps/operate-server), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.38).

## Context

P2.32 (ADR-0141) made `apps/operate-server` the second consumer of
`@crossengin/incident-response-pg` — the serving app runs the M8
availability `SloEnforcementEngine` over its request stream and persists
declared burn-rate incidents through the shared sink. But the M8.6 sibling
`LatencySloEngine` (ADR-0062) — which rides the same `recordOutcome()`
stream and fires a `performance` incident on a percentile-budget breach —
was unwired. So a serving latency regression would silently miss the
incident path while a 5xx burst would not.

P2.38 closes that asymmetry: the serving monitor now holds **both**
engines, every request feeds both, and a sweep evaluates both. A
performance-budget breach declares its own `performance` incident through
the same `PostgresIncidentSink` the availability path already uses — so a
latency regression and a 5xx burst share one incident lifecycle.

## Decision

- **`slo-incidents.ts`**.
  - **`buildServingLatencyEngine(opts)`** mirrors `buildServingSloEngine`:
    one `LatencySloEngine` over one latency SLO (default surface
    `operate-server`, p95 ≤ 300ms / 30d, the same P1 page route, the same
    UUID system actor). `p95Budget` is parsed via the runtime's
    `parseLatencyBudgetMs` at build time — `'5s'` / `'1500ms'` / etc.
    work, garbage rejects with a clear error.
  - **`OperateSloMonitor` extension.** `OperateSloMonitorOptions` gained
    an optional `latencyEngine: LatencyEngineLike` (a structural slice of
    the runtime's `LatencySloEngine`, so a fake satisfies it for offline
    tests). `recordRequest` now feeds **both** engines (the latency engine
    consumes the same `RequestOutcome` — `latencyMs` is already on it).
    `sweep` evaluates the availability engine first then the latency
    engine when wired; each `breach_opened` decision's `plan.incident` is
    persisted as-is (the runtime already stamps the incident's `category`
    — `availability` from the burn-rate engine, `performance` from the
    latency engine), and each `recovered` decision calls `sink.resolve`.
    The returned union (`ServingDecision`) carries an explicit
    `signal: 'availability' | 'latency'` discriminator so a test can assert
    which engine produced each verdict.
- **CLI.** A single new flag `--slo-latency-budget <ms-or-duration>`
  (default `'300ms'`), validated at parse time via `parseLatencyBudgetMs`.
  **`--slo` keeps enabling both engines** — we don't fragment the surface
  into `--slo-availability` / `--slo-latency`; one flag, two engines.
- **`node.ts` wiring.** `serve()` builds the latency engine alongside the
  availability one whenever `--slo` is set and passes both to the
  monitor. The same `PostgresIncidentSink` (under `--slo-persist`) durably
  receives both `availability` and `performance` incidents.

## Cross-cutting invariants enforced (by tests)

- **Mapping (offline).** With a `latencyEngine` wired, `recordRequest`
  feeds both engines (each gets one `RequestOutcome`); without one, only
  availability is fed (back-compat).
- **Real-engine lifecycle (offline).** A 25× `(200, 2000ms)` burst against
  a 300ms budget declares one `performance` incident through the shared
  sink; an `ok` + sub-budget stream persists nothing; the same burst with
  no latency engine wired persists only the availability incident (clean
  back-compat). A `recovered` latency decision calls `sink.resolve`.
- **CLI.** `--slo-latency-budget` parses `'300ms'` / `'5s'`; garbage
  throws `CliUsageError`; the default exposed by `parseServeArgs` is
  `null` (the engine builder fills the 300ms default).
- **Real-PG (gated).** A latency burst sweeps a `performance` incident
  into `meta.incidents` via the shared `PostgresIncidentSink`, read back
  through the shared `PostgresIncidentReplayer` (`declared` /
  `performance` / clean timeline).

## Alternatives considered

- **A separate `--slo-latency` flag fragmenting the surface.**
  - **Decision.** No — one `--slo` toggle wiring both engines keeps the
    common case ergonomic; the budget knob is the single tunable.
- **A separate monitor instance per engine.**
  - **Decision.** No — one monitor that holds both engines means one
    sweep loop, one error sink, one logger, one shutdown. The
    `ServingDecision` discriminator preserves per-engine identification
    in the return.
- **Stamp the `category` on the monitor itself instead of trusting the
  engine's planner.**
  - **Decision.** No — `LatencySloEngine` already declares
    `category: 'performance'` via the shared `planIncidentDeclaration`;
    the monitor passes `plan.incident` through unchanged, so a future
    `LatencyRegistration.category` override (already supported by the
    engine) is respected for free.
- **Reject `--slo-latency-budget` without `--slo`.**
  - **Decision.** Not enforced at the CLI — the flag is harmless on its
    own (a stored string nobody reads), and tightening the validation
    surfaces clearer errors than a mutual-exclusion message later.

## Consequences

- The serving app's SLO loop now spans **both signals** the M8 / M8.6
  runtime supports — availability **and** latency — through one monitor,
  one sink, and one CLI. A latency regression on the serving path now
  declares a `performance` incident in `meta.incidents` and is queryable
  through the same `incidents` tooling the worker app surfaces.
- The latency `IncidentRecord`'s `category` is `'performance'` (set by
  `LatencySloEngine`), so the shared `PostgresIncidentSink` /
  `PostgresIncidentReplayer` / `computeIncidentMetrics` already know how
  to file and aggregate them alongside the availability incidents — no
  schema or replayer changes.
