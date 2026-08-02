import { sha256 } from "@crossengin/crypto";
import {
  TERMINAL_STATE_KINDS,
  type StateAction,
  type TransitionDefinition,
  type WorkflowDefinition,
  type WorkflowEvent,
} from "@crossengin/workflow-engine";

import {
  type ActivityRegistry,
  unsupportedHandler,
} from "./activity-handlers.js";
import { type Clock, type IdGenerator, SystemClock, RandomIdGenerator } from "./clock.js";
import { type EventLog } from "./event-log.js";
import { type ProjectedInstance, projectInstance } from "./projection.js";
import {
  type GuardEvaluator,
  defaultGuardEvaluator,
  evaluateNextTransition,
} from "./transitions.js";

const MAX_STEP_ITERATIONS = 1000;

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
    await this.scheduleActivity(instanceId, definition, activityKey, kind, inputData, 1, maxAttempts, tenantId);
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
      },
      correlationId: null,
      causationEventId: null,
    });

    // Deferred mode: leave the activity `scheduled` for a distributed worker to claim + execute.
    if (this.deferActivities) return;
    await this.runActivityHandler(instanceId, definition, activityId, activityKey, kind, inputData, attemptNumber, maxAttempts, tenantId);
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
        await this.scheduleActivity(instanceId, definition, activityKey, kind, inputData, attemptNumber + 1, maxAttempts, tenantId);
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
    let scheduled: { kind: string; key: string; input: Record<string, unknown>; attempt: number; maxAttempts: number } | null = null;
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
    );
    // The inline path runs inside the step loop; the distributed entry point must drive it itself
    // so a terminal transition emits instance_completed / runs the next state's on-entry actions.
    await this.runStepLoop(instanceId, definition);
    return { executed: true };
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
