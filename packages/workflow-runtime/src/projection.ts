import {
  INSTANCE_CANCELLATION_DISPOSITIONS,
  type ActivityStatus,
  type InstanceCancellationDisposition,
  type SignalStatus,
  type TimerStatus,
  type WorkflowActivity,
  type WorkflowDefinition,
  type WorkflowEvent,
  type WorkflowInstance,
  type WorkflowSignal,
  type WorkflowTimer,
} from "@crossengin/workflow-engine";

export interface ProjectedInstance {
  readonly instanceId: string;
  readonly tenantId: string;
  readonly definitionId: string;
  readonly definitionKey: string;
  readonly definitionVersion: string;
  readonly status: WorkflowInstance["status"];
  readonly currentState: string;
  readonly variables: Record<string, unknown>;
  readonly correlationKey: string | null;
  readonly parentInstanceId: string | null;
  readonly startedAt: string;
  readonly startedByUserId: string | null;
  readonly startedBySystem: string | null;
  readonly lastTransitionAt: string;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  readonly cancelledByUserId: string | null;
  readonly cancelledReason: string | null;
  /**
   * When a cancellation was *requested*, which is the fence the driver reads — not the status.
   * Adding a `cancelling` status would widen `INSTANCE_STATUSES`, and that enum is a CHECK
   * constraint on `meta.workflow_instances.status`: no existing row can carry a new status, but an
   * existing *constraint* would reject one, so widening it is not the additive change widening
   * `EVENT_KINDS` is. A field, as in ADR-0315, where `cancel_requested_at` *is* the cancellation.
   */
  readonly cancellationRequestedAt: string | null;
  readonly cancellationRequestedBy: string | null;
  /** `null` also when the stored event's disposition is unreadable — never silently one of the two. */
  readonly cancellationDisposition: InstanceCancellationDisposition | null;
  /** Activities told to stop, i.e. cancelled at `cooperative_abort`. */
  readonly cancellationSignalledActivityIds: readonly string[];
  readonly failedAt: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly suspendedAt: string | null;
  readonly suspendedReason: string | null;
  readonly compensationStartedAt: string | null;
  readonly compensationCompletedAt: string | null;
  readonly timeoutAt: string;
  readonly sequenceCursor: number;
  readonly awaitingActivityIds: readonly string[];
  readonly awaitingSignalNames: readonly string[];
  readonly awaitingTimerNames: readonly string[];
}

/** Whether the log says this instance reached `cancelled`. Derived; never stored twice. */
export function isInstanceCancelled(instance: ProjectedInstance): boolean {
  return instance.status === "cancelled";
}

/**
 * Whether a cancellation has begun — the fence every driver loop consults.
 *
 * `status === "cancelled"` is part of the answer and not a redundancy: an `instance_cancelled` can
 * reach the log with no preceding request event, both from a definition's `terminal_cancelled` state
 * and from any log written before this contract existed. Reading only the request field would let a
 * cancelled instance's timers keep firing.
 */
export function isInstanceCancellationRequested(instance: ProjectedInstance): boolean {
  return instance.cancellationRequestedAt !== null || instance.status === "cancelled";
}

interface MutableInstanceState {
  instanceId: string;
  tenantId: string;
  definitionId: string;
  definitionKey: string;
  definitionVersion: string;
  status: WorkflowInstance["status"];
  currentState: string;
  variables: Record<string, unknown>;
  correlationKey: string | null;
  parentInstanceId: string | null;
  startedAt: string;
  startedByUserId: string | null;
  startedBySystem: string | null;
  lastTransitionAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelledByUserId: string | null;
  cancelledReason: string | null;
  cancellationRequestedAt: string | null;
  cancellationRequestedBy: string | null;
  cancellationDisposition: InstanceCancellationDisposition | null;
  cancellationSignalledActivityIds: Set<string>;
  failedAt: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  compensationStartedAt: string | null;
  compensationCompletedAt: string | null;
  timeoutAt: string;
  sequenceCursor: number;
  awaitingActivityIds: Set<string>;
  awaitingSignalNames: Set<string>;
  awaitingTimerNames: Set<string>;
}

