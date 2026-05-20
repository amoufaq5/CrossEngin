# ADR-0156: Workflow runtime timer_set + timer_cancelled instrumentation (Phase 2 M8.2)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0120 (M8 WorkflowInstrumentation), ADR-0132 (M8.1 activity execution instrumentation) |

## Context

M8 (ADR-0120) shipped `WorkflowInstrumentation` with 11 event kinds. M8.1 (ADR-0132) added 3 activity-execution kinds (started + completed + failed) bringing the total to 14. One critical lifecycle event was already present — `timer_fired` — but the COMPANION events were missing:

- **`timer_set`** — fires when a timer is scheduled (entered the queue).
- **`timer_cancelled`** — fires when a timer is cancelled (removed before firing).

Operators with timer-heavy workflows (deadlines, SLA escalations, reminder cascades) couldn't see the FULL timer lifecycle in traces. They saw firings but not creations; cancellations were invisible. Without these events:

1. **Timer creation throughput** isn't observable. "How many timers does this workflow schedule per instance?"
2. **Timer cancellation rate** isn't observable. "Are most timers cancelled before firing, or is the deadline actually enforced?"
3. **Timer-set-to-fire latency** isn't computable. Operators want `fired.occurredAt - set.occurredAt` per timer.
4. **Compliance dashboards** can't audit "every timer scheduled by this workflow."

M8.2 closes the lifecycle gap.

## Decision

Three additive changes:

1. **`WORKFLOW_INSTRUMENTATION_KINDS` grows 14 → 16** with `timer_set` (slot 8, before `timer_fired`) and `timer_cancelled` (slot 10, after `timer_fired`). Symmetric with the create/read/destroy pattern.

2. **Wire `timer_set` emission into `applyScheduleTimer`.** The engine method now emits `timer_set` instrumentation BEFORE the `timer_scheduled` event-log append, capturing the parameters going INTO the schedule:

```ts
await this.emitInstrumentation("timer_set", {
  tenantId,
  instanceId,
  definitionId: this.instanceDefinition.get(instanceId) ?? null,
  correlationId: this.instanceCorrelation.get(instanceId) ?? null,
  attributes: {
    timerId,
    timerName,
    fireAt,
    relativeSeconds,
  },
});
```

The same `timerId` flows into both the `timer_set` instrumentation AND the subsequent `timer_scheduled` event-log entry — operators correlate the two via `attributes.timerId`.

3. **`timer_cancelled` is enum-defined + CHECK-constraint-allowed but NOT YET EMITTED.** Reasons:

   - The engine's `cancel_timer` action handler currently throws `"action kind cancel_timer is not implemented in M3"` (engine.ts line 600-603). No code path produces cancellation events.
   - Adding emission would require implementing the cancel_timer action, which is a separate workflow-engine feature spanning state-machine transition validation + event-log writes — out of scope.
   - Reserving the kind in the enum + CHECK constraint NOW means the future milestone that wires cancel_timer doesn't need a schema migration. Additive forward-compat.

4. **`META_WORKFLOW_TRACES.kind` CHECK constraint extended additively** to allow both new values. No data migration needed; existing rows still have valid kind values.

### Why emit BEFORE the event-log append?

Same pattern as M8.1's `activity_started` (ADR-0132): instrumentation fires first, then event-log persistence. Rationale:

- If instrumentation throws, the engine catches + swallows (instrumentation NEVER crashes the engine) — the event-log append still happens, the timer still works.
- If event-log append throws (e.g., DB error), the instrumentation already fired — operators see the "intended to schedule" trace even though persistence failed. Helps with debugging stuck workflows.
- Same shape across all engine-emitted events.

### Why `timer_set` (not `timer_scheduled`)?

`timer_scheduled` is the event-log kind already used for the persistence event. Re-using the name for instrumentation would conflate two distinct surfaces (event log = workflow state; instrumentation = trace). Different names disambiguate.

The chosen name `timer_set` also matches the colloquial operator language ("the workflow set a timer for 60s") and is symmetric with future `timer_cancelled` (the verb pair).

## Cross-cutting invariants enforced

