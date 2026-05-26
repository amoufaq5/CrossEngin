import type {
  ActivityStatus,
  SignalStatus,
  TimerStatus,
  WorkflowActivity,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowInstance,
  WorkflowSignal,
  WorkflowTimer,
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
    if (outgoing.some((t) => t.trigger.kind === "child_workflow_completed")) {
      state.status = "waiting_for_child";
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
        state.status = "running";
      }
      return;
    }
    case "instance_completed": {
      state.status = "completed";
      state.completedAt = event.occurredAt;
      return;
    }
    case "instance_failed": {
      state.status = "failed";
      state.failedAt = event.occurredAt;
      state.failureCode = asString(event.payload["errorCode"]);
      state.failureMessage = asString(event.payload["errorMessage"]);
      return;
    }
    case "instance_cancelled": {
      state.status = "cancelled";
      state.cancelledAt = event.occurredAt;
      state.cancelledByUserId = event.actorPrincipalId;
      state.cancelledReason = asString(event.payload["reason"]);
      return;
    }
    case "instance_suspended": {
      state.status = "suspended";
      state.suspendedAt = event.occurredAt;
      state.suspendedReason = asString(event.payload["reason"]);
      return;
    }
    case "instance_resumed": {
      state.status = "running";
      state.suspendedAt = null;
      state.suspendedReason = null;
      return;
    }
    case "activity_scheduled": {
      if (event.activityId !== null) {
        state.awaitingActivityIds.add(event.activityId);
        state.status = "waiting_for_activity";
      }
      return;
    }
    case "activity_started":
      return;
    case "activity_completed":
    case "activity_failed":
    case "activity_timed_out":
    case "activity_compensated": {
      if (event.activityId !== null) {
        state.awaitingActivityIds.delete(event.activityId);
      }
      if (state.awaitingActivityIds.size === 0 && state.status === "waiting_for_activity") {
        state.status = "running";
      }
      return;
    }
    case "timer_scheduled": {
      const name = asString(event.payload["timerName"]);
      if (name !== null) {
        state.awaitingTimerNames.add(name);
        state.status = "waiting_for_timer";
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
        state.status = "running";
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
        state.status = "running";
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
      state.status = "compensating";
      state.compensationStartedAt = event.occurredAt;
      return;
    }
    case "compensation_step_completed":
      return;
    case "compensation_completed": {
      state.status = "compensated";
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
          asString(event.payload["definitionActivityKey"], "activity") ?? "activity",
        status: "scheduled",
        attemptNumber:
          typeof event.payload["attemptNumber"] === "number"
            ? (event.payload["attemptNumber"] as number)
            : 1,
        scheduledAt: event.occurredAt,
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
    if (event.kind === "activity_started") {
      existing.status = "running";
      existing.startedAt = event.occurredAt;
    } else if (event.kind === "activity_completed") {
      existing.status = "succeeded";
      existing.completedAt = event.occurredAt;
      existing.outputSha256 = asString(event.payload["outputSha256"]);
    } else if (event.kind === "activity_failed") {
      existing.status = "failed";
      existing.completedAt = event.occurredAt;
      existing.errorCode = asString(event.payload["errorCode"]);
      existing.errorMessage = asString(event.payload["errorMessage"]);
    } else if (event.kind === "activity_timed_out") {
      existing.status = "timed_out";
      existing.completedAt = event.occurredAt;
    } else if (event.kind === "activity_compensated") {
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