function asString(value: unknown, fallback: string | null = null): string | null {
  if (typeof value === "string") return value;
  return fallback;
}

function asPlainObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * A stored disposition, or `null` when the payload does not carry one of the two. Deliberately not
 * defaulted: `abandon` would skip a rollback nobody declined and `compensate` would run one nobody
 * asked for, so an unreadable value stays unreadable. Nothing in the driver turns on it — the fence
 * is `cancellationRequestedAt`, which no payload edit can make ambiguous.
 */
function asDisposition(value: unknown): InstanceCancellationDisposition | null {
  return INSTANCE_CANCELLATION_DISPOSITIONS.find((d) => d === value) ?? null;
}

/**
 * The one writer of `state.status` once the fold is under way, and the seal that makes a
 * cancellation mean something.
 *
 * A cancellation promises that no further work is *started*, not that work already inside a handler
 * stops (ADR-0315). So an in-flight activity may still report `activity_completed` *after*
 * `instance_cancelled` — that report is a fact and belongs in the log. Letting it move the status
 * would resurrect a cancelled instance from its own epilogue, which is the one thing a terminal
 * event must prevent.
 */
function setStatus(state: MutableInstanceState, next: WorkflowInstance["status"]): void {
  if (state.status === "cancelled") return;
  state.status = next;
}

export function projectInstance(
  events: readonly WorkflowEvent[],
  definition?: WorkflowDefinition,
): ProjectedInstance | null {
  if (events.length === 0) return null;
  const first = events[0]!;
  if (first.kind !== "instance_started") {
    throw new Error(
      `first event for instance ${first.instanceId} must be instance_started, got ${first.kind}`,
    );
  }
  const payload = first.payload;

  const state: MutableInstanceState = {
    instanceId: first.instanceId,
    tenantId: first.tenantId,
    definitionId: asString(payload["definitionId"], "") ?? "",
    definitionKey: asString(payload["definitionKey"], "") ?? "",
    definitionVersion: asString(payload["definitionVersion"], "") ?? "",
    status: "created",
    currentState: asString(payload["initialState"], "") ?? "",
    variables: asPlainObject(payload["variables"]),
    correlationKey: asString(payload["correlationKey"]),
    parentInstanceId: asString(payload["parentInstanceId"]),
    startedAt: first.occurredAt,
    startedByUserId: first.actorPrincipalId,
    startedBySystem: first.actorSystemId,
    lastTransitionAt: first.occurredAt,
    completedAt: null,
    cancelledAt: null,
    cancelledByUserId: null,
    cancelledReason: null,
    cancellationRequestedAt: null,
    cancellationRequestedBy: null,
    cancellationDisposition: null,
    cancellationSignalledActivityIds: new Set(),
    failedAt: null,
    failureCode: null,
    failureMessage: null,
    suspendedAt: null,
    suspendedReason: null,
    compensationStartedAt: null,
    compensationCompletedAt: null,
    timeoutAt: asString(payload["timeoutAt"], first.occurredAt) ?? first.occurredAt,
    sequenceCursor: first.sequenceNumber,
    awaitingActivityIds: new Set(),
    awaitingSignalNames: new Set(),
    awaitingTimerNames: new Set(),
  };
  state.status = "running";

  for (let i = 1; i < events.length; i++) {
    applyEvent(state, events[i]!);
  }

  if (definition !== undefined) {
    refineStatusFromDefinition(state, definition);
  }

  return freeze(state);
}

function refineStatusFromDefinition(
  state: MutableInstanceState,
  definition: WorkflowDefinition,
): void {
  if (
    state.status === "completed" ||
    state.status === "failed" ||
    state.status === "cancelled" ||
    state.status === "compensated" ||
    state.status === "compensating" ||
    state.status === "suspended" ||
    state.status === "waiting_for_activity" ||
    state.status === "waiting_for_timer"
  ) {
    return;
  }
  const stateDef = definition.states.find((s) => s.name === state.currentState);
  if (stateDef === undefined) return;
  if (stateDef.kind === "manual_approval") {
    state.status = "waiting_for_manual";
    return;
  }
  if (stateDef.kind === "waiting") {
    const outgoing = definition.transitions.filter((t) => t.fromState === state.currentState);
    if (outgoing.some((t) => t.trigger.kind === "signal_received")) {
      state.status = "waiting_for_signal";
      for (const t of outgoing) {
        if (t.trigger.kind === "signal_received") {
          state.awaitingSignalNames.add(t.trigger.signalName);
        }
      }
      return;
    }
    if (outgoing.some((t) => t.trigger.kind === "timer_fired")) {
      state.status = "waiting_for_timer";
      return;
    }
    if (outgoing.some((t) => t.trigger.kind === "manual_action")) {
      state.status = "waiting_for_manual";
      return;
    }
  }
}

