# ADR-0132: Workflow runtime activity execution instrumentation (Phase 2 M8.1)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0120 (M8 workflow instrumentation hooks), ADR-0061 (workflow-runtime M3) |

## Context

M8 (ADR-0120) shipped the `WorkflowInstrumentation` interface with 11 documented event kinds wired at 8 engine paths. ADR-0120 Q3 explicitly deferred activity execution events:

> Q3: Should activity execution be instrumented (started / completed / failed)?
> _Current direction:_ `activity_scheduled` is emitted today. `activity_started` / `activity_completed` / `activity_failed` are noted as candidates — defer to a follow-up.

That follow-up is M8.1. Activity execution is the most operationally interesting workflow event — it's where actual work happens, where latency accumulates, and where errors surface. Without instrumentation for the start/complete/fail edges, operators monitoring workflow throughput have to reconstruct activity timing from the source-of-truth `META_WORKFLOW_EVENTS` table (slow scan) instead of the observability-optimized `META_WORKFLOW_TRACES` table.

Three workflows unblocked:

1. **Activity latency dashboards.** Operators want "p50/p95/p99 latency for activity X across the last hour." Currently they'd compute durations from event-log timestamp deltas; with `activity_completed.durationMs` natively surfaced, this becomes a one-line aggregate query.
2. **Activity failure alerting.** `activity_failed` events carry `errorCode` + `errorMessage` + `retryable` in attributes. Operators wire OTel exporters / PagerDuty / Slack on this signal.
3. **Per-activity-kind cost attribution.** Per-tenant cost rollups (M6.7 deferred) join `activity_started` / `activity_completed` durations to compute compute-cost-per-tenant-activity.

## Decision

Three additive changes — kernel kinds tuple, engine wiring, kernel meta-schema CHECK constraint.

### 1. `WORKFLOW_INSTRUMENTATION_KINDS` tuple extends 11 → 14

```ts
export const WORKFLOW_INSTRUMENTATION_KINDS = [
  "instance_started",
  "instance_completed",
  "instance_failed",
  "instance_cancelled",
  "state_transitioned",
  "signal_received",
  "signal_consumed",
  "timer_fired",
  "activity_scheduled",
  "activity_started",    // NEW
  "activity_completed",  // NEW
  "activity_failed",     // NEW
  "action_applied",
  "engine_error",
] as const;
```

Three new kinds inserted positionally adjacent to the existing `activity_scheduled` for grep-readability.

### 2. Engine wiring in `applyScheduleActivity`

The existing flow (M3 / ADR-0061):
1. Append `activity_scheduled` event log row.
2. Resolve handler via registry.
3. Append `activity_started` event log row.
4. Execute handler (synchronous try/catch — exceptions become `failed` outcomes).
5. Append `activity_completed` or `activity_failed` event log row based on outcome.

M8.1 adds three `emitInstrumentation` calls:
- **Before step 3** (`activity_started` event append): emit `activity_started` instrumentation. Capture `activityStartedAt = clock.now()` for duration tracking.
- **After step 4 on success outcome** (`activity_completed` event append): emit `activity_completed` instrumentation with `durationMs = clock.now() - activityStartedAt`.
- **After step 4 on failure outcome** (`activity_failed` event append): emit `activity_failed` instrumentation with `durationMs` + `errorCode` + `errorMessage` + `retryable`.

The instrumentation fires BEFORE the corresponding event log append — consistent with M8's pattern (`instance_started` instrumentation fires before the event-log row, etc.).

### 3. Event attributes

```ts
// activity_started:
{ activityId, activityKey, activityKind }

// activity_completed:
{ activityId, activityKey, activityKind }
// + durationMs (computed from engine clock)

// activity_failed:
{
  activityId,
  activityKey,
  activityKind,
  errorCode,
  errorMessage,
  retryable,
}
// + durationMs
```

Failed-event attributes include the full failure context — operators inspecting traces don't need to cross-reference the event log for the error details.

### 4. `META_WORKFLOW_TRACES.kind` CHECK constraint extension

Three new values added:

```sql
kind IN (
  'instance_started', 'instance_completed', 'instance_failed',
  'instance_cancelled', 'state_transitioned', 'signal_received',
  'signal_consumed', 'timer_fired', 'activity_scheduled',
  'activity_started', 'activity_completed', 'activity_failed',  -- NEW
  'action_applied', 'engine_error'
)
```

Existing rows in PG tables (if any operator deployed M8 to production) continue to satisfy the constraint — the change is purely additive.

### 5. Handler-exception path covered

When a handler throws (e.g., `throw new Error("boom")`), the engine catches it in the existing try/catch and constructs a synthetic failed outcome:

```ts
catch (err) {
  outcome = {
    status: "failed" as const,
    errorCode: "HANDLER_EXCEPTION",
    errorMessage: err instanceof Error ? err.message : String(err),
    retryable: false,
  };
}
```

The `activity_failed` instrumentation fires for both:
- Handler returning `{status: "failed", ...}` (operator-controlled failure).
- Handler throwing (uncaught exception path).

Tests cover both paths.

## Cross-cutting invariants enforced

- **Same shape as M8's existing instrumentation events.** kind + tenantId + instanceId + definitionId + correlationId + occurredAt + durationMs + attributes.
- **durationMs is non-negative.** Computed from engine clock (`SystemClock` or test-provided `FixedClock`).
- **Instrumentation fires BEFORE the event-log append.** Consistent with M8 — observability surfaces before authoritative state.
- **No new transport.** Reuses M8's `signedControlPlaneGet` rail... wait, that was Bedrock. For workflow runtime, the instrumentation hook is in-process; no transport.
- **Errors swallowed.** M8's `emitInstrumentation` already wraps `onEvent` in try/catch — failures in observability never crash the engine.
- **Handler-exception path covered.** Both `return {status: "failed"}` and `throw` paths surface `activity_failed`.
- **Backwards compat preserved.** All pre-M8.1 engine tests pass without modification.

## End-to-end semantic

```ts
import { captureInstrumentation } from "@crossengin/workflow-runtime";

const cap = captureInstrumentation();
const engine = new WorkflowEngine({
  // ...
  instrumentation: cap.instrumentation,
});

await engine.startInstance({
  definitionId: "wfd_payment",
  tenantId: "ten-x",
  correlationKey: "po-123",
});

// Instrumentation stream for a single payment workflow:
//   instance_started
//   activity_scheduled  (activityKey="charge_card")
//   activity_started    (activityKey="charge_card", activityId="wfa_001")
//   activity_completed  (activityKey="charge_card", durationMs=247)
//   state_transitioned  (draft → charged)
//   activity_scheduled  (activityKey="send_receipt")
//   activity_started    (activityKey="send_receipt", activityId="wfa_002")
//   activity_failed     (activityKey="send_receipt", durationMs=53,
//                        errorCode="SMTP_DOWN", errorMessage="...", retryable=true)
//   state_transitioned  (charged → receipt_pending)
//   ...

// Dashboard query (PG):
SELECT
  attributes->>'activityKey' AS activity,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
  COUNT(*) AS total
FROM meta.workflow_traces
WHERE
  tenant_id = $1
  AND kind = 'activity_completed'
  AND occurred_at >= NOW() - INTERVAL '1 hour'
GROUP BY 1;
```

## Alternatives considered

- **Add a single `activity_finished` kind that's discriminated on `attributes.status`.**
  - **Considered.** Fewer kinds in the tuple.
  - **Cons.** Operators alerting on failures need to filter by attributes — slower than the indexed (tenant_id, kind, occurred_at) lookup.
  - **Decision.** Three separate kinds.

- **Emit `activity_completed` even on failure (with `status: "failed"` in attributes).**
  - **Considered.** Symmetric event shape.
  - **Cons.** Same as above. Plus: ambiguous semantics — operators wiring "alert on activity_failed" would have to filter on attributes too.
  - **Decision.** Separate kinds.

- **Skip `activity_started` (only emit scheduled + completed/failed).**
  - **Considered.** Reduces event volume.
  - **Cons.** "Time scheduled → time started" can be operationally interesting (queue depth, scheduler backlog). Operators want the started event for that derivation.
  - **Decision.** Three events per activity execution.

