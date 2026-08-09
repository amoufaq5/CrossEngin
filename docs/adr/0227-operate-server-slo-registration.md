# ADR-0227: `serve()`-level SLO registration in operate-server (Phase 3 P8)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-09 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0226 (SLO wiring on the live stream), ADR-0060 (observability-runtime), ADR-0087 (operate-server), ADR-0077 (P3 plan — P8) |

## Context

ADR-0226 wired the SLO enforcement seam into `OperateHttpServer` (an `onExecution` sink feeding a
`SloRequestObserver` + `SloEvaluationScheduler`), but nothing in the *running* binary attached it — the
seam existed, and an embedder had to hand-build the engines. The gap: the deployed `operate-server`
process had no source of which SLOs/targets to enforce for which surfaces, so the loop never fired in
production. This closes that gap with a config-driven registration.

## Decision

- **`--slo-config <path>`** (`cli.ts`): a new `ServeOptions.sloConfig` flag pointing at a JSON SLO
  config file; help text updated.
- **`slo-config.ts`** — `SloConfigSchema` validates the file: an `alertPolicy` +
  `systemActorUserId` + optional `evaluateIntervalMs` (default 60 000) + `availability` and/or `latency`
  registration arrays (each `{slo, category?, rollback?, tenantId?}`), reusing
  `@crossengin/observability`'s `Slo`/`AlertPolicy` schemas and requiring at least one non-empty engine
  list. `loadSloConfig(path)` reads + parses; `buildSloEnforcement(config, opts?)` constructs a
  `SloEnforcementEngine` (from `availability`) and/or `LatencySloEngine` (from `latency`), wires both
  into one `SloRequestObserver`, and returns `{observer, scheduler, engines}` where the scheduler's
  evaluators are the `availabilityEvaluator`/`latencyEvaluator` of whichever engines exist. The clock is
  injectable so the build is deterministically testable.
- **`serve()` wiring** (`node.ts`): when `--slo-config` is set, `serve()` loads the config, builds the
  enforcement, passes `onExecution: observer.asExecutionSink()` into `buildOperateHttpServer`, starts
  the scheduler, and adds `scheduler.stop()` to the close handle — mirroring the existing conditional
  poller / job-scheduler / prune-scheduler lifecycle. Without the flag, serving is byte-for-byte
  unchanged.

## Consequences

- The deployed binary now auto-enforces SLOs: `operate-server --pack erp-retail --slo-config slos.json`
  declares an incident + pages on-call (+ rolls a flag back, if a `rollback` is registered) on a
  burn-rate breach computed from its own live request stream — no embedder code required.
- SLO policy is data, not code: an operator ships a JSON file of SLOs + an alert policy; adding a
  surface or tightening a target is a config edit. Availability and latency SLOs coexist over one
  observer.
- `buildSloEnforcement` is a pure factory (clock/scheduler/sinks injectable), so it is fully
  offline-tested (a failure burst through the observer → a `breach_opened` from `evaluateOnce()`); the
  socket-binding `serve()` path stays offline-untestable, like the other schedulers.
- Follow-ups (open): deriving default SLOs from the manifest's declared views/lifecycles so a pack ships
  with sensible targets; persisting enforcement decisions from the running server via the M8.5 PG
  sibling.