function applyEvent(state: MutableInstanceState, event: WorkflowEvent): void {
  state.sequenceCursor = event.sequenceNumber;
  state.lastTransitionAt = event.occurredAt;

  switch (event.kind) {
    case "instance_started":
      throw new Error(
        `unexpected duplicate instance_started for ${event.instanceId} at seq ${event.sequenceNumber}`,
      );
    case "state_transitioned": {
      if (event.newState !== null) state.currentState = event.newState;
      if (state.status !== "compensating" && state.status !== "suspended") {
        setStatus(state, "running");
      }
      return;
    }
    case "instance_completed": {
      setStatus(state, "completed");
      state.completedAt = event.occurredAt;
      return;
    }
    case "instance_failed": {
      setStatus(state, "failed");
      state.failedAt = event.occurredAt;
      state.failureCode = asString(event.payload["errorCode"]);
      state.failureMessage = asString(event.payload["errorMessage"]);
      return;
    }
    case "instance_cancellation_requested": {
      // The fence, and not a status change: the instance keeps standing where it stood until the
      // finalizing event, because between the two an in-flight handler is still running.
      state.cancellationRequestedAt = event.occurredAt;
      state.cancellationRequestedBy = event.actorPrincipalId ?? event.actorSystemId;
      state.cancellationDisposition = asDisposition(event.payload["disposition"]);
      return;
    }
    case "instance_cancelled": {
      setStatus(state, "cancelled");
      state.cancelledAt = event.occurredAt;
      state.cancelledByUserId = event.actorPrincipalId;
      state.cancelledReason = asString(event.payload["reason"]);
      return;
    }
    case "instance_suspended": {
      setStatus(state, "suspended");
      state.suspendedAt = event.occurredAt;
      state.suspendedReason = asString(event.payload["reason"]);
      return;
    }
    case "instance_resumed": {
      setStatus(state, "running");
      state.suspendedAt = null;
      state.suspendedReason = null;
      return;
    }
    case "activity_scheduled": {
      if (event.activityId !== null) {
        state.awaitingActivityIds.add(event.activityId);
        setStatus(state, "waiting_for_activity");
      }
      return;
    }
    case "activity_started":
      return;
    case "activity_cancelled": {
      if (event.activityId !== null) {
        state.awaitingActivityIds.delete(event.activityId);
        if (asString(event.payload["checkpoint"]) === "cooperative_abort") {
          state.cancellationSignalledActivityIds.add(event.activityId);
        }
      }
      if (state.awaitingActivityIds.size === 0 && state.status === "waiting_for_activity") {
        setStatus(state, "running");
      }
      return;
    }
    case "activity_completed":
    case "activity_failed":
    case "activity_timed_out":
    case "activity_compensated": {
      if (event.activityId !== null) {
        state.awaitingActivityIds.delete(event.activityId);
      }
      if (state.awaitingActivityIds.size === 0 && state.status === "waiting_for_activity") {
        setStatus(state, "running");
      }
      return;
    }
    case "timer_scheduled": {
      const name = asString(event.payload["timerName"]);
      if (name !== null) {
        state.awaitingTimerNames.add(name);
        setStatus(state, "waiting_for_timer");
      }
      return;
    }
    case "timer_fired":
    case "timer_cancelled": {
      const name = asString(event.payload["timerName"]);
      if (name !== null) {
        state.awaitingTimerNames.delete(name);
      }
      if (state.awaitingTimerNames.size === 0 && state.status === "waiting_for_timer") {
        setStatus(state, "running");
      }
      return;
    }
    case "signal_received":
      return;
    case "signal_consumed": {
      const name = asString(event.payload["signalName"]);
      if (name !== null) {
        state.awaitingSignalNames.delete(name);
      }
      if (state.awaitingSignalNames.size === 0 && state.status === "waiting_for_signal") {
        setStatus(state, "running");
      }
      return;
    }
    case "variable_updated": {
      if (event.variableName !== null) {
        state.variables = { ...state.variables, [event.variableName]: event.payload["newValue"] };
      }
      return;
    }
    case "compensation_started": {
      setStatus(state, "compensating");
      state.compensationStartedAt = event.occurredAt;
      return;
    }
    case "compensation_step_completed":
      return;
    case "compensation_completed": {
      setStatus(state, "compensated");
      state.compensationCompletedAt = event.occurredAt;
      return;
    }
    case "manual_action_taken":
      return;
    case "child_workflow_spawned":
    case "child_workflow_completed":
      return;
  }
}

