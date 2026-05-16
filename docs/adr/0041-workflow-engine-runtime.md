# ADR-0041: Workflow engine runtime contracts

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-16 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0007 (workflow engine — declarative manifests), ADR-0008 (audit), ADR-0011 (integration mesh), ADR-0014 (files), ADR-0025 (AI Architect safety), ADR-0037 (incident response), ADR-0039 (notifications), ADR-0040 (access reviews) |

## Context

ADR-0007 covered the **declarative** side of workflows: what an admin can put in a manifest (states, transitions, guards, SLAs). `packages/kernel/src/workflow/types.ts` carries that as zod types. What we still lacked was the **runtime** side: what does a *running* workflow instance look like, what does an activity execution record look like, how do we model timer firings and external signals, how does saga compensation work mechanically, and what does the event history that lets us replay an instance to any point in time look like.

Every vertical app family in the brand map needs business workflows:

- **Operate ERP** — purchase requisitions, AP approval chains, employee onboarding, RMA flows.
- **Heal** — patient admissions, discharge, lab result review, prior authorization, claims adjudication.
- **Govern** — permit / license applications, citizen-service requests, procurement cycles, court case management.
- **Educate** — admissions cycles, financial aid, course approval, degree audit.
- **Serve** — grant cycles (apply → review → award → report), donor pledge fulfillment.
- **CrossEngin Core** — incident response runbooks (ADR-0037), tenant onboarding (ADR-0028), access-review campaigns (ADR-0040), DR drills (ADR-0031), ML training pipelines (ADR-0029).

Without a unified runtime contract, every package that wants a stateful, durable, recoverable, replayable, fan-out/join business process invents its own state machine, retry policy, and history log — which is exactly the drift we've spent the last 35 packages avoiding.

This ADR establishes the runtime contracts. It does **not** include the actual scheduler/worker, the SQL applier, the timer service, the signal correlator, or the activity executor — those are Phase 2 build artifacts that consume these contract types.

## Decision

Workflow-engine contract has **seven modules** in `@crossengin/workflow-engine`:

1. **`definitions.ts`.** Canonical executable form. Ten state kinds (initial, intermediate, waiting, parallel_fork, parallel_join, decision, manual_approval, terminal_success, terminal_failure, terminal_cancelled) with `TERMINAL_STATE_KINDS` set. Seven trigger kinds discriminated union (automatic, signal_received, timer_fired, activity_completed, activity_failed, manual_action, child_workflow_completed). Six guard kinds discriminated union (always_true, expression, role_required, abac_check, variable_equals, variable_predicate). Eight action kinds (set_variable, emit_event, schedule_activity, schedule_timer, cancel_timer, spawn_child_workflow, send_signal, audit_log). Seven variable types. Five-state definition lifecycle (draft → in_review → published → deprecated → retired) with `DEFINITION_TRANSITIONS` map. Four compensation strategies (immediate_reverse_order, parallel, manual_review, no_compensation). `WorkflowDefinition` enforces: exactly one initial state; ≥ 1 terminal state; no transition departs from terminal; transitions reference declared states; triggers reference declared signals/timers; guards reference declared variables; published requires four-eyes (publishedBy ≠ createdBy). Helpers: `findUnreachableStates(definition)` (graph reachability from initial), `isTerminalState`, `validTransitionsFrom`.

2. **`instances.ts`.** Twelve instance statuses (created → running → waiting_for_signal/timer/activity/manual → suspended → completed/failed/cancelled/compensating/compensated) with state machine — `ACTIVE_INSTANCE_STATUSES` and `TERMINAL_INSTANCE_STATUSES` sets partition them. Fifteen related-entity kinds (purchase_request, invoice, patient_admission, permit_application, license_request, claim, ticket, contract, deployment, tenant_signup, user_offboarding, ml_training_run, access_review_campaign, incident, custom) bind a workflow instance to its business-object owner. `WorkflowInstance` enforces: lastTransitionAt ≥ startedAt; timeoutAt > startedAt; status-specific required-field invariants (completed → completedAt; cancelled → cancelledReason; failed → failureCode + failureMessage; suspended → suspendedReason; compensating → compensationStartedAt); waiting statuses require non-empty `awaitingSignalNames` / `awaitingTimerNames` / `awaitingActivityIds`; instance must have either startedByUserId or startedBySystem set. `transitionInstance` is the only safe state-change helper — it throws on invalid transitions and bumps the per-instance sequence cursor.