- **Additive only.** Existing 14 kinds preserved. CHECK constraint extension allows but doesn't require the new values.
- **`timer_set` emits BEFORE the event-log append.** Matches M8.1's activity_started ordering.
- **Same `timerId` across `timer_set` and `timer_fired`.** Operators correlate timer-set-to-fire latency.
- **No emission for `timer_cancelled` yet.** Kind reserved for future cancel_timer action implementation; CHECK constraint allows it for forward-compat.
- **Instrumentation never crashes the engine.** Same error-swallowing pattern as M8 — emitInstrumentation catches and logs.
- **No new transport.** Reuses `emitInstrumentation` helper from M8.
- **No schema change beyond CHECK constraint extension.** No migration story for existing rows.
- **`tenantId`, `instanceId`, `definitionId`, `correlationId` threaded consistently** with other engine instrumentation events.

## End-to-end semantic

```ts
import { WorkflowEngine, captureInstrumentation } from "@crossengin/workflow-runtime";

const cap = captureInstrumentation();
const engine = new WorkflowEngine({ ..., instrumentation: cap.instrumentation });

await engine.startInstance({ tenantId, definitionId, correlationKey: "po-42" });

// If the initial state has an onEntry `schedule_timer` action, cap.events
// will contain a `timer_set` event with:
//   { kind: "timer_set", tenantId, instanceId, definitionId,
//     attributes: { timerId: "wft_...", timerName: "deadline",
//                   fireAt: "2026-05-16T12:01:00Z", relativeSeconds: 60 } }

// Later, when the timer fires:
await engine.tickTimers(Date.now());
// cap.events now also contains a `timer_fired` event with the SAME timerId.

// Operator dashboards:
// 1. Timer-set-to-fire latency per workflow definition:
//   WITH paired AS (
//     SELECT s.attributes->>'timerId' AS tid,
//            s.occurred_at AS set_at,
//            f.occurred_at AS fired_at
//     FROM meta.workflow_traces s
//     JOIN meta.workflow_traces f
//       ON f.attributes->>'timerId' = s.attributes->>'timerId'
//      AND f.kind = 'timer_fired'
//     WHERE s.kind = 'timer_set'
//   )
//   SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (fired_at - set_at)))
//   FROM paired;
//
// 2. Active timers per workflow definition:
//   SELECT s.definition_id, COUNT(*)
//   FROM meta.workflow_traces s
//   WHERE s.kind = 'timer_set'
//     AND s.attributes->>'timerId' NOT IN (
//       SELECT attributes->>'timerId' FROM meta.workflow_traces
//       WHERE kind IN ('timer_fired', 'timer_cancelled')
//     )
//   GROUP BY s.definition_id;
```

When the future cancel_timer action is wired, the dashboard query above immediately picks up the new cancellation observability without schema changes.

## Alternatives considered

- **Emit `timer_set` AFTER the event-log append.**
  - **Considered.** Matches "persistence-first" ordering used elsewhere.
  - **Cons.** Inconsistent with M8.1's `activity_started` which emits before the activity_scheduled append. The instrumentation-first ordering captures intent even when persistence fails; operators see the "tried to schedule" signal.
  - **Decision.** Before, matching M8.1.

- **Don't add `timer_cancelled` until cancel_timer action is implemented.**
  - **Considered.** Strict YAGNI.
  - **Cons.** Two-step rollout: kind addition + CHECK constraint extension + emission. Operators in trace dashboards have to handle "old CHECK doesn't allow timer_cancelled" until the future milestone lands. Adding now with NO emission is a small forward-compat step; future milestone just wires the emit site.
  - **Decision.** Add the kind now.

- **Emit `timer_cancelled` automatically from the tick-loop scan of timer_cancelled events.**
  - **Considered.** The tick-timers loop already reads timer_cancelled events when computing scheduled-but-not-fired timers (line 353 in engine.ts).
  - **Cons.** Currently no code path WRITES timer_cancelled events. External callers (tests, future cancel_timer action) write them. Emitting instrumentation on every tick that sees a timer_cancelled event would either re-emit on each tick (wrong) or need an "emitted-already" tracking mechanism (complex). Defer to when cancel_timer is implemented and emission lives in the same code path.
  - **Decision.** No emission yet for timer_cancelled.

