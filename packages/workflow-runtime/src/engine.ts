import { sha256 } from "@crossengin/crypto";
import {
  TERMINAL_STATE_KINDS,
  type StateAction,
  type TransitionDefinition,
  type WorkflowDefinition,
  type WorkflowEvent,
} from "@crossengin/workflow-engine";

import {
  type ActivityInvocation,
  type ActivityOutcome,
  type ActivityRegistry,
  unsupportedHandler,
} from "./activity-handlers.js";
import { type Clock, type IdGenerator, SystemClock, RandomIdGenerator } from "./clock.js";
import { type EventLog } from "./event-log.js";
import { type ProjectedInstance, projectInstance } from "./projection.js";
import {
  type CompensationStep,
  compensationKindByActivityId,
  planCompensation,
} from "./saga.js";
import {
  type GuardEvaluator,
  defaultGuardEvaluator,
  evaluateNextTransition,
} from "./transitions.js";

const MAX_STEP_ITERATIONS = 1000;

/**
 * A retry backoff for a scheduled activity, in milliseconds (durations stay ms here to avoid an ISO
 * dependency in the core runtime). `null` ⇒ no backoff ⇒ immediate reschedule (the ADR-0184 behavior).
 */
export type ActivityRetryBackoff =
  | { readonly kind: "exponential" | "linear" | "constant"; readonly initialMs: number; readonly maxMs?: number }
  | null;

/** The delay (ms) before the next attempt of an activity that just failed on `attemptNumber` (1-based). */
export function activityRetryDelayMs(backoff: ActivityRetryBackoff, attemptNumber: number): number {
  if (backoff === null || backoff.initialMs <= 0) return 0;
  const n = Math.max(1, Math.floor(attemptNumber));
  let delay: number;
  switch (backoff.kind) {
    case "constant":
      delay = backoff.initialMs;
      break;
    case "linear":
      delay = backoff.initialMs * n;
      break;
    case "exponential":
      delay = backoff.initialMs * 2 ** (n - 1);
      break;
  }
  if (backoff.maxMs !== undefined) delay = Math.min(delay, backoff.maxMs);
  return Math.round(delay);
}

/** Reads a `schedule_activity` action's backoff parameters into an `ActivityRetryBackoff` (or `null`). */
export function parseActivityBackoff(params: Record<string, unknown>): ActivityRetryBackoff {
  const initial = params["retryBackoffMs"];
  if (typeof initial !== "number" || !Number.isFinite(initial) || initial <= 0) return null;
  const kindParam = params["retryBackoffKind"];
  const kind = kindParam === "linear" || kindParam === "constant" ? kindParam : "exponential";
  const maxMs = params["retryMaxBackoffMs"];
  return {
    kind,
    initialMs: Math.floor(initial),
    ...(typeof maxMs === "number" && Number.isFinite(maxMs) ? { maxMs: Math.floor(maxMs) } : {}),
  };
}

export interface EngineOptions {
  readonly eventLog: EventLog;
  readonly definitions: ReadonlyMap<string, WorkflowDefinition>;
  readonly activityRegistry: ActivityRegistry;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  readonly guardEvaluator?: GuardEvaluator;
  readonly systemActorId?: string;
  /**
   * When true, `schedule_activity` records the activity as `scheduled` (persisting its input) but
   * does NOT run the handler inline — a distributed worker claims + executes it later via
   * `executeScheduledActivity`. Default false (activities run inline, as before).
   */
  readonly deferActivities?: boolean;
}

export interface StartInstanceInput {
  readonly definitionId: string;
  readonly tenantId: string;
  readonly variables?: Record<string, unknown>;
  readonly correlationKey?: string;
  readonly parentInstanceId?: string;
  readonly startedByUserId?: string | null;
  readonly startedBySystem?: string | null;
}

export interface SubmitSignalInput {
  readonly signalName: string;
  readonly correlationKey: string;
  readonly tenantId: string;
  readonly payload?: Record<string, unknown>;
  readonly idempotencyKey?: string;
  readonly sourceSystem?: string;
}

export interface SubmitSignalResult {
  readonly deduplicated: boolean;
  readonly matchedInstanceIds: readonly string[];
  readonly signalId: string | null;
}

export interface TickTimersResult {
  readonly firedTimerIds: readonly string[];
  readonly affectedInstanceIds: readonly string[];
}

export interface CompensationResult {
  /** The instance's compensation strategy, or `null` when the instance/definition is unknown. */
  readonly strategy: WorkflowDefinition["compensationStrategy"] | null;
  /** The source activityIds compensated by this call (empty when nothing was outstanding). */
  readonly compensatedActivityIds: readonly string[];
}

export class WorkflowEngine {
  private readonly eventLog: EventLog;
  private readonly definitions: ReadonlyMap<string, WorkflowDefinition>;
  private readonly registry: ActivityRegistry;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly guardEvaluator: GuardEvaluator;
  private readonly systemActorId: string;
  private readonly deferActivities: boolean;
  private readonly seenSignalIdempotency: Set<string> = new Set();
  private readonly instanceTenant: Map<string, string> = new Map();
  private readonly instanceCorrelation: Map<string, string> = new Map();