function freeze(state: MutableInstanceState): ProjectedInstance {
  return {
    instanceId: state.instanceId,
    tenantId: state.tenantId,
    definitionId: state.definitionId,
    definitionKey: state.definitionKey,
    definitionVersion: state.definitionVersion,
    status: state.status,
    currentState: state.currentState,
    variables: { ...state.variables },
    correlationKey: state.correlationKey,
    parentInstanceId: state.parentInstanceId,
    startedAt: state.startedAt,
    startedByUserId: state.startedByUserId,
    startedBySystem: state.startedBySystem,
    lastTransitionAt: state.lastTransitionAt,
    completedAt: state.completedAt,
    cancelledAt: state.cancelledAt,
    cancelledByUserId: state.cancelledByUserId,
    cancelledReason: state.cancelledReason,
    cancellationRequestedAt: state.cancellationRequestedAt,
    cancellationRequestedBy: state.cancellationRequestedBy,
    cancellationDisposition: state.cancellationDisposition,
    cancellationSignalledActivityIds: [...state.cancellationSignalledActivityIds],
    failedAt: state.failedAt,
    failureCode: state.failureCode,
    failureMessage: state.failureMessage,
    suspendedAt: state.suspendedAt,
    suspendedReason: state.suspendedReason,
    compensationStartedAt: state.compensationStartedAt,
    compensationCompletedAt: state.compensationCompletedAt,
    timeoutAt: state.timeoutAt,
    sequenceCursor: state.sequenceCursor,
    awaitingActivityIds: [...state.awaitingActivityIds],
    awaitingSignalNames: [...state.awaitingSignalNames],
    awaitingTimerNames: [...state.awaitingTimerNames],
  };
}

interface MutableActivity {
  id: string;
  instanceId: string;
  tenantId: string;
  kind: WorkflowActivity["kind"];
  definitionActivityKey: string;
  status: ActivityStatus;
  attemptNumber: number;
  scheduledAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  inputSha256: string | null;
  outputSha256: string | null;
}

