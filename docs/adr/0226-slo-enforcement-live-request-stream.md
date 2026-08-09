# ADR-0226: SLO enforcement on operate-server's live request stream (Phase 3 P8)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0060 (observability-runtime — SLO loop), ADR-0087 (operate-server), ADR-0077 (P3 plan — P8) |

## Context

The M8 SLO enforcement loop (`@crossengin/observability-runtime`) was built and tested in isolation:
`SloEnforcementEngine.recordOutcome(RequestOutcome)` + `evaluate()` declares an incident, pages
on-call, and rolls a flag back on a burn-rate breach. But it only ever ran against hand-fed outcomes in
a test harness. ADR-0077's P8 exit criterion for this piece is "the M8 SLO loop wired to
`operate-server`'s real request stream (not a test harness)". The gateway already produces a
schema-valid `PipelineExecution` per request; nothing consumed it for SLO purposes.

## Decision

- **`OperateHttpServer` emits every request's execution.** `OperateHttpServerOptions.onExecution?:
  (execution: PipelineExecution) => void` (threaded through `buildOperateHttpServer`) is invoked with
  the `PipelineExecution` of each gateway-dispatched request, after the response is produced. It is
  wrapped so an observer error is swallowed — **observation can never break serving**. With no sink set,
  dispatch is byte-for-byte unchanged.
- **A new `slo.ts` module** bridges that stream to the engines:
  - `pipelineExecutionToOutcome(execution, {surfaceOf?})` — pure projection: a 5xx final status is an
    availability `error`, everything else (including 4xx — a client error, not an outage) is `ok`;
    latency is the pipeline's own `totalDurationMs`, the timestamp its `completedAt`, the surface its
    `routeOperationId` (overridable via `surfaceOf`, `"unrouted"` when absent).
  - `SloRequestObserver` records each execution's outcome into every registered engine (availability,
    latency, or both — both satisfy the structural `OutcomeRecorder`). Recording is a cheap in-memory
    window append; `asExecutionSink()` yields the `onExecution` callback.
  - `SloEvaluationScheduler` drives `evaluate()` on an interval (mirroring `PruneScheduler` /
    `JobScheduler`: `unref`'d timer, `onError`-routed failures) and routes results to `onDecision`.
    Recording is deliberately decoupled from evaluation — the observer records on every request, the
    scheduler computes burn windows at most once per tick, so a hot path never pays the burn-rate cost.
  - `summarizeAvailabilityDecision` / `summarizeLatencyDecision` normalize both engine decision unions
    into one `ObservedEnforcementDecision` (`{signal, kind, surface, sloId, severity, incidentId,
    killSwitchId}`); `availabilityEvaluator` / `latencyEvaluator` wrap an engine as a
    `DecisionEvaluator` the scheduler consumes.

## Consequences

- The M8 loop now fires on real traffic: a burst of failures dispatched through the actual
  `OperateHttpServer` records into the engine, and a scheduler tick declares a SEV2 incident, pages
  on-call, and (with a rollback registered) rolls the flag back — demonstrated end-to-end in a test
  that boots `buildOperateHttpServer` and sends real requests, not a hand-fed engine.
- The recording/evaluation split keeps the request path cheap (append-only) and makes evaluation cadence
  a deployment tuning knob rather than a per-request tax; the engines' one-incident-per-ongoing-breach
  dedup means a slow tick can't double-declare.
- The wiring is composition, not new pipeline logic: the server just surfaces its existing
  `PipelineExecution`; all SLO semantics stay in `observability-runtime`. `@crossengin/observability`
  (+ `-runtime`) are new `operate-server` dependencies.
- +10 tests (outcome mapping incl. 4xx-is-ok + custom surface; observer records into the engine;
  scheduler tick routes normalized decisions, returns incident ids, and swallows evaluator errors; a
  live-server burst → breach). Full build + typecheck + workspace tests green. No META tables, no new
  package.
- Follow-up (open): a `serve()`-level SLO registration source (which SLOs/targets per surface — the
  manifest doesn't declare them yet, and there's no CLI flag), so the running binary auto-enforces;
  today the seam is wired and an embedder attaches the observer + scheduler. Remaining P8 work:
  `@crossengin/dr-runtime` and scheduled `access-reviews` campaigns.