  constructor(opts: EngineOptions) {
    this.eventLog = opts.eventLog;
    this.definitions = opts.definitions;
    this.registry = opts.activityRegistry;
    this.clock = opts.clock ?? new SystemClock();
    this.ids = opts.idGenerator ?? new RandomIdGenerator();
    this.guardEvaluator = opts.guardEvaluator ?? defaultGuardEvaluator;
    this.systemActorId = opts.systemActorId ?? "workflow-engine";
    this.deferActivities = opts.deferActivities ?? false;
  }

  async startInstance(input: StartInstanceInput): Promise<ProjectedInstance> {
    const definition = this.definitions.get(input.definitionId);
    if (definition === undefined) {
      throw new Error(`unknown workflow definition: ${input.definitionId}`);
    }
    if (definition.status !== "published") {
      throw new Error(
        `cannot start instance from ${definition.status} definition ${input.definitionId}`,
      );
    }
    if (definition.tenantId !== null && definition.tenantId !== input.tenantId) {
      throw new Error(
        `definition ${input.definitionId} belongs to tenant ${definition.tenantId}, not ${input.tenantId}`,
      );
    }

    const instanceId = this.ids.generate("wfi");
    const occurredAt = this.clock.nowIso();
    const timeoutAt = new Date(
      this.clock.now().getTime() + definition.timeoutSeconds * 1000,
    ).toISOString();

    this.instanceTenant.set(instanceId, input.tenantId);
    if (input.correlationKey !== undefined) {
      this.instanceCorrelation.set(instanceId, input.correlationKey);
    }

    await this.appendEvent({
      instanceId,
      tenantId: input.tenantId,
      sequenceNumber: 0,
      kind: "instance_started",
      occurredAt,
      actorPrincipalId: input.startedByUserId ?? null,
      actorSystemId: input.startedBySystem ?? this.systemActorId,
      previousState: null,
      newState: null,
      activityId: null,
      signalId: null,
      timerId: null,
      childInstanceId: null,
      variableName: null,
      payload: {
        definitionId: definition.id,
        definitionKey: definition.definitionKey,
        definitionVersion: definition.version,
        initialState: definition.initialState,
        variables: input.variables ?? {},
        correlationKey: input.correlationKey ?? null,
        parentInstanceId: input.parentInstanceId ?? null,
        timeoutAt,
      },
      correlationId: input.correlationKey ?? null,
      causationEventId: null,
    });

    const initialState = definition.states.find((s) => s.name === definition.initialState);
    if (initialState !== undefined) {
      for (const action of initialState.onEntryActions) {
        await this.applyAction(instanceId, definition, action, input.tenantId, null, null);
      }
    }

    await this.runStepLoop(instanceId, definition);
    const state = await this.getInstanceState(instanceId);
    if (state === null) {
      throw new Error(`instance ${instanceId} projection failed after start`);
    }
    return state;
  }

  async submitSignal(input: SubmitSignalInput): Promise<SubmitSignalResult> {
    if (input.idempotencyKey !== undefined) {
      const key = `${input.tenantId}|${input.signalName}|${input.idempotencyKey}`;
      if (this.seenSignalIdempotency.has(key)) {
        return { deduplicated: true, matchedInstanceIds: [], signalId: null };
      }
      this.seenSignalIdempotency.add(key);
    }

    const signalId = this.ids.generate("wfs");
    const matched: string[] = [];
    for (const [instanceId, tenantId] of this.instanceTenant) {
      if (tenantId !== input.tenantId) continue;
      const corr = this.instanceCorrelation.get(instanceId);
      if (corr !== input.correlationKey) continue;
      const state = await this.getInstanceState(instanceId);
      if (state === null) continue;
      if (state.status !== "running" && state.status !== "waiting_for_signal") continue;
      const definition = this.definitions.get(state.definitionId);
      if (definition === undefined) continue;

      const nextSeq = (await this.eventLog.latestSequence(instanceId)) ?? -1;
      const occurredAt = this.clock.nowIso();
      await this.appendEvent({
        instanceId,
        tenantId: input.tenantId,
        sequenceNumber: nextSeq + 1,
        kind: "signal_received",
        occurredAt,
        actorPrincipalId: null,
        actorSystemId: input.sourceSystem ?? this.systemActorId,
        previousState: null,
        newState: null,
        activityId: null,
        signalId,
        timerId: null,
        childInstanceId: null,
        variableName: null,
        payload: {
          signalName: input.signalName,
          correlationKey: input.correlationKey,
          payload: input.payload ?? {},
        },
        correlationId: input.correlationKey,
        causationEventId: null,
      });

      const transition = evaluateNextTransition({
        definition,
        fromState: state.currentState,
        trigger: { kind: "signal_received", signalName: input.signalName },
        variables: state.variables,
        evaluator: this.guardEvaluator,
      });
      if (transition !== null) {
        await this.applyTransition(instanceId, definition, transition, state, signalId, null);
      }
      const nextSeq2 = (await this.eventLog.latestSequence(instanceId))!;
      await this.appendEvent({
        instanceId,
        tenantId: input.tenantId,
        sequenceNumber: nextSeq2 + 1,
        kind: "signal_consumed",
        occurredAt: this.clock.nowIso(),
        actorPrincipalId: null,
        actorSystemId: this.systemActorId,
        previousState: null,
        newState: null,
        activityId: null,
        signalId,
        timerId: null,
        childInstanceId: null,
        variableName: null,
        payload: { signalName: input.signalName },
        correlationId: input.correlationKey,
        causationEventId: null,
      });

      await this.runStepLoop(instanceId, definition);
      matched.push(instanceId);
    }

    return { deduplicated: false, matchedInstanceIds: matched, signalId };
  }

