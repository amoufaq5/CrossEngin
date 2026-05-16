# ADR-0049: Workflow engine runtime (Phase 2 M3)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-16 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0007 (workflow engine), ADR-0041 (workflow runtime contracts), ADR-0046 (Phase 2 plan), ADR-0047 (kernel DDL execution), ADR-0048 (crypto) |

## Context

`@crossengin/workflow-engine` declares the *shapes*: `WorkflowDefinition`, `WorkflowInstance`, `WorkflowActivity`, `WorkflowSignal`, `WorkflowTimer`, `WorkflowEvent`. Today nothing *executes* those shapes — they're zod schemas waiting for a runtime. M3 is that runtime: take a published definition, start an instance, drive transitions, run activities, fire timers, accept signals, and compensate failures.

Four hard requirements drive the design:

1. **Event-sourced state.** The `WorkflowEvent` log is the source of truth. `WorkflowInstance` / `WorkflowActivity` / `WorkflowSignal` / `WorkflowTimer` records are *projections* derived from events. Restart the process, replay the events, get the same state.
2. **Deterministic + replayable.** Given the same definition + same input + same event sequence, the engine produces the same state. No randomness, no wall-clock leaking into business logic — `Clock` and `IdGenerator` are injected.
3. **Activity handlers register, don't bake.** The engine doesn't know how to make an HTTP call or write to a DB. Consumers register handlers per `ActivityKind` (or per `(kind, definitionActivityKey)`); the engine calls them and records the outcome.
4. **Compensation actually runs.** When an instance fails and the definition declares `immediate_reverse_order` or `parallel` compensation, the engine schedules compensation activities for every succeeded side-effect activity, in the right order.

There's also a sequencing decision baked in by ADR-0046: in-process executor first, distributed executor (Postgres queue) as M3.5. M3 ships the in-process path; M3.5 wraps the same engine with a Postgres-backed `EventLog` + a worker pool that polls the activity queue.

## Decision

`@crossengin/workflow-runtime` ships with **seven modules**:

1. **`clock.ts`.** `Clock` interface (`now(): Date`, `nowSeconds(): number`). `SystemClock` for production, `FixedClock` + `AdvancingClock` for tests. `IdGenerator` interface produces the typed ids (`wfi_*`, `wfa_*`, `wfe_*`, `wfs_*`, `wft_*`) using Crockford base32. Real production uses random bytes; tests use a deterministic counter.

2. **`event-log.ts`.** `EventLog` interface: `append(event)`, `appendBatch(events)`, `listByInstance(instanceId)`, `latestSequence(instanceId)`, `count()`. `InMemoryEventLog` is the production-shape implementation. A future `PostgresEventLog` (M3.5) implements the same interface against `META_WORKFLOW_EVENTS`. Events are immutable — the log is append-only.

3. **`activity-handlers.ts`.** `ActivityHandler = (input: ActivityInvocation) => Promise<ActivityOutcome>`. `ActivityRegistry` is a `Map` of `(definitionId, activityKey)` → handler (with a fall-back to `(kind)` → handler for generic kinds). Built-in handlers for the safe-by-default kinds: `audit_emit` (no-op success), `transformation` (echo input), `db_read` (stubbed — real read needs `@crossengin/kernel-pg` adapter). Side-effect kinds (`http_call`, `db_write`, `ai_call`, `send_notification`, `child_workflow`) require explicit registration.

4. **`projection.ts`.** Pure functions: `projectInstance(events, definition) → WorkflowInstance | null`, `projectActivities(events) → readonly WorkflowActivity[]`, `projectSignals(events) → readonly WorkflowSignal[]`, `projectTimers(events) → readonly WorkflowTimer[]`. Each is a left-fold over the event stream — no IO, no clock dependency. The projection is the canonical way to read state; the engine never holds long-lived in-memory state for an instance.

5. **`transitions.ts`.** Pure: given current state + variables + a triggering event, find applicable transitions (matching `fromState` + `trigger`), evaluate guards, return the chosen transition or `null`. Guards are evaluated by a pluggable `GuardEvaluator` (default supports `always_true`, `variable_equals`, `variable_predicate`; `expression` / `role_required` / `abac_check` need consumer wiring).