- **Combine `timer_set` and `timer_scheduled` event-log kind into one.**
  - **Considered.** Eliminate duplication.
  - **Cons.** Event log is workflow state (what happened); instrumentation is trace (audit). Different surfaces, different consumers. The duplication is intentional.
  - **Decision.** Keep separate.

- **Add `expectedDurationMs` attribute to `timer_set` (operator hint for latency targets).**
  - **Considered.** Helps with dashboard SLA checks ("did this timer fire within its expected window?").
  - **Cons.** Operator-side concern. Operators can compute from `fireAt - occurredAt` themselves.
  - **Decision.** No expectedDurationMs.

- **Emit a single `timer_lifecycle` event with `phase: "set" | "fired" | "cancelled"` discriminator.**
  - **Considered.** Fewer distinct kinds.
  - **Cons.** Breaks the existing M8 pattern where each lifecycle event has its own kind (instance_started + instance_completed, NOT instance_lifecycle). Consistency wins.
  - **Decision.** Three distinct kinds.

- **Track `timerId → instrumentation_emitted` in the engine to avoid re-emitting on subsequent ticks.**
  - **Considered.** Would let future cancel_timer instrumentation scan event-log on each tick.
  - **Cons.** State that lives in the engine instance — doesn't survive engine restart. Better to emit in the same code path that writes the cancellation event.
  - **Decision.** Defer.

## Consequences

- **56 packages + 1 app, 128 meta-schema tables, 8,042 tests** (+6 from M8.2: all in `engine.test.ts`). All green, zero type errors.
- **WORKFLOW_INSTRUMENTATION_KINDS grows 14 → 16.**
- **META_WORKFLOW_TRACES.kind CHECK constraint extended additively.** No migration.
- **Timer creation throughput is now observable** via `timer_set` event count.
- **Timer-set-to-fire latency** is now computable via `(fired - set)` correlation on `attributes.timerId`.
- **Cancellation observability reserved.** Future cancel_timer milestone wires emission; no schema migration needed.
- **No new transport, no new dependency, no breaking change.** Existing instrumentation consumers continue working.
- **Operator workflow alignment.** "Set a timer" → "timer fired" or "timer cancelled" is the natural verb sequence; the kind names mirror operator language.

## Open questions

- **Q1:** Should `timer_set` carry the action's full parameters (in case future schedule_timer actions add more fields)?
  - _Current direction:_ Current attributes (`timerId`, `timerName`, `fireAt`, `relativeSeconds`) capture the schedule semantics. If future schedule_timer adds e.g., `repeatInterval`, additive change to the attributes.
- **Q2:** Should the engine implement `cancel_timer` as part of this milestone (instead of throwing "not implemented in M3")?
  - _Current direction:_ Out of scope. M8.2 is observability; cancel_timer is engine state-machine logic. Separate milestone — likely M8.3 or M3.X.
- **Q3:** Should the instrumentation carry `causationEventId` linking the timer_set event back to the state-transition that triggered it?
  - _Current direction:_ Useful for causal-chain analysis. Additive attribute. Defer unless real-world need.
- **Q4:** Should there be a `timer_expiring_soon` event for SLA escalation (fires N seconds before `fireAt`)?
  - _Current direction:_ Out of scope. Operator-side dashboards compute this from the existing fields.
- **Q5:** PostgresWorkflowInstrumentation handles the new kinds transparently — but should there be a dedicated SQL helper for "active timers per workflow definition"?
  - _Current direction:_ Operator query workflow. Substrate is the transport.
- **Q6:** When `cancel_timer` is implemented, should `timer_cancelled` carry the cancellation REASON (e.g., "explicit cancel", "definition deactivated")?
  - _Current direction:_ Yes — additive attribute (`cancellationReason: string`). Designed when the emit site is wired.
- **Q7:** Should there be a max-timers-per-instance limit enforced by the engine?
  - _Current direction:_ Out of scope. Substrate doesn't impose business limits.
- **Q8:** Should `timer_set` instrumentation fire for system-internal timers (e.g., SLA timers auto-scheduled by `slaSeconds`)?
  - _Current direction:_ Yes — they go through the same `applyScheduleTimer` path. Operators see SLA-driven timers alongside operator-defined ones with the same shape.