  async tickTimers(nowMs: number): Promise<TickTimersResult> {
    const firedTimerIds: string[] = [];
    const affected = new Set<string>();
    for (const [instanceId] of this.instanceTenant) {
      const result = await this.fireDueTimersForInstance(instanceId, nowMs);
      firedTimerIds.push(...result.firedTimerIds);
      if (result.affectedInstanceIds.length > 0) affected.add(instanceId);
    }
    return { firedTimerIds, affectedInstanceIds: [...affected] };
  }

  /**
   * Fires this instance's due timers (`fireAt <= nowMs`) and applies the resulting transitions,
   * reading the instance purely from the event log — so it works for **any** instance in the log,
   * including one this engine never started in-process. That is what a distributed worker needs:
   * it claims a due timer (with its instanceId), then calls this under the timer's tenant context
   * to advance the instance. Idempotent per timer — an already-`timer_fired`/`timer_cancelled`
   * timer is not in the scheduled set, so a re-delivered claim fires nothing.
   */
  async fireDueTimersForInstance(instanceId: string, nowMs: number): Promise<TickTimersResult> {
    const state = await this.getInstanceState(instanceId);
    if (state === null) return { firedTimerIds: [], affectedInstanceIds: [] };
    if (state.status !== "waiting_for_timer" && state.status !== "running") {
      return { firedTimerIds: [], affectedInstanceIds: [] };
    }
    const definition = this.definitions.get(state.definitionId);
    if (definition === undefined) return { firedTimerIds: [], affectedInstanceIds: [] };
    const events = await this.eventLog.listByInstance(instanceId);
    const scheduled = new Map<string, { id: string; name: string; fireAt: number }>();
    for (const e of events) {
      if (e.kind === "timer_scheduled" && e.timerId !== null) {
        const name = typeof e.payload["timerName"] === "string" ? (e.payload["timerName"] as string) : "";
        const fireAt = typeof e.payload["fireAt"] === "string" ? Date.parse(e.payload["fireAt"] as string) : Number.MAX_SAFE_INTEGER;
        scheduled.set(e.timerId, { id: e.timerId, name, fireAt });
      } else if ((e.kind === "timer_fired" || e.kind === "timer_cancelled") && e.timerId !== null) {
        scheduled.delete(e.timerId);
      }
    }
    const firedTimerIds: string[] = [];
    for (const timer of scheduled.values()) {
      if (timer.fireAt > nowMs) continue;
      const nextSeq = (await this.eventLog.latestSequence(instanceId))!;
      await this.appendEvent({
        instanceId,
        tenantId: state.tenantId,
        sequenceNumber: nextSeq + 1,
        kind: "timer_fired",
        occurredAt: new Date(nowMs).toISOString(),
        actorPrincipalId: null,
        actorSystemId: this.systemActorId,
        previousState: null,
        newState: null,
        activityId: null,
        signalId: null,
        timerId: timer.id,
        childInstanceId: null,
        variableName: null,
        payload: { timerName: timer.name },
        correlationId: null,
        causationEventId: null,
      });
      firedTimerIds.push(timer.id);
      const liveState = await this.getInstanceState(instanceId);
      if (liveState === null) continue;
      const transition = evaluateNextTransition({
        definition,
        fromState: liveState.currentState,
        trigger: { kind: "timer_fired", timerName: timer.name },
        variables: liveState.variables,
        evaluator: this.guardEvaluator,
      });
      if (transition !== null) {
        await this.applyTransition(instanceId, definition, transition, liveState, null, timer.id);
      }
      await this.runStepLoop(instanceId, definition);
    }
    return { firedTimerIds, affectedInstanceIds: firedTimerIds.length > 0 ? [instanceId] : [] };
  }

  async cancelInstance(input: {
    instanceId: string;
    reason: string;
    cancelledByUserId?: string | null;
  }): Promise<void> {
    const state = await this.getInstanceState(input.instanceId);
    if (state === null) throw new Error(`unknown instance ${input.instanceId}`);
    if (state.status === "completed" || state.status === "cancelled" || state.status === "compensated") {
      throw new Error(`cannot cancel instance in terminal status ${state.status}`);
    }
    const nextSeq = (await this.eventLog.latestSequence(input.instanceId))!;
    await this.appendEvent({
      instanceId: input.instanceId,
      tenantId: state.tenantId,
      sequenceNumber: nextSeq + 1,
      kind: "instance_cancelled",
      occurredAt: this.clock.nowIso(),
      actorPrincipalId: input.cancelledByUserId ?? null,
      actorSystemId: this.systemActorId,
      previousState: null,
      newState: null,
      activityId: null,
      signalId: null,
      timerId: null,
      childInstanceId: null,
      variableName: null,
      payload: { reason: input.reason },
      correlationId: null,
      causationEventId: null,
    });
  }

  async getInstanceState(instanceId: string): Promise<ProjectedInstance | null> {
    const events = await this.eventLog.listByInstance(instanceId);
    if (events.length === 0) return null;
    const first = events[0]!;
    const definitionId =
      typeof first.payload["definitionId"] === "string"
        ? (first.payload["definitionId"] as string)
        : "";
    const definition = this.definitions.get(definitionId);
    return projectInstance(events, definition);
  }

