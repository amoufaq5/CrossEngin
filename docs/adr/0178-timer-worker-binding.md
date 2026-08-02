# ADR-0178: Engine-bound timer worker — the running distributed timer executor

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0175 (timer claim), ADR-0176 (workflow-worker loop), ADR-0177 (fireDueTimersForInstance) |

## Context

Three P2 primitives now exist: the durable claim (`claimDueTimers`, `FOR UPDATE SKIP LOCKED`,
ADR-0175), the pure poll loop (`WorkflowTimerWorker`, ADR-0176), and the log-driven targeted fire
(`fireDueTimersForInstance`, ADR-0177). This binds them into a **running** distributed timer
executor.

## Decision

- **`workflow-runtime-pg` gains the binding** (now depending on `@crossengin/workflow-worker`):
  - **`buildTimerClaimer(conn, {schema?})`** adapts `claimDueTimers` / `releaseTimerClaim` to the
    worker's `TimerClaimer` seam.
  - **`buildTimerProcessor(engine, {now?})`** — a `TimerProcessor` that fires a claimed timer by
    `engine.fireDueTimersForInstance(timer.instanceId, now())`. Takes only
    `Pick<WorkflowEngine, "fireDueTimersForInstance">`, so it's trivially mockable.
  - **`buildWorkflowTimerWorker({conn, engine, workerId, …})`** wires claimer + processor + the
    poll loop into a ready `WorkflowTimerWorker`. `now` drives **both** the claim's due-check and
    the fire's clock, so they agree.
- **Platform-scoped connection, no per-fire tenant context.** Per ADR-0175 the worker connection
  is RLS-bypassing, so one engine serves every tenant; the correct `tenant_id` rides on each
  appended event from the projected instance state (`fireDueTimersForInstance` reads it from the
  log). Idempotent firing matches the loop's at-least-once retries.

## Consequences

- The loop runs for real: `buildWorkflowTimerWorker(...).start()` claims due timers off Postgres
  (SKIP LOCKED, disjoint batches across the fleet), fires each instance from its event log, and
  releases failures for retry — the P2 distributed timer executor, end to end.
- The `runOnce()` integration test proves the whole chain in one call: a mock connection returns a
  due claim row, the worker claims it, and the (recording) engine's `fireDueTimersForInstance` is
  invoked with the claimed instance id at the injected clock — **claim → process → fire**.
- Clean seams throughout: the pure worker knows nothing of Postgres; the processor knows nothing of
  SQL; the binding is the only place they meet, and it's a handful of adapters.
- 6,818 tests pass (+5: claimer maps rows + threads schema, release SQL, processor fires at the
  injected clock, worker runOnce end-to-end claim→fire, empty poll). Full build + typecheck green.
- Follow-ups: lease renewal for slow fires (extend `claim_expires_at` mid-process); the same
  claim + worker for scheduled **activities** and `jobs` (with dead-letter); the P2 exit-criterion
  end-to-end against a real Postgres (kill worker A mid-flight → resume on B).