6. **`engine.ts`.** `WorkflowEngine` is the public surface:
   - `startInstance({ definitionId, tenantId, variables?, correlationKey?, startedBy? }) → Promise<WorkflowInstance>`
   - `submitSignal({ signalName, correlationKey, tenantId, payload?, idempotencyKey? }) → Promise<SignalSubmissionResult>`
   - `tickTimers(now: Date) → Promise<TimerFireResult>`
   - `completeActivity({ activityId, output? }) → Promise<void>`
   - `failActivity({ activityId, errorCode, errorMessage }) → Promise<void>`
   - `cancelInstance({ instanceId, reason, cancelledBy? }) → Promise<void>`
   - `getInstanceState(instanceId) → Promise<WorkflowInstance | null>`
   - `listEvents(instanceId) → Promise<readonly WorkflowEvent[]>`

   Internally, each public method runs a *step loop*: append the inbound event, then keep evaluating automatic transitions, running registered handlers for newly-scheduled activities, until the instance reaches a quiescent state (waiting on a signal/timer/activity/manual action, or terminal). The loop is bounded (max 1000 steps per public-method invocation) to prevent runaway recursion.

7. **`saga.ts`.** Compensation. When an instance fails:
   - Reads all `activity_completed` events with `kind ∈ SIDE_EFFECT_ACTIVITY_KINDS`
   - Maps each to its `compensationActivityKey` (declared on the activity)
   - Generates compensation activities according to `definition.compensationStrategy`:
     - `immediate_reverse_order` — schedule each in reverse order, await each
     - `parallel` — schedule all at once, await all
     - `manual_review` — emit `compensation_started` + create a `waiting_for_manual` activity; no auto-execution
     - `no_compensation` — emit `compensation_started` + `compensation_completed` immediately (no-op)
   - Emits `compensation_step_completed` per step and `compensation_completed` when done.

## Cross-cutting invariants enforced

- **Append-only event log.** Events never mutate. Updates to instance state are derived via projection — never a SQL `UPDATE`.
- **Monotonic per-instance sequence.** Every event for an instance carries a `sequenceNumber`; the engine asserts strict monotonic increase on append. Concurrent writers (M3.5) must hold a per-instance lock.
- **Clock + IdGenerator injection.** No `Date.now()` or `crypto.randomBytes()` inside engine logic. All non-determinism is in the injected dependencies. Tests use `FixedClock` and a deterministic id generator to assert exact event sequences.
- **Handler outcome is the boundary.** A handler returning normally is `activity_completed`; throwing is `activity_failed`. Handlers are responsible for retry exhaustion — they receive `attemptNumber` and decide to throw a retryable vs non-retryable error code.
- **Idempotency keys on signals.** `exactly_once_idempotent` signals with the same `idempotencyKey` (per tenant + signal name) are deduplicated — the second submission returns `{ deduplicated: true }` rather than appending an event.
- **Tenant isolation through events.** Every event carries `tenantId`. Projection / query helpers filter by tenant. Cross-tenant signal correlation is rejected.
- **Cycle detection.** The step loop's 1000-step bound is a backstop; the projector also detects infinite event chains by walking causation pointers.

## Alternatives considered

- **Use Temporal / Conductor / Cadence as the runtime.**
  - **Pros.** Battle-tested. Built-in distributed execution, history persistence, replay determinism, sticky workflow workers.
  - **Cons.** Each is a heavyweight system (Temporal needs a backend cluster + UI service + workers). Our workflow contracts (`WorkflowDefinition` shape, the 24 event kinds, the saga compensation model) don't map 1:1 onto any of them — adopting one would mean re-defining our schemas to fit theirs.
  - **Why not.** The contracts are already ours; the runtime is the missing piece. We don't need distributed-first for M3 (M3.5 adds that). When we do need scale-out, the `EventLog` + `ActivityRegistry` interfaces let us slot in a Temporal-backed `EventLog` adapter later without changing the engine's API.

- **Use an actor framework (akka.js, comedy, nact) for instance isolation.**
  - **Pros.** Per-instance actor gives natural concurrency boundary.
  - **Cons.** All three are sparsely maintained. The actor model adds complexity for the in-process case (which is single-threaded anyway).
  - **Why not.** Per-instance advisory lock + event-sourced projection gives the same isolation without an actor runtime.

- **Skip event sourcing — mutate `WorkflowInstance` records directly.**
  - **Pros.** Simpler day 1.
  - **Cons.** Loses replay, loses audit, loses the ability to debug "how did we get here?". The `WorkflowEvent` schema explicitly exists in ADR-0007 to enable this; throwing it away would require a re-design.
  - **Why not.** Event sourcing is the design.