  async listEvents(instanceId: string): Promise<readonly WorkflowEvent[]> {
    return this.eventLog.listByInstance(instanceId);
  }

  private async appendEvent(input: Omit<WorkflowEvent, "id">): Promise<WorkflowEvent> {
    const event: WorkflowEvent = { ...input, id: this.ids.generate("wfe") };
    await this.eventLog.append(event);
    return event;
  }

  private async runStepLoop(
    instanceId: string,
    definition: WorkflowDefinition,
  ): Promise<void> {
    for (let i = 0; i < MAX_STEP_ITERATIONS; i++) {
      const state = await this.getInstanceState(instanceId);
      if (state === null) return;
      if (
        state.status === "completed" ||
        state.status === "failed" ||
        state.status === "cancelled" ||
        state.status === "compensated"
      ) {
        return;
      }
      const stateDef = definition.states.find((s) => s.name === state.currentState);
      if (stateDef !== undefined && TERMINAL_STATE_KINDS.has(stateDef.kind)) {
        const kind = stateDef.kind;
        if (kind === "terminal_success" || kind === "terminal_failure" || kind === "terminal_cancelled") {
          await this.emitTerminalForStateKind(instanceId, state, kind);
        }
        return;
      }
      if (
        state.status === "waiting_for_signal" ||
        state.status === "waiting_for_timer" ||
        state.status === "waiting_for_activity" ||
        state.status === "waiting_for_manual" ||
        state.status === "suspended"
      ) {
        return;
      }
      const transition = evaluateNextTransition({
        definition,
        fromState: state.currentState,
        trigger: { kind: "automatic" },
        variables: state.variables,
        evaluator: this.guardEvaluator,
      });
      if (transition === null) return;
      await this.applyTransition(instanceId, definition, transition, state, null, null);
    }
    throw new Error(
      `step loop for instance ${instanceId} exceeded ${MAX_STEP_ITERATIONS.toString()} iterations`,
    );
  }

  private async applyTransition(
    instanceId: string,
    definition: WorkflowDefinition,
    transition: TransitionDefinition,
    fromState: ProjectedInstance,
    signalId: string | null,
    timerId: string | null,
  ): Promise<void> {
    for (const action of transition.preTransitionActions) {
      await this.applyAction(instanceId, definition, action, fromState.tenantId, signalId, timerId);
    }

    const nextSeq = (await this.eventLog.latestSequence(instanceId))!;
    await this.appendEvent({
      instanceId,
      tenantId: fromState.tenantId,
      sequenceNumber: nextSeq + 1,
      kind: "state_transitioned",
      occurredAt: this.clock.nowIso(),
      actorPrincipalId: null,
      actorSystemId: this.systemActorId,
      previousState: transition.fromState,
      newState: transition.toState,
      activityId: null,
      signalId,
      timerId,
      childInstanceId: null,
      variableName: null,
      payload: { transitionName: transition.name },
      correlationId: null,
      causationEventId: null,
    });

    for (const action of transition.postTransitionActions) {
      await this.applyAction(instanceId, definition, action, fromState.tenantId, signalId, timerId);
    }

    const newStateDef = definition.states.find((s) => s.name === transition.toState);
    if (newStateDef !== undefined) {
      for (const action of newStateDef.onEntryActions) {
        await this.applyAction(instanceId, definition, action, fromState.tenantId, signalId, timerId);
      }
    }
  }

  private async applyAction(
    instanceId: string,
    definition: WorkflowDefinition,
    action: StateAction,
    tenantId: string,
    signalId: string | null,
    timerId: string | null,
  ): Promise<void> {
    switch (action.kind) {
      case "set_variable":
        await this.applySetVariable(instanceId, tenantId, action);
        return;
      case "audit_log":
      case "emit_event":
        return;
      case "schedule_activity":
        await this.applyScheduleActivity(instanceId, definition, action, tenantId);
        return;
      case "schedule_timer":
        await this.applyScheduleTimer(instanceId, tenantId, action);
        return;
      case "cancel_timer":
      case "spawn_child_workflow":
      case "send_signal":
        throw new Error(`action kind ${action.kind} is not implemented in M3`);
    }
    void signalId;
    void timerId;
  }

  private async applySetVariable(
    instanceId: string,
    tenantId: string,
    action: StateAction,
  ): Promise<void> {
    const variableName = action.parameters["variableName"];
    if (typeof variableName !== "string") return;
    const newValue = action.parameters["value"];
    const nextSeq = (await this.eventLog.latestSequence(instanceId))!;
    await this.appendEvent({
      instanceId,
      tenantId,
      sequenceNumber: nextSeq + 1,
      kind: "variable_updated",
      occurredAt: this.clock.nowIso(),
      actorPrincipalId: null,
      actorSystemId: this.systemActorId,
      previousState: null,
      newState: null,
      activityId: null,
      signalId: null,
      timerId: null,
      childInstanceId: null,
      variableName,
      payload: { newValue, newValueSha256: sha256(JSON.stringify(newValue ?? null)) },
      correlationId: null,
      causationEventId: null,
    });
  }