3. **`activities.ts`.** Ten activity kinds partitioned into `IDEMPOTENT_ACTIVITY_KINDS` (db_read, transformation, audit_emit) and `SIDE_EFFECT_ACTIVITY_KINDS` (http_call, db_write, ai_call, send_notification, child_workflow). Eight statuses (pending → scheduled → running → succeeded / failed / cancelled / compensated / timed_out) with transitions allowing `succeeded → compensated` and `failed → compensated` for saga rollback. Four retry strategies (exponential_backoff, fixed_delay, linear_backoff, no_retry). `RetryPolicy` enforces maxDelay ≥ initialDelay, no_retry has maxAttempts=1, no overlap between retryable/non-retryable error codes. `WorkflowActivity` enforces: attemptNumber ≤ maxAttempts; succeeded requires outputSha256; failed requires errorCode + errorMessage; **side-effect failed activity requires compensationActivityKey** (saga safety); compensation activity requires compensatesActivityId; manual_task succeeded requires completedByUserId; child_workflow succeeded requires childWorkflowInstanceId; completedAt ≥ startedAt ≥ scheduledAt; timeoutAt > scheduledAt. `decideActivityRetry` returns retry-or-give-up decisions respecting strategy + max attempts + retryable/non-retryable allowlists.

4. **`signals.ts`.** Three delivery guarantees (at_most_once, at_least_once, exactly_once_idempotent). Five statuses (received → matched_to_instance → consumed; or expired/rejected as terminals). Seven rejection reasons (no_matching_instance, instance_terminal, signal_not_declared, duplicate_idempotency_key, payload_schema_mismatch, expired_before_match, tenant_mismatch). `WorkflowSignal` enforces: exactly_once_idempotent requires idempotencyKey; payloadStorageUri requires payloadSha256; matched/consumed/rejected statuses require their respective timestamp + cause fields; matchedAt ≥ receivedAt. Helpers: `isSignalExpired`, `findDuplicateSignal` (by name + idempotencyKey, the safe dedupe), `matchSignalToInstance` (by tenant + correlationKey + awaitingSignalNames intersection).

5. **`timers.ts`.** Four timer kinds (absolute_at, relative_after, cron_schedule, business_hours). Four statuses (scheduled → fired / cancelled / expired_before_fire). `WorkflowTimer` enforces: fireAt > scheduledAt; cron_schedule needs cronExpression; relative_after needs relativeSeconds; fired needs firedAt + fireCount ≥ 1; cancelled needs cancelledReason; non-cron timers fire at most once (fireCount ≤ 1); fired cron timer requires nextFireAt (recurring timers compute next fire). `fireTimer` and `cancelTimer` are state-machine-safe helpers that throw on invalid transitions. `isWithinBusinessHours` is a pure helper for business-hours timers (workdays + start/end minutes-since-midnight) — timezone resolution is the caller's concern.

6. **`compensation.ts`.** Saga compensation surface. Five plan statuses (computed → executing → completed / failed / abandoned; failed can re-enter executing). `computeCompensationPlan` is the deterministic algorithm: given executed activities + strategy, produce the ordered compensation steps. `immediate_reverse_order` produces LIFO (newest succeeded side-effect compensated first); `parallel` produces forward order (the executor fans out); `manual_review` produces the same set but with `requiresManualReview=true` for human gating; `no_compensation` produces empty. `CompensationPlan` enforces: no_compensation → empty steps; manual_review → requiresManualReview=true; counts consistency (succeededSteps + failedSteps ≤ totalSteps); completed plan must have all steps resolved; immediate_reverse_order requires dense orderIndex (0..n-1); abandoned requires abandonedReason. `findUnreversibleSideEffects` flags activities that succeeded but have no compensationActivityKey — useful for pre-publish lint to catch missing saga coverage.