- **Embed activity handlers in the engine (typed registry per known activity).**
  - **Pros.** Type-safe handler contract.
  - **Cons.** Consumers (verticals, apps) can't add their own activity kinds without forking the engine.
  - **Why not.** The registry is the extension point. Built-in handlers ship for the safe kinds; consumers register for their domain.

- **Run a background scheduler thread.**
  - **Considered.** A worker that polls for `waiting_for_timer` instances + advances them.
  - **Decision.** Deferred to M3.5. In-process M3 exposes `tickTimers(now)` as an explicit method — the consumer calls it on their own schedule (e.g., from a cron job or a test). Avoids surprising background work and makes tests deterministic.

- **Inline guard expression evaluation (built-in JS-like expression language).**
  - **Pros.** Self-contained.
  - **Cons.** A new mini-language is a security + maintenance burden. CEL / JMESPath / JSONata would be reinventions.
  - **Why not.** Default guard evaluator handles the simple kinds (always_true, variable_equals, variable_predicate). Complex `expression` guards are delegated to a consumer-supplied `GuardEvaluator`. Phase 3 can pick a real expression language and wire it in.

## Consequences

- **Third impure package.** `@crossengin/workflow-runtime` joins `@crossengin/kernel-pg` and `@crossengin/crypto` as runtime. Pure dependency-wise (no `pg`, no `libsodium`) — it only needs `@crossengin/workflow-engine` for shapes and `@crossengin/crypto` for hashing variable snapshots.
- **No new META_ tables.** The existing `META_WORKFLOW_*` tables (defined in `kernel/bootstrap/meta-schema.ts`) are the persistence shape. The runtime writes events; projections read them.
- **In-process scaling ceiling.** A single Node process can comfortably run ~1000 concurrent waiting instances + tick ~100 active steps/second. Beyond that, M3.5 distributes via a Postgres-backed `EventLog` and a worker pool.
- **Activity handlers are how integrations land.** Phase 2 M6 (notifications + workflow signal bridge) registers handlers for `send_notification`; Phase 2 M4 (gateway runtime) feeds signals via `submitSignal`. Both are consumers, not parts of the engine.
- **Replay is free.** Given the events for any instance, `projectInstance` reconstructs the full state. Useful for debugging production incidents.
- **Tests cover the engine end-to-end.** The bimodal pattern (pure modules + engine-with-mocks) gives ~150 tests. Integration tests against a real Postgres `EventLog` land with M3.5.

## Open questions

- **Q1:** How do we handle handlers that take longer than the activity `timeoutSeconds`?
  - _Current direction:_ The engine doesn't enforce timeout from inside; `tickTimers` is the timeout source. A registered handler that hangs will block `runActivityNow` — the consumer is responsible for `Promise.race` with a wall-clock timer if they want to wall-bound a handler. M3.5 with workers will enforce via worker-side timeouts.
- **Q2:** Are signals delivered to all waiting instances matching `correlationKey` or just one?
  - _Current direction:_ All matching instances receive the signal; each instance's transition rules decide whether to consume. This matches the "fan-out" pattern common in webhooks. The signal's `consumedByActivityId` field tracks first-consumer semantics for `at_most_once` delivery.
- **Q3:** Should the engine snapshot variables to a sha256 in `variable_updated` events?
  - _Current direction:_ Yes. The event payload includes both the new value and the sha256 of the canonical JSON. Replay verifies the chain.
- **Q4:** What's the policy for handlers that mutate `instance.variables`?
  - _Current direction:_ Handlers cannot mutate directly — they return outputs, and the engine emits `variable_updated` events based on the activity's declared variable mappings. Side-effecting state changes are visible in the event log.
- **Q5:** How does compensation interact with child workflows?
  - _Current direction:_ Child workflows are themselves instances; their compensation runs first (recursively), then the parent's. The parent waits on `child_workflow_completed` events during compensation.

## References

- **Pat Helland — "Life Beyond Distributed Transactions"** (saga pattern foundations)
- **Greg Young — "CQRS and Event Sourcing"** (event-sourcing semantics)
- **Temporal documentation** (deterministic replay; we borrow the concept)
- **ADR-0007** (workflow engine contracts)
- **ADR-0041** (workflow runtime contracts — definitions, activities, signals, timers, history)
- **ADR-0046** (Phase 2 plan, M3)