  private async applyScheduleActivity(
    instanceId: string,
    definition: WorkflowDefinition,
    action: StateAction,
    tenantId: string,
  ): Promise<void> {
    const activityKey =
      typeof action.parameters["activityKey"] === "string"
        ? (action.parameters["activityKey"] as string)
        : "default_activity";
    const kind =
      typeof action.parameters["kind"] === "string"
        ? (action.parameters["kind"] as ReturnType<typeof String>)
        : "transformation";
    const inputData = (action.parameters["input"] as Record<string, unknown>) ?? {};
    // Retry ceiling from the schedule_activity action (default 1 = no retry). A failed+retryable
    // attempt below the ceiling reschedules a fresh attempt; at the ceiling it dead-letters.
    const maxAttempts =
      typeof action.parameters["maxAttempts"] === "number" && action.parameters["maxAttempts"] >= 1
        ? Math.floor(action.parameters["maxAttempts"] as number)
        : 1;
    const backoff = parseActivityBackoff(action.parameters);
    // A `compensationActivityKey` is persisted onto the scheduled activity so a later saga rollback
    // (planCompensation) can find the side-effect's undo handler; absent ⇒ nothing to compensate.
    const compensationActivityKey =
      typeof action.parameters["compensationActivityKey"] === "string"
        ? (action.parameters["compensationActivityKey"] as string)
        : null;
    await this.scheduleActivity(instanceId, definition, activityKey, kind, inputData, 1, maxAttempts, tenantId, backoff, null, compensationActivityKey);
  }

  /**
   * Records an activity attempt as `scheduled` (persisting its input + retry ceiling) and, unless
   * `deferActivities` leaves it for a distributed worker, runs it inline. Used both for the first
   * attempt (`applyScheduleActivity`) and for each retry (a fresh `activityId` per attempt).
   */
  private async scheduleActivity(
    instanceId: string,
    definition: WorkflowDefinition,
    activityKey: string,
    kind: string,
    inputData: Record<string, unknown>,
    attemptNumber: number,
    maxAttempts: number,
    tenantId: string,
    backoff: ActivityRetryBackoff,
    availableAt: string | null,
    compensationActivityKey: string | null = null,
  ): Promise<void> {
    const activityId = this.ids.generate("wfa");
    const nextSeq = (await this.eventLog.latestSequence(instanceId))!;
    await this.appendEvent({
      instanceId,
      tenantId,
      sequenceNumber: nextSeq + 1,
      kind: "activity_scheduled",
      occurredAt: this.clock.nowIso(),
      actorPrincipalId: null,
      actorSystemId: this.systemActorId,
      previousState: null,
      newState: null,
      activityId,
      signalId: null,
      timerId: null,
      childInstanceId: null,
      variableName: null,
      payload: {
        kind,
        definitionActivityKey: activityKey,
        attemptNumber,
        maxAttempts,
        input: inputData,
        inputSha256: sha256(JSON.stringify(inputData)),
        ...(backoff !== null ? { retryBackoff: backoff } : {}),
        // availableAt defers the activity's scheduled_at so the claim (`scheduled_at <= now`) holds it
        // out of the queue until the backoff elapses; absent ⇒ due immediately (occurredAt).
        ...(availableAt !== null ? { availableAt } : {}),
        ...(compensationActivityKey !== null ? { compensationActivityKey } : {}),
      },
      correlationId: null,
      causationEventId: null,
    });

    // Deferred mode: leave the activity `scheduled` for a distributed worker to claim + execute.
    if (this.deferActivities) return;
    await this.runActivityHandler(instanceId, definition, activityId, activityKey, kind, inputData, attemptNumber, maxAttempts, tenantId, backoff, compensationActivityKey);
  }