export function projectActivities(events: readonly WorkflowEvent[]): readonly MutableActivity[] {
  const byId = new Map<string, MutableActivity>();
  for (const event of events) {
    if (event.activityId === null) continue;
    const id = event.activityId;
    if (event.kind === "activity_scheduled") {
      byId.set(id, {
        id,
        instanceId: event.instanceId,
        tenantId: event.tenantId,
        kind: (event.payload["kind"] as WorkflowActivity["kind"]) ?? "transformation",
        definitionActivityKey:
          (asString(event.payload["definitionActivityKey"], "activity") ?? "activity"),
        status: "scheduled",
        attemptNumber:
          typeof event.payload["attemptNumber"] === "number"
            ? (event.payload["attemptNumber"] as number)
            : 1,
        // A retry backoff persists an `availableAt` so the projected scheduled_at defers the claim;
        // absent ⇒ due at the schedule instant.
        scheduledAt: asString(event.payload["availableAt"], event.occurredAt) ?? event.occurredAt,
        startedAt: null,
        completedAt: null,
        errorCode: null,
        errorMessage: null,
        inputSha256: asString(event.payload["inputSha256"]),
        outputSha256: null,
      });
      continue;
    }
    const existing = byId.get(id);
    if (existing === undefined) continue;
    // `cancelled` seals an activity exactly as it seals an instance, and for the reason ADR-0315
    // states as its promise: "a handler which ignores the signal still lands as `cancelled` rather
    // than `completed`, unless it genuinely finished first". A late report still records *what it
    // produced* below — the status is sealed, the evidence is not suppressed.
    const sealed = existing.status === "cancelled";
    if (event.kind === "activity_started") {
      if (!sealed) existing.status = "running";
      existing.startedAt = event.occurredAt;
    } else if (event.kind === "activity_completed") {
      if (!sealed) existing.status = "succeeded";
      existing.completedAt = event.occurredAt;
      existing.outputSha256 = asString(event.payload["outputSha256"]);
    } else if (event.kind === "activity_failed") {
      if (!sealed) existing.status = "failed";
      existing.completedAt = event.occurredAt;
      existing.errorCode = asString(event.payload["errorCode"]);
      existing.errorMessage = asString(event.payload["errorMessage"]);
    } else if (event.kind === "activity_timed_out") {
      if (!sealed) existing.status = "timed_out";
      existing.completedAt = event.occurredAt;
    } else if (event.kind === "activity_cancelled") {
      existing.status = "cancelled";
    } else if (event.kind === "activity_compensated") {
      // Not gated by the seal: compensating a cancelled activity is a legal onward move
      // (`ACTIVITY_TRANSITIONS.cancelled` is empty, but the saga path records the undo of work that
      // did happen) — and `listCompensatableActivities` keys off this event to stay idempotent.
      existing.status = "compensated";
    }
  }
  return [...byId.values()];
}

interface MutableSignal {
  id: string;
  instanceId: string | null;
  tenantId: string;
  signalName: string;
  correlationKey: string;
  status: SignalStatus;
  receivedAt: string;
  matchedAt: string | null;
  consumedAt: string | null;
}

export function projectSignals(events: readonly WorkflowEvent[]): readonly MutableSignal[] {
  const byId = new Map<string, MutableSignal>();
  for (const event of events) {
    if (event.signalId === null) continue;
    const id = event.signalId;
    if (event.kind === "signal_received") {
      byId.set(id, {
        id,
        instanceId: event.instanceId,
        tenantId: event.tenantId,
        signalName: asString(event.payload["signalName"], "") ?? "",
        correlationKey: asString(event.payload["correlationKey"], "") ?? "",
        status: "matched_to_instance",
        receivedAt: event.occurredAt,
        matchedAt: event.occurredAt,
        consumedAt: null,
      });
      continue;
    }
    if (event.kind === "signal_consumed") {
      const existing = byId.get(id);
      if (existing !== undefined) {
        existing.status = "consumed";
        existing.consumedAt = event.occurredAt;
      }
    }
  }
  return [...byId.values()];
}

interface MutableTimer {
  id: string;
  instanceId: string;
  tenantId: string;
  timerName: string;
  status: TimerStatus;
  scheduledAt: string;
  fireAt: string;
  firedAt: string | null;
  cancelledAt: string | null;
}

export function projectTimers(events: readonly WorkflowEvent[]): readonly MutableTimer[] {
  const byId = new Map<string, MutableTimer>();
  for (const event of events) {
    if (event.timerId === null) continue;
    const id = event.timerId;
    if (event.kind === "timer_scheduled") {
      byId.set(id, {
        id,
        instanceId: event.instanceId,
        tenantId: event.tenantId,
        timerName: asString(event.payload["timerName"], "") ?? "",
        status: "scheduled",
        scheduledAt: event.occurredAt,
        fireAt: asString(event.payload["fireAt"], event.occurredAt) ?? event.occurredAt,
        firedAt: null,
        cancelledAt: null,
      });
      continue;
    }
    const existing = byId.get(id);
    if (existing === undefined) continue;
    if (event.kind === "timer_fired") {
      existing.status = "fired";
      existing.firedAt = event.occurredAt;
    } else if (event.kind === "timer_cancelled") {
      existing.status = "cancelled";
      existing.cancelledAt = event.occurredAt;
    }
  }
  return [...byId.values()];
}

export type { WorkflowSignal, WorkflowTimer };