7. **`history.ts`.** Twenty-five event kinds covering instance lifecycle (started/completed/failed/cancelled/suspended/resumed), state transitions, activity scheduling/start/complete/fail/timeout/compensate, signal received/consumed, timer scheduled/fired/cancelled, variable updates, compensation lifecycle (started/step_completed/completed), manual actions, child workflows (spawned/completed). `STATE_CHANGING_EVENTS`, `ACTIVITY_EVENTS`, `SIGNAL_EVENTS`, `TIMER_EVENTS` ReadonlySets partition them. `WorkflowEvent` enforces: state_transitioned requires distinct previousState + newState; activity/signal/timer/child events require their respective FK columns; variable_updated requires variableName; manual_action_taken requires actorPrincipalId; everything else requires either actorPrincipalId or actorSystemId (except system-fired timer/timeout events). Helpers: `summarizeInstanceHistory` (totalEvents + by-category counts + duration), `isHistoryDense` (sequenceNumber must be 0..n-1, no gaps — critical for replay correctness), `reconstructStateTimeline` (deterministic state-by-state replay).

Six meta-schema tables wired into kernel:

- **META_WORKFLOW_DEFINITIONS** — nullable tenant_id (platform definitions) with custom RLS. Unique on (tenant_id, definition_key, version).
- **META_WORKFLOW_INSTANCES** — RESTRICT FK to definitions. Self-referencing FK on parent_instance_id (child workflows). 12-status check.
- **META_WORKFLOW_ACTIVITIES** — CASCADE FK to instances. 10-kind check, 8-status check.
- **META_WORKFLOW_SIGNALS** — RESTRICT FK to instances (nullable; orphan signals can exist pre-match). Unique on (tenant_id, signal_name, idempotency_key) for exactly_once_idempotent dedupe.
- **META_WORKFLOW_TIMERS** — CASCADE FK to instances. 4-kind, 4-status checks.
- **META_WORKFLOW_EVENTS** — CASCADE FK to instances. Unique on (instance_id, sequence_number) — append-only ordering invariant enforced at the DDL layer.

Updated kernel test rule: the "FK references must resolve to a table declared earlier" invariant now also allows **self-references** (parent_instance_id → workflow_instances). Postgres handles forward-references in CREATE TABLE via deferred constraint resolution.

## Alternatives considered

- **Option A:** Use the existing `kernel/workflow/types.ts` for runtime state too.
  - **Pros:** No new package.
  - **Cons:** The kernel module is the *declarative* surface (what a manifest author writes). Conflating it with the *runtime* state (what a running engine tracks) creates a tangled type graph: `WorkflowState` would suddenly need fields for the current instance's variables, retry counts, etc. Keeping them separate (kernel = decl, workflow-engine = runtime) mirrors how Temporal / Cadence / Step Functions / BPMN tools split the two.
  - **Why not:** Two distinct concerns deserve two distinct contract types.