  /**
   * Runs a scheduled activity's handler: appends `activity_started`, invokes the resolved handler,
   * appends the outcome (`activity_completed` / `_failed` / `_timed_out`), and applies the resulting
   * transition. Shared by the inline path (`applyScheduleActivity`) and the distributed executor
   * (`executeScheduledActivity`).
   */
  private async runActivityHandler(
    instanceId: string,
    definition: WorkflowDefinition,
    activityId: string,
    activityKey: string,
    kind: string,
    inputData: Record<string, unknown>,
    attemptNumber: number,
    maxAttempts: number,
    tenantId: string,
    backoff: ActivityRetryBackoff = null,
    compensationActivityKey: string | null = null,
  ): Promise<void> {
    const handler =
      this.registry.resolve({
        kind: kind as never,
        definitionId: definition.id,
        activityKey,
      }) ?? unsupportedHandler;
    const state = await this.getInstanceState(instanceId);
    const startedSeq = (await this.eventLog.latestSequence(instanceId))!;
    await this.appendEvent({
      instanceId,
      tenantId,
      sequenceNumber: startedSeq + 1,
      kind: "activity_started",
      occurredAt: this.clock.nowIso(),
      actorPrincipalId: null,
      actorSystemId: this.systemActorId,
      previousState: null,
      newState: null,
      activityId,
      signalId: null,
      timerId: null,
      childInstanceId: null,
      variableName: null,
      payload: {},
      correlationId: null,
      causationEventId: null,
    });

    let outcome;
    try {
      outcome = await handler({
        activityId,
        instanceId,
        tenantId,
        definitionId: definition.id,
        definitionActivityKey: activityKey,
        kind: kind as never,
        attemptNumber,
        input: inputData,
        variables: state?.variables ?? {},
      });
    } catch (err) {
      outcome = {
        status: "failed" as const,
        errorCode: "HANDLER_EXCEPTION",
        errorMessage: err instanceof Error ? err.message : String(err),
        retryable: false,
      };
    }

    const completionSeq = (await this.eventLog.latestSequence(instanceId))!;
    if (outcome.status === "succeeded") {
      await this.appendEvent({
        instanceId,
        tenantId,
        sequenceNumber: completionSeq + 1,
        kind: "activity_completed",
        occurredAt: this.clock.nowIso(),
        actorPrincipalId: null,
        actorSystemId: this.systemActorId,
        previousState: null,
        newState: null,
        activityId,
        signalId: null,
        timerId: null,
        childInstanceId: null,
        variableName: null,
        payload: {
          outputSha256: outcome.outputSha256 ?? sha256(JSON.stringify(outcome.output ?? {})),
        },
        correlationId: null,
        causationEventId: null,
      });
      const liveState = await this.getInstanceState(instanceId);
      if (liveState !== null) {
        const transition = evaluateNextTransition({
          definition,
          fromState: liveState.currentState,
          trigger: { kind: "activity_completed", activityKey },
          variables: liveState.variables,
          evaluator: this.guardEvaluator,
        });
        if (transition !== null) {
          await this.applyTransition(instanceId, definition, transition, liveState, null, null);
        }
      }
    } else if (outcome.status === "failed") {
      // Retry when the outcome is retryable and attempts remain; otherwise dead-letter (the
      // activity_failed is terminal and its trigger transition fires — the workflow handles it).
      const willRetry = outcome.retryable === true && attemptNumber < maxAttempts;
      await this.appendEvent({
        instanceId,
        tenantId,
        sequenceNumber: completionSeq + 1,
        kind: "activity_failed",
        occurredAt: this.clock.nowIso(),
        actorPrincipalId: null,
        actorSystemId: this.systemActorId,
        previousState: null,
        newState: null,
        activityId,
        signalId: null,
        timerId: null,
        childInstanceId: null,
        variableName: null,
        payload: {
          errorCode: outcome.errorCode,
          errorMessage: outcome.errorMessage,
          attemptNumber,
          maxAttempts,
          willRetry,
          deadLettered: !willRetry,
        },
        correlationId: null,
        causationEventId: null,
      });
      if (willRetry) {
        // Reschedule a fresh attempt (new activityId). No transition — the activity isn't done.
        // A backoff defers the next attempt's availableAt (deferred mode); absent ⇒ immediate.
        const delayMs = activityRetryDelayMs(backoff, attemptNumber);
        const availableAt =
          delayMs > 0 ? new Date(new Date(this.clock.nowIso()).getTime() + delayMs).toISOString() : null;
        await this.scheduleActivity(instanceId, definition, activityKey, kind, inputData, attemptNumber + 1, maxAttempts, tenantId, backoff, availableAt, compensationActivityKey);
      } else {
        const liveState = await this.getInstanceState(instanceId);
        if (liveState !== null) {
          const transition = evaluateNextTransition({
            definition,
            fromState: liveState.currentState,
            trigger: { kind: "activity_failed", activityKey },
            variables: liveState.variables,
            evaluator: this.guardEvaluator,
          });
          if (transition !== null) {
            await this.applyTransition(instanceId, definition, transition, liveState, null, null);
          }
        }
      }
    } else {
      await this.appendEvent({
        instanceId,
        tenantId,
        sequenceNumber: completionSeq + 1,
        kind: "activity_timed_out",
        occurredAt: this.clock.nowIso(),
        actorPrincipalId: null,
        actorSystemId: this.systemActorId,
        previousState: null,
        newState: null,
        activityId,
        signalId: null,
        timerId: null,
        childInstanceId: null,
        variableName: null,
        payload: { errorMessage: outcome.errorMessage },
        correlationId: null,
        causationEventId: null,
      });
    }
  }

  /**
   * Distributed executor: runs a scheduled-but-unstarted activity from the event log, so a worker
   * that claimed it (in another process) can execute it — the activity analog of
   * `fireDueTimersForInstance`. Log-driven and idempotent: an activity that already has an
   * `activity_started` (another worker ran it) is a no-op, so a re-delivered at-least-once claim
   * runs nothing. The activity's input is read from the persisted `activity_scheduled` payload.
   */
  async executeScheduledActivity(
    instanceId: string,
    activityId: string,
  ): Promise<{ readonly executed: boolean }> {
    const events = await this.eventLog.listByInstance(instanceId);
    let scheduled: {
      kind: string;
      key: string;
      input: Record<string, unknown>;
      attempt: number;
      maxAttempts: number;
      backoff: ActivityRetryBackoff;
      compensationActivityKey: string | null;
    } | null = null;
    let started = false;
    for (const e of events) {
      if (e.activityId !== activityId) continue;
      if (e.kind === "activity_scheduled") {
        const p = e.payload;
        scheduled = {
          kind: typeof p["kind"] === "string" ? (p["kind"] as string) : "transformation",
          key: typeof p["definitionActivityKey"] === "string" ? (p["definitionActivityKey"] as string) : "default_activity",
          input: (p["input"] as Record<string, unknown> | undefined) ?? {},
          attempt: typeof p["attemptNumber"] === "number" ? (p["attemptNumber"] as number) : 1,
          maxAttempts: typeof p["maxAttempts"] === "number" ? (p["maxAttempts"] as number) : 1,
          backoff: (p["retryBackoff"] as ActivityRetryBackoff) ?? null,
          compensationActivityKey:
            typeof p["compensationActivityKey"] === "string" ? (p["compensationActivityKey"] as string) : null,
        };
      } else if (
        e.kind === "activity_started" ||
        e.kind === "activity_completed" ||
        e.kind === "activity_failed" ||
        e.kind === "activity_timed_out"
      ) {
        started = true;
      }
    }
    if (scheduled === null || started) return { executed: false };
    const state = await this.getInstanceState(instanceId);
    if (state === null) return { executed: false };
    const definition = this.definitions.get(state.definitionId);
    if (definition === undefined) return { executed: false };
    await this.runActivityHandler(
      instanceId,
      definition,
      activityId,
      scheduled.key,
      scheduled.kind,
      scheduled.input,
      scheduled.attempt,
      scheduled.maxAttempts,
      state.tenantId,
      scheduled.backoff,
      scheduled.compensationActivityKey,
    );
    // The inline path runs inside the step loop; the distributed entry point must drive it itself
    // so a terminal transition emits instance_completed / runs the next state's on-entry actions.
    await this.runStepLoop(instanceId, definition);
    return { executed: true };
  }

