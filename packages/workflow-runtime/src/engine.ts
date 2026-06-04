import { sha256 } from "@crossengin/crypto";
import {
  DEFAULT_RETRY_POLICY,
  RetryPolicySchema,
  TERMINAL_STATE_KINDS,
  computeNextRetryAt,
  type RetryPolicy,
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
const DEFAULT_ACTIVITY_TIMEOUT_SECONDS = 300;

/** Reads a `schedule_activity` action's `retryPolicy` param, falling back to the default. */
function resolveRetryPolicy(value: unknown): RetryPolicy {
  const parsed = RetryPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_RETRY_POLICY;
}

export interface EngineOptions {
  readonly eventLog: EventLog;
  readonly definitions: ReadonlyMap<string, WorkflowDefinition>;
  readonly activityRegistry: ActivityRegistry;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  readonly guardEvaluator?: GuardEvaluator;
  readonly systemActorId?: string;
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

export interface FireTimerResult {
  readonly fired: boolean;
  readonly instanceId: string;
  readonly timerId: string;
  readonly timerName: string | null;
}

export interface RetryActivityResult {
  readonly retried: boolean;
  readonly instanceId: string;
  readonly activityId: string;
  readonly status: "succeeded" | "failed" | "timed_out" | null;
}

export interface TimeoutInstanceResult {
  readonly timedOut: boolean;
  readonly instanceId: string;
  readonly previousStatus: string | null;
}

export interface ExecuteActivityResult {
  readonly executed: boolean;
  readonly instanceId: string;
  readonly activityId: string;
  readonly status: "succeeded" | "failed" | "timed_out" | null;
}

export class WorkflowEngine {
  private readonly eventLog: EventLog;
  private readonly definitions: ReadonlyMap<string, WorkflowDefinition>;
  private readonly registry: ActivityRegistry;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly guardEvaluator: GuardEvaluator;
  private readonly systemActorId: string;
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
          deliveryGuarantee: "at_least_once",
          sourceSystem: input.sourceSystem ?? this.systemActorId,
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
      const state = await this.getInstanceState(instanceId);
      if (state === null) continue;
      if (state.status !== "waiting_for_timer" && state.status !== "running") continue;
      const definition = this.definitions.get(state.definitionId);
      if (definition === undefined) continue;
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
      for (const timer of scheduled.values()) {
        if (timer.fireAt > nowMs) continue;
        await this.applyTimerFired(instanceId, state.tenantId, definition, timer.id, timer.name, nowMs);
        firedTimerIds.push(timer.id);
        affected.add(instanceId);
      }
    }
    return { firedTimerIds, affectedInstanceIds: [...affected] };
  }

  /**
   * Fires one specific scheduled timer by id (the per-unit path a distributed
   * worker uses after claiming a due timer). Idempotent + safe to race: a timer
   * already fired/cancelled, not yet due, or on a terminal/non-waiting instance
   * is a no-op (`fired: false`) — so two workers that both claim-and-fire the
   * same timer can't double-fire it.
   */
  async fireTimer(input: {
    instanceId: string;
    timerId: string;
    nowMs?: number;
  }): Promise<FireTimerResult> {
    const nowMs = input.nowMs ?? this.clock.now().getTime();
    const miss: FireTimerResult = { fired: false, instanceId: input.instanceId, timerId: input.timerId, timerName: null };
    const state = await this.getInstanceState(input.instanceId);
    if (state === null) return miss;
    if (state.status !== "waiting_for_timer" && state.status !== "running") return miss;
    const definition = this.definitions.get(state.definitionId);
    if (definition === undefined) return miss;
    const events = await this.eventLog.listByInstance(input.instanceId);
    let scheduled = false;
    let name = "";
    let fireAt = Number.MAX_SAFE_INTEGER;
    for (const e of events) {
      if (e.timerId !== input.timerId) continue;
      if (e.kind === "timer_scheduled") {
        scheduled = true;
        name = typeof e.payload["timerName"] === "string" ? (e.payload["timerName"] as string) : "";
        fireAt = typeof e.payload["fireAt"] === "string" ? Date.parse(e.payload["fireAt"] as string) : Number.MAX_SAFE_INTEGER;
      } else if (e.kind === "timer_fired" || e.kind === "timer_cancelled") {
        scheduled = false;
      }
    }
    if (!scheduled || fireAt > nowMs) return { ...miss, timerName: scheduled ? name : null };
    await this.applyTimerFired(input.instanceId, state.tenantId, definition, input.timerId, name, nowMs);
    return { fired: true, instanceId: input.instanceId, timerId: input.timerId, timerName: name };
  }

  /** Appends a `timer_fired` event for one timer, then evaluates the resulting transition + steps. */
  private async applyTimerFired(
    instanceId: string,
    tenantId: string,
    definition: WorkflowDefinition,
    timerId: string,
    timerName: string,
    nowMs: number,
  ): Promise<void> {
    const nextSeq = (await this.eventLog.latestSequence(instanceId))!;
    await this.appendEvent({
      instanceId,
      tenantId,
      sequenceNumber: nextSeq + 1,
      kind: "timer_fired",
      occurredAt: new Date(nowMs).toISOString(),
      actorPrincipalId: null,
      actorSystemId: this.systemActorId,
      previousState: null,
      newState: null,
      activityId: null,
      signalId: null,
      timerId,
      childInstanceId: null,
      variableName: null,
      payload: { timerName },
      correlationId: null,
      causationEventId: null,
    });
    const liveState = await this.getInstanceState(instanceId);
    if (liveState === null) return;
    const transition = evaluateNextTransition({
      definition,
      fromState: liveState.currentState,
      trigger: { kind: "timer_fired", timerName },
      variables: liveState.variables,
      evaluator: this.guardEvaluator,
    });
    if (transition !== null) {
      await this.applyTransition(instanceId, definition, transition, liveState, null, timerId);
    }
    await this.runStepLoop(instanceId, definition);
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

  /**
   * Fails a non-terminal instance that has passed its overall `timeoutAt`
   * deadline — the per-unit primitive a distributed timeout sweeper drives after
   * claiming a due instance. **Idempotent + race-safe**: a terminal instance, an
   * unknown instance, or one whose deadline has *not* actually passed (claimed a
   * touch early, or the deadline was extended) is a no-op (`timedOut: false`), so
   * two sweepers can't double-fail it. Emits `instance_failed` with
   * `INSTANCE_TIMEOUT`.
   */
  async timeoutInstance(input: {
    instanceId: string;
    nowMs?: number;
  }): Promise<TimeoutInstanceResult> {
    const state = await this.getInstanceState(input.instanceId);
    if (state === null) return { timedOut: false, instanceId: input.instanceId, previousStatus: null };
    if (
      state.status === "completed" ||
      state.status === "failed" ||
      state.status === "cancelled" ||
      state.status === "compensated"
    ) {
      return { timedOut: false, instanceId: input.instanceId, previousStatus: state.status };
    }
    const nowMs = input.nowMs ?? this.clock.now().getTime();
    if (nowMs < Date.parse(state.timeoutAt)) {
      return { timedOut: false, instanceId: input.instanceId, previousStatus: state.status };
    }
    const nextSeq = (await this.eventLog.latestSequence(input.instanceId))!;
    await this.appendEvent({
      instanceId: input.instanceId,
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
        errorCode: "INSTANCE_TIMEOUT",
        errorMessage: `instance exceeded timeout deadline ${state.timeoutAt}`,
      },
      correlationId: null,
      causationEventId: null,
    });
    return { timedOut: true, instanceId: input.instanceId, previousStatus: state.status };
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
    const activityId = this.ids.generate("wfa");
    const inputData = (action.parameters["input"] as Record<string, unknown>) ?? {};
    const retryPolicy = resolveRetryPolicy(action.parameters["retryPolicy"]);
    const timeoutSeconds =
      typeof action.parameters["timeoutSeconds"] === "number"
        ? (action.parameters["timeoutSeconds"] as number)
        : DEFAULT_ACTIVITY_TIMEOUT_SECONDS;
    // precedence: per-action executionMode → the definition's
    // defaultActivityExecutionMode → "inline".
    const actionMode = action.parameters["executionMode"];
    const executionMode =
      actionMode === "async" || actionMode === "inline"
        ? actionMode
        : definition.defaultActivityExecutionMode ?? "inline";
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
        label: activityKey,
        attemptNumber: 1,
        input: inputData,
        inputSha256: sha256(JSON.stringify(inputData)),
        retryPolicy,
        maxAttempts: retryPolicy.maxAttempts,
        timeoutSeconds,
        executionMode,
      },
      correlationId: null,
      causationEventId: null,
    });

    // async activities are left scheduled for a distributed ActivityExecutorWorker
    // to claim + run via executeActivity; inline activities run here, in-call.
    if (executionMode === "async") return;
    await this.runActivityAttempt(instanceId, definition, tenantId, activityId, activityKey, kind, inputData, 1, retryPolicy);
  }

  /**
   * Runs the **first** attempt of an `async`-scheduled activity that has not yet
   * started — the per-unit primitive a distributed `ActivityExecutorWorker`
   * drives after claiming a `scheduled` async activity. **Idempotent +
   * race-safe**: an activity that has already started (any `activity_started`
   * event), succeeded/failed/cancelled, or an unknown/terminal instance is a
   * no-op (`executed: false`), so two executors can't double-run it. Replays the
   * input persisted on `activity_scheduled` and advances the workflow on success.
   */
  async executeActivity(input: {
    instanceId: string;
    activityId: string;
  }): Promise<ExecuteActivityResult> {
    const miss: ExecuteActivityResult = { executed: false, instanceId: input.instanceId, activityId: input.activityId, status: null };
    const state = await this.getInstanceState(input.instanceId);
    if (state === null) return miss;
    if (state.status === "completed" || state.status === "cancelled" || state.status === "compensated" || state.status === "failed") return miss;
    const definition = this.definitions.get(state.definitionId);
    if (definition === undefined) return miss;
    const events = await this.eventLog.listByInstance(input.instanceId);
    let activityKey: string | null = null;
    let kind = "transformation";
    let activityInput: Record<string, unknown> = {};
    let retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY;
    let started = false;
    for (const e of events) {
      if (e.activityId !== input.activityId) continue;
      if (e.kind === "activity_scheduled") {
        activityKey = typeof e.payload["definitionActivityKey"] === "string" ? (e.payload["definitionActivityKey"] as string) : null;
        kind = typeof e.payload["kind"] === "string" ? (e.payload["kind"] as string) : "transformation";
        activityInput = (e.payload["input"] as Record<string, unknown>) ?? {};
        retryPolicy = resolveRetryPolicy(e.payload["retryPolicy"]);
      } else if (e.kind === "activity_started") {
        started = true;
      }
    }
    // execute only a scheduled, never-started activity (first attempt)
    if (activityKey === null || started) return miss;
    const outcome = await this.runActivityAttempt(
      input.instanceId,
      definition,
      state.tenantId,
      input.activityId,
      activityKey,
      kind,
      activityInput,
      1,
      retryPolicy,
    );
    await this.runStepLoop(input.instanceId, definition);
    return { executed: true, instanceId: input.instanceId, activityId: input.activityId, status: outcome };
  }

  /**
   * Re-runs a previously-scheduled activity that ended in `failed`/`timed_out`,
   * at the next attempt number, with its **original input** (persisted on the
   * `activity_scheduled` event). The per-unit retry path a distributed executor
   * uses after claiming a due retry. A no-op (`retried: false`) if the activity
   * already succeeded/cancelled, has a retry in flight (last event is
   * `activity_started`), or the instance/activity is unknown/terminal — so it's
   * safe to drive from a leased claim.
   */
  async retryActivity(input: {
    instanceId: string;
    activityId: string;
  }): Promise<RetryActivityResult> {
    const miss: RetryActivityResult = { retried: false, instanceId: input.instanceId, activityId: input.activityId, status: null };
    const state = await this.getInstanceState(input.instanceId);
    if (state === null) return miss;
    if (state.status === "completed" || state.status === "cancelled" || state.status === "compensated") return miss;
    const definition = this.definitions.get(state.definitionId);
    if (definition === undefined) return miss;
    const events = await this.eventLog.listByInstance(input.instanceId);
    let activityKey: string | null = null;
    let kind = "transformation";
    let activityInput: Record<string, unknown> = {};
    let retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY;
    let attempts = 0;
    let lastKind: string | null = null;
    for (const e of events) {
      if (e.activityId !== input.activityId) continue;
      if (e.kind === "activity_scheduled") {
        activityKey = typeof e.payload["definitionActivityKey"] === "string" ? (e.payload["definitionActivityKey"] as string) : null;
        kind = typeof e.payload["kind"] === "string" ? (e.payload["kind"] as string) : "transformation";
        activityInput = (e.payload["input"] as Record<string, unknown>) ?? {};
        retryPolicy = resolveRetryPolicy(e.payload["retryPolicy"]);
      } else if (e.kind === "activity_started") {
        attempts += 1;
      }
      lastKind = e.kind;
    }
    // retry only a settled failure (not in-flight, not succeeded)
    if (activityKey === null || (lastKind !== "activity_failed" && lastKind !== "activity_timed_out")) return miss;
    const outcome = await this.runActivityAttempt(
      input.instanceId,
      definition,
      state.tenantId,
      input.activityId,
      activityKey,
      kind,
      activityInput,
      attempts + 1,
      retryPolicy,
    );
    // runActivityAttempt applies the immediate post-activity transition; run the
    // step loop so a resulting terminal state finalizes (emits instance_completed
    // /failed) — the inline schedule path gets this from its enclosing step loop.
    await this.runStepLoop(input.instanceId, definition);
    return { retried: true, instanceId: input.instanceId, activityId: input.activityId, status: outcome };
  }

  /** Runs one activity attempt: `activity_started` → handler → completed/failed/timed_out + transition. */
  private async runActivityAttempt(
    instanceId: string,
    definition: WorkflowDefinition,
    tenantId: string,
    activityId: string,
    activityKey: string,
    kind: string,
    inputData: Record<string, unknown>,
    attemptNumber: number,
    retryPolicy: RetryPolicy,
  ): Promise<"succeeded" | "failed" | "timed_out"> {
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
      payload: { attemptNumber },
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
          nextRetryAt: computeNextRetryAt({ policy: retryPolicy, attemptNumber, now: this.clock.now() }),
        },
        correlationId: null,
        causationEventId: null,
      });
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
        payload: {
          errorMessage: outcome.errorMessage,
          attemptNumber,
          nextRetryAt: computeNextRetryAt({ policy: retryPolicy, attemptNumber, now: this.clock.now() }),
        },
        correlationId: null,
        causationEventId: null,
      });
    }
    return outcome.status;
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
      payload: { timerName, fireAt, kind: "relative_after" },
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