- **Option B:** Adopt Temporal or Cadence's SDK shapes as-is.
  - **Pros:** Battle-tested model.
  - **Cons:** Strong opinions about event-sourcing internals (Temporal's `WorkflowExecutionStartedEventAttributes` etc.) that leak into our contract. Their model is also runtime-specific (gRPC, protobuf) where we want pure zod types. We can borrow the conceptual model without inheriting the specifics.
  - **Why not:** Temporal's model informed this design (event history with sequence numbers, dense replay, signals, timers, child workflows) but we encode it as plain zod types that any Phase 2 runtime can consume.

- **Option C:** Skip the saga / compensation surface in v1.
  - **Pros:** Smaller surface.
  - **Cons:** Half the use cases for a workflow engine in regulated industries are saga-shaped (book inventory → charge card → send confirmation; if charge fails, release inventory). Without a typed compensation contract, every package would re-invent the rollback semantics.
  - **Why not:** Compensation is core, not optional.

- **Option D:** Inline event history into `WorkflowInstance.events: []`.
  - **Pros:** One record per instance.
  - **Cons:** Append-only event logs benefit massively from being a separate, partitioned table with their own (instance_id, sequence_number) unique index. Jamming them into a JSONB column on instances ruins the write pattern (every event becomes an instance UPDATE) and the read pattern (paginating history per instance is awkward).
  - **Why not:** Event log is a first-class table.

- **Option E:** Make all activities idempotent by contract.
  - **Pros:** Simpler retry semantics.
  - **Cons:** Real-world activities (HTTP POSTs to external APIs, AI calls with cost) are not idempotent without explicit idempotency keys — and not all external systems honor those. The contract distinguishes `IDEMPOTENT_ACTIVITY_KINDS` (safe to retry) from `SIDE_EFFECT_ACTIVITY_KINDS` (must declare a compensation activity for saga rollback). Conflating the two creates dangerous assumptions in retry logic.
  - **Why not:** The distinction is semantically important.

- **Option F:** Allow self-transitions on states (loops).
  - **Pros:** Models stateful loops naturally (e.g., "stay in `pending` until N signals received").
  - **Cons:** Allowing `state_transitioned` events where prev === new makes the state-timeline reconstruction noisy and the history hard to read. Loops are better modeled via the variable layer + signals (counter variable + signal that bumps it + guard on counter ≥ N).
  - **Why not:** State_transitioned events must change state; loops live at the variable + signal layer.

## Consequences

- **Every package gets a workflow vocabulary.** Incident-response runbook executions, access-review campaigns, ML training pipelines, tenant lifecycle transitions can all be re-implemented as workflow instances in Phase 2, sharing one event log, one retry engine, one compensation runtime.
- **Replay is well-defined.** `isHistoryDense` + (instance_id, sequence_number) uniqueness mean any Phase 2 runtime can replay an instance from event 0 to event N deterministically. This is the foundation for "what would have happened if I'd answered yes at step 3?" debug tools.
- **Saga safety baked in at schema validation.** A workflow definition that has a side-effect activity without a compensation key fails validation (`findUnreversibleSideEffects` makes this visible pre-publish).
- **Multi-region replicable.** Events are append-only and ordered per-instance; replication topologies from ADR-0032 (active-active) can fan-out from this log without conflict.
- **Audit-friendly.** Each event records actorPrincipalId or actorSystemId — combined with `@crossengin/forensics` hash-chained audit, regulators get a queryable record of "who did what when in workflow X."

## Open questions

- **Q1:** Should we model **versioned in-flight migration** (a definition v2.0.0 supersedes v1.0.0 — what about instances mid-run on v1.0.0)?
  - _Current direction:_ Instances pin to `definitionVersion`. Phase 2 runtime decides whether to migrate (re-bind to v2) or run-to-completion (stay on v1). The contract carries both fields so either is possible.
- **Q2:** Long-running cron schedules (recurring timers that fire monthly for a year) — model as one timer that rolls forward (nextFireAt) or N separate timer instances?
  - _Current direction:_ One timer, rolls forward via nextFireAt on each fire. Audit trail comes from the event log (`timer_fired` events), not from separate timer records.
- **Q3:** Cross-tenant workflows (Tenant A's purchase order kicks off Tenant B's fulfillment workflow)?
  - _Current direction:_ Out of scope for v1. Each instance is tenant-scoped. Cross-tenant orchestration is a Phase 3 problem.
- **Q4:** Distributed transactions (XA, two-phase commit across activities)?
  - _Current direction:_ Saga is the answer — local transactions per activity, compensation on failure. No 2PC.
- **Q5:** Workflow analytics — query patterns like "average duration of purchase approvals broken down by department"?
  - _Current direction:_ Out of scope for the engine contract. The event log feeds `@crossengin/reporting` via CDC; analytics queries are reporting concerns.

## References

- Temporal — Workflows, Activities, Signals, Timers, Saga
- AWS Step Functions — State machine definition language
- BPMN 2.0 — Business Process Model and Notation (gateway, parallel fork/join, compensation)
- Sagas (Garcia-Molina & Salem, 1987) — Long-Lived Transactions
- ADR-0007 (workflow engine — manifest layer), ADR-0008 (audit), ADR-0011 (integration mesh), ADR-0014 (files), ADR-0025 (AI Architect safety), ADR-0037 (incident response), ADR-0039 (notifications), ADR-0040 (access reviews)