  /**
   * Runs saga compensation for an instance: plans the rollback (`planCompensation` over the
   * completed side-effect activities, honoring the definition's `compensationStrategy`), then
   * executes each compensating handler and records `compensation_started` / `activity_compensated`
   * / `compensation_completed`. Log-driven and idempotent — an activity that already carries an
   * `activity_compensated` is dropped by the planner, so a re-invocation compensates nothing twice
   * (mirroring `executeScheduledActivity`). This is the shared code the terminal-failure path and
   * the public entry point both call.
   */
  async compensateInstance(instanceId: string): Promise<CompensationResult> {
    return this.runCompensation(instanceId);
  }

  private async runCompensation(instanceId: string): Promise<CompensationResult> {
    const state = await this.getInstanceState(instanceId);
    if (state === null) return { strategy: null, compensatedActivityIds: [] };
    const definition = this.definitions.get(state.definitionId);
    if (definition === undefined) return { strategy: null, compensatedActivityIds: [] };
    const strategy = definition.compensationStrategy;
    // no_compensation / manual_review record nothing beyond what the plan dictates (nothing runs):
    // no_compensation yields an empty plan; manual_review defers to a human, so it is not executed.
    if (strategy !== "immediate_reverse_order" && strategy !== "parallel") {
      return { strategy, compensatedActivityIds: [] };
    }
    const events = await this.eventLog.listByInstance(instanceId);
    const plan = planCompensation({ definition, events });
    if (plan.steps.length === 0) return { strategy, compensatedActivityIds: [] };

    const kindByActivityId = compensationKindByActivityId(events);
    const inputByActivityId = new Map<string, Record<string, unknown>>();
    for (const e of events) {
      if (e.kind === "activity_scheduled" && e.activityId !== null) {
        inputByActivityId.set(
          e.activityId,
          (e.payload["input"] as Record<string, unknown> | undefined) ?? {},
        );
      }
    }

    const startSeq = (await this.eventLog.latestSequence(instanceId))!;
    await this.appendEvent({
      instanceId,
      tenantId: state.tenantId,
      sequenceNumber: startSeq + 1,
      kind: "compensation_started",
      occurredAt: this.clock.nowIso(),
      actorPrincipalId: null,
      actorSystemId: this.systemActorId,
      previousState: null,
      newState: null,
      activityId: null,
      signalId: null,
      timerId: null,
      childInstanceId: null,
      variableName: null,
      payload: {
        strategy,
        activityIds: plan.steps.map((s) => s.originalActivityId),
      },
      correlationId: null,
      causationEventId: null,
    });

    const compensatedActivityIds: string[] = [];
    for (const step of plan.steps) {
      await this.compensateStep(
        instanceId,
        definition,
        state.tenantId,
        state.variables,
        step,
        kindByActivityId.get(step.originalActivityId) ?? "compensation",
        inputByActivityId.get(step.originalActivityId) ?? {},
      );
      compensatedActivityIds.push(step.originalActivityId);
    }

    const doneSeq = (await this.eventLog.latestSequence(instanceId))!;
    await this.appendEvent({
      instanceId,
      tenantId: state.tenantId,
      sequenceNumber: doneSeq + 1,
      kind: "compensation_completed",
      occurredAt: this.clock.nowIso(),
      actorPrincipalId: null,
      actorSystemId: this.systemActorId,
      previousState: null,
      newState: null,
      activityId: null,
      signalId: null,
      timerId: null,
      childInstanceId: null,
      variableName: null,
      payload: { strategy, compensatedActivityIds },
      correlationId: null,
      causationEventId: null,
    });

    return { strategy, compensatedActivityIds };
  }