- **Compute `durationMs` per-attribute (e.g., `queueLatencyMs` separate from `executionMs`).**
  - **Considered.** Finer-grained latency breakdown.
  - **Cons.** Today's engine runs activities synchronously in the event loop; queue latency is sub-millisecond. When queue-backed activity execution lands (future milestone), we extend attributes additively.
  - **Decision.** Single `durationMs` on completed/failed.

- **Make `durationMs` mandatory (non-nullable).**
  - **Considered.** Always-present field.
  - **Cons.** The `WorkflowInstrumentationEvent` shape currently has `durationMs: number | null` — keeping it nullable matches the broader instrumentation interface. Activity events always set it; other event kinds (instance_started, state_transitioned) leave it null.
  - **Decision.** Optional at the type level; activity events always populate it.

- **Wire instrumentation into the activity-handler interface itself (handlers report their own metrics).**
  - **Considered.** Handlers know best how to measure their own work.
  - **Cons.** Operator-provided handlers should be ignorant of observability. Engine-level wiring is the right layer.
  - **Decision.** Engine emits; handlers stay observability-free.

## Consequences

- **55 packages + 1 app, 120 meta-schema tables, 7,541 tests** (+7 from M8.1: 7 new engine instrumentation tests covering activity execution). All green, zero type errors.
- **WORKFLOW_INSTRUMENTATION_KINDS grows from 11 → 14.** Three new event kinds wired at one new engine call site (the existing `applyScheduleActivity` method).
- **`META_WORKFLOW_TRACES.kind` CHECK constraint widens additively.**
- **ADR-0120 Q3 closed.** The longest-outstanding deferred Q from the M8 milestone is now addressed.
- **Activity-latency dashboards unblocked.** `activity_completed.durationMs` is the canonical latency signal.
- **Activity-failure alerting unblocked.** `activity_failed` carries the full failure context.
- **Per-activity cost attribution rail ready.** M6.7 (PostgresCostTracker, deferred) can consume `activity_completed.durationMs` × per-handler-rate.
- **Pattern consistency.** Activity events match the M8 shape exactly — operators learn one shape, apply to all 14 kinds.
- **Handler-exception path covered.** Both controlled-failure and uncaught-throw paths surface `activity_failed`.

## Open questions

- **Q1:** Should `activity_completed` include `outputSha256` (already on the event-log row)?
  - _Current direction:_ Out of scope. Operators reading the event log get it there; observability traces stay focused on latency + status.
- **Q2:** When queue-backed activity execution lands, separate `queueLatencyMs` from `executionMs`?
  - _Current direction:_ Yes. Extend `activity_started` to carry `queuedAt` timestamp; compute queue latency at the dashboard layer.
- **Q3:** Should `activity_failed.attributes.retryable` drive automatic retry?
  - _Current direction:_ Already wired at the engine level (existing M3 logic). The instrumentation event just records the field for operator visibility.
- **Q4:** Multi-step activity handlers (e.g., a single handler that calls multiple downstream APIs) — should each step emit its own trace?
  - _Current direction:_ No. The engine wires one activity = one execution = one trace. Operators wanting finer breakdown wire their own observability inside the handler.
- **Q5:** OpenTelemetry exporter that maps `activity_started` → span open + `activity_completed` → span close?
  - _Current direction:_ Operators write the ~20-line adapter per ADR-0120's pattern. The kernel surface stays adapter-free.
- **Q6:** Should the trace surface `attemptNumber` (for retried activities)?
  - _Current direction:_ Today the engine doesn't retry (M3 limitation). When retry lands (future milestone), `attemptNumber` joins the attribute set.
- **Q7:** Should activity_failed surface differ from activity_completed in column shape (e.g., index on errorCode)?
  - _Current direction:_ No. Operators querying `WHERE kind = 'activity_failed' AND attributes->>'errorCode' = 'X'` get the indexed lookup via the (tenant_id, kind, occurred_at) index + JSONB attribute filter.