  /**
   * Executes one compensating step: resolves the compensating handler by the source activity's kind
   * + the plan's `compensationActivityKey` (an unregistered key is a no-op compensation, still
   * recorded), runs it, then records an `activity_compensated` for the *source* activity so the
   * projection marks it compensated and the planner excludes it on a re-run.
   */
  private async compensateStep(
    instanceId: string,
    definition: WorkflowDefinition,
    tenantId: string,
    variables: Readonly<Record<string, unknown>>,
    step: CompensationStep,
    sourceKind: ActivityInvocation["kind"],
    input: Record<string, unknown>,
  ): Promise<void> {
    const handler = this.registry.resolve({
      kind: sourceKind,
      definitionId: definition.id,
      activityKey: step.compensationActivityKey,
    });
    let outcome: ActivityOutcome;
    if (handler === null) {
      outcome = { status: "succeeded" };
    } else {
      try {
        outcome = await handler({
          activityId: this.ids.generate("wfa"),
          instanceId,
          tenantId,
          definitionId: definition.id,
          definitionActivityKey: step.compensationActivityKey,
          kind: sourceKind,
          attemptNumber: 1,
          input,
          variables,
        });
      } catch (err) {
        outcome = {
          status: "failed",
          errorCode: "COMPENSATION_EXCEPTION",
          errorMessage: err instanceof Error ? err.message : String(err),
          retryable: false,
        };
      }
    }

    const nextSeq = (await this.eventLog.latestSequence(instanceId))!;
    await this.appendEvent({
      instanceId,
      tenantId,
      sequenceNumber: nextSeq + 1,
      kind: "activity_compensated",
      occurredAt: this.clock.nowIso(),
      actorPrincipalId: null,
      actorSystemId: this.systemActorId,
      previousState: null,
      newState: null,
      activityId: step.originalActivityId,
      signalId: null,
      timerId: null,
      childInstanceId: null,
      variableName: null,
      payload: {
        compensationActivityKey: step.compensationActivityKey,
        handlerRegistered: handler !== null,
        compensationStatus: outcome.status,
        ...(outcome.status === "failed"
          ? { errorCode: outcome.errorCode, errorMessage: outcome.errorMessage }
          : {}),
      },
      correlationId: null,
      causationEventId: null,
    });
  }

  private async applyScheduleTimer(
    instanceId: string,
    tenantId: string,
    action: StateAction,
  ): Promise<void> {
    const timerName =
      typeof action.parameters["timerName"] === "string"
        ? (action.parameters["timerName"] as string)
        : "timer";
    const relativeSeconds =
      typeof action.parameters["relativeSeconds"] === "number"
        ? (action.parameters["relativeSeconds"] as number)
        : 60;
    const fireAt = new Date(this.clock.now().getTime() + relativeSeconds * 1000).toISOString();
    const timerId = this.ids.generate("wft");
    const nextSeq = (await this.eventLog.latestSequence(instanceId))!;
    await this.appendEvent({
      instanceId,
      tenantId,
      sequenceNumber: nextSeq + 1,
      kind: "timer_scheduled",
      occurredAt: this.clock.nowIso(),
      actorPrincipalId: null,
      actorSystemId: this.systemActorId,
      previousState: null,
      newState: null,
      activityId: null,
      signalId: null,
      timerId,
      childInstanceId: null,
      variableName: null,
      payload: { timerName, fireAt },
      correlationId: null,
      causationEventId: null,
    });
  }

  private async emitTerminalForStateKind(
    instanceId: string,
    state: ProjectedInstance,
    kind: "terminal_success" | "terminal_failure" | "terminal_cancelled",
  ): Promise<void> {
    const nextSeq = (await this.eventLog.latestSequence(instanceId))!;
    if (kind === "terminal_success") {
      await this.appendEvent({
        instanceId,
        tenantId: state.tenantId,
        sequenceNumber: nextSeq + 1,
        kind: "instance_completed",
        occurredAt: this.clock.nowIso(),
        actorPrincipalId: null,
        actorSystemId: this.systemActorId,
        previousState: null,
        newState: null,
        activityId: null,
        signalId: null,
        timerId: null,
        childInstanceId: null,
        variableName: null,
        payload: {},
        correlationId: null,
        causationEventId: null,
      });
    } else if (kind === "terminal_failure") {
      await this.appendEvent({
        instanceId,
        tenantId: state.tenantId,
        sequenceNumber: nextSeq + 1,
        kind: "instance_failed",
        occurredAt: this.clock.nowIso(),
        actorPrincipalId: null,
        actorSystemId: this.systemActorId,
        previousState: null,
        newState: null,
        activityId: null,
        signalId: null,
        timerId: null,
        childInstanceId: null,
        variableName: null,
        payload: {
          errorCode: "TERMINAL_FAILURE_STATE",
          errorMessage: `instance reached terminal_failure state ${state.currentState}`,
        },
        correlationId: null,
        causationEventId: null,
      });
      // A terminal failure automatically runs saga compensation (once) over the instance's completed
      // side-effect activities. The same code backs the explicit `compensateInstance` entry point.
      await this.runCompensation(instanceId);
    } else {
      await this.appendEvent({
        instanceId,
        tenantId: state.tenantId,
        sequenceNumber: nextSeq + 1,
        kind: "instance_cancelled",
        occurredAt: this.clock.nowIso(),
        actorPrincipalId: null,
        actorSystemId: this.systemActorId,
        previousState: null,
        newState: null,
        activityId: null,
        signalId: null,
        timerId: null,
        childInstanceId: null,
        variableName: null,
        payload: { reason: `terminal_cancelled state ${state.currentState}` },
        correlationId: null,
        causationEventId: null,
      });
    }
  }

  registerInstance(instanceId: string, tenantId: string, correlationKey?: string): void {
    this.instanceTenant.set(instanceId, tenantId);
    if (correlationKey !== undefined) {
      this.instanceCorrelation.set(instanceId, correlationKey);
    }
  }
}
