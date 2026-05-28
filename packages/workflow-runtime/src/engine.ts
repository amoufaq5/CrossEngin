import { sha256 } from "@crossengin/crypto";
import {
  TERMINAL_STATE_KINDS,
  type StateAction,
  type TransitionDefinition,
  type WorkflowDefinition,
  type WorkflowEvent,
} from "@crossengin/workflow-engine";

import { type ActivityRegistry, unsupportedHandler } from "./activity-handlers.js";
import { type Clock, type IdGenerator, SystemClock, RandomIdGenerator } from "./clock.js";
import { type EventLog } from "./event-log.js";
import {
  NoopInstrumentation,
  type WorkflowInstrumentation,
  type WorkflowInstrumentationEvent,
  type WorkflowInstrumentationKind,
} from "./instrumentation.js";
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
  readonly instrumentation?: WorkflowInstrumentation;
}

export interface StartInstanceInput {
  readonly definitionId: string;
  readonly tenantId: string;
  readonly variables?: Record<string, unknown>;
  readonly correlationKey?: string;
  readonly parentInstanceId?: string;
  readonly startedByUserId?: string | null;
  readonly startedBySystem?: string | null;
  // Pre-generated instance id (spawn_child_workflow uses this so the parent's
  // child_workflow_spawned event can record the id before the child runs).
  readonly instanceId?: string;
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

export interface SubmitManualActionInput {
  readonly instanceId: string;
  readonly tenantId: string;
  readonly actionName: string;
  // Required: the manual_action_taken event schema requires a non-null actor.
  readonly actorPrincipalId: string;
  readonly actorRoles?: readonly string[];
  readonly secondApproverPrincipalId?: string;
  readonly reason?: string;
  readonly attributes?: Record<string, unknown>;
}

export interface SubmitManualActionResult {
  readonly applied: boolean;
  readonly transitionName: string | null;
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
  private readonly instanceDefinition: Map<string, string> = new Map();
  private readonly emittedTerminals: Set<string> = new Set();
  private readonly instrumentation: WorkflowInstrumentation;

  constructor(opts: EngineOptions) {
    this.eventLog = opts.eventLog;
    this.definitions = opts.definitions;
    this.registry = opts.activityRegistry;
    this.clock = opts.clock ?? new SystemClock();
    this.ids = opts.idGenerator ?? new RandomIdGenerator();
    this.guardEvaluator = opts.guardEvaluator ?? defaultGuardEvaluator;
    this.systemActorId = opts.systemActorId ?? "workflow-engine";
    this.instrumentation = opts.instrumentation ?? NoopInstrumentation;
  }

  private async emitInstrumentation(
    kind: WorkflowInstrumentationKind,
    fields: {
      tenantId: string;
      instanceId: string | null;
      definitionId: string | null;
      correlationId?: string | null;
      durationMs?: number | null;
      attributes?: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    const event: WorkflowInstrumentationEvent = {
      kind,
      tenantId: fields.tenantId,
      instanceId: fields.instanceId,
      definitionId: fields.definitionId,
      correlationId: fields.correlationId ?? null,
      occurredAt: this.clock.nowIso(),
      durationMs: fields.durationMs ?? null,
      attributes: fields.attributes ?? {},
    };
    try {
      await this.instrumentation.onEvent(event);
    } catch (err) {
      // Instrumentation must never crash the engine. Swallow + emit
      // engine_error via the noop fallback so observability failures
      // are visible in subsequent traces but don't propagate.
      if (this.instrumentation !== NoopInstrumentation) {
        try {
          await NoopInstrumentation.onEvent({
            kind: "engine_error",
            tenantId: fields.tenantId,
            instanceId: fields.instanceId,
            definitionId: fields.definitionId,
            correlationId: fields.correlationId ?? null,
            occurredAt: this.clock.nowIso(),
            durationMs: null,
            attributes: {
              source: "instrumentation",
              originalKind: kind,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        } catch {
          // Truly inert.
        }
      }
    }
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

    const instanceId = input.instanceId ?? this.ids.generate("wfi");
    const occurredAt = this.clock.nowIso();
    const timeoutAt = new Date(
      this.clock.now().getTime() + definition.timeoutSeconds * 1000,
    ).toISOString();

    this.instanceTenant.set(instanceId, input.tenantId);
    this.instanceDefinition.set(instanceId, definition.id);
    if (input.correlationKey !== undefined) {
      this.instanceCorrelation.set(instanceId, input.correlationKey);
    }

    await this.emitInstrumentation("instance_started", {
      tenantId: input.tenantId,
      instanceId,
      definitionId: definition.id,
      correlationId: input.correlationKey ?? null,
      attributes: {
        definitionKey: definition.definitionKey,
        definitionVersion: definition.version,
        initialState: definition.initialState,
        startedByUserId: input.startedByUserId ?? null,
        startedBySystem: input.startedBySystem ?? null,
      },
    });

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
      if (
        state.status !== "running" &&
        state.status !== "waiting_for_signal" &&
        state.status !== "waiting_for_timer"
      )
        continue;
      const definition = this.definitions.get(state.definitionId);
      if (definition === undefined) continue;

      const nextSeq = (await this.eventLog.latestSequence(instanceId)) ?? -1;
      const occurredAt = this.clock.nowIso();
      await this.emitInstrumentation("signal_received", {
        tenantId: input.tenantId,
        instanceId,
        definitionId: this.instanceDefinition.get(instanceId) ?? null,
        correlationId: input.correlationKey,
        attributes: {
          signalName: input.signalName,
          signalId,
          sourceSystem: input.sourceSystem ?? null,
        },
      });
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
      await this.emitInstrumentation("signal_consumed", {
        tenantId: input.tenantId,
        instanceId,
        definitionId: this.instanceDefinition.get(instanceId) ?? null,
        correlationId: input.correlationKey,
        attributes: { signalName: input.signalName, signalId },
      });
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

  // Driver for the manual_action transition trigger — the human / external-system
  // counterpart to submitSignal / tickTimers / child completion. Operator targets
  // a specific instance + action; the engine enforces the trigger's
  // requiredRole + requiresFourEyes (rejects with throw), records the
  // manual_action_taken event (audit, regardless of match), and fires the
  // matching transition if one passes guards. Accepts running or
  // waiting_for_manual statuses (terminal/other-waiting statuses throw).
  async submitManualAction(input: SubmitManualActionInput): Promise<SubmitManualActionResult> {
    const tenantId = this.instanceTenant.get(input.instanceId);
    if (tenantId === undefined) {
      throw new Error(`manual action: unknown instance ${input.instanceId}`);
    }
    if (tenantId !== input.tenantId) {
      throw new Error(`manual action: instance ${input.instanceId} belongs to a different tenant`);
    }
    const state = await this.getInstanceState(input.instanceId);
    if (state === null) {
      throw new Error(`manual action: instance ${input.instanceId} has no projected state`);
    }
    if (
      state.status === "completed" ||
      state.status === "failed" ||
      state.status === "cancelled" ||
      state.status === "compensated"
    ) {
      throw new Error(
        `manual action: instance ${input.instanceId} is in terminal status ${state.status}`,
      );
    }
    if (state.status !== "running" && state.status !== "waiting_for_manual") {
      throw new Error(
        `manual action: instance ${input.instanceId} is in status ${state.status} (must be running or waiting_for_manual)`,
      );
    }
    const definition = this.definitions.get(state.definitionId);
    if (definition === undefined) {
      throw new Error(`manual action: definition ${state.definitionId} not found`);
    }

    // Match by trigger kind+actionName and evaluate guards (role_required uses
    // input.actorRoles via the default evaluator). Null = no transition matched.
    const transition = evaluateNextTransition({
      definition,
      fromState: state.currentState,
      trigger: { kind: "manual_action", actionName: input.actionName },
      variables: state.variables,
      ...(input.actorRoles !== undefined ? { principalRoles: input.actorRoles } : {}),
      evaluator: this.guardEvaluator,
    });

    // If a candidate matched, enforce the trigger's own preconditions
    // (separate from transition guards) before appending the audit event.
    if (transition !== null && transition.trigger.kind === "manual_action") {
      if (transition.trigger.requiresFourEyes) {
        if (input.secondApproverPrincipalId === undefined) {
          throw new Error(
            `manual action ${input.actionName}: four-eyes required (secondApproverPrincipalId)`,
          );
        }
        if (input.secondApproverPrincipalId === input.actorPrincipalId) {
          throw new Error(
            `manual action ${input.actionName}: four-eyes requires a distinct second approver`,
          );
        }
      }
      if (
        transition.trigger.requiredRole !== undefined &&
        !(input.actorRoles?.includes(transition.trigger.requiredRole) ?? false)
      ) {
        throw new Error(
          `manual action ${input.actionName}: actor lacks required role ${transition.trigger.requiredRole}`,
        );
      }
    }

    const occurredAt = this.clock.nowIso();
    const eventPayload: Record<string, unknown> = { actionName: input.actionName };
    if (input.secondApproverPrincipalId !== undefined) {
      eventPayload["secondApproverPrincipalId"] = input.secondApproverPrincipalId;
    }
    if (input.reason !== undefined) eventPayload["reason"] = input.reason;
    if (input.attributes !== undefined) eventPayload["attributes"] = input.attributes;

    const instrAttrs: Record<string, unknown> = {
      actionName: input.actionName,
      actorPrincipalId: input.actorPrincipalId,
      transitionApplied: transition !== null,
    };
    if (transition !== null) instrAttrs["transitionName"] = transition.name;
    if (input.secondApproverPrincipalId !== undefined) {
      instrAttrs["secondApproverPrincipalId"] = input.secondApproverPrincipalId;
    }
    if (input.reason !== undefined) instrAttrs["reason"] = input.reason;

    await this.emitInstrumentation("manual_action_taken", {
      tenantId,
      instanceId: input.instanceId,
      definitionId: state.definitionId,
      correlationId: this.instanceCorrelation.get(input.instanceId) ?? null,
      attributes: instrAttrs,
    });
    const nextSeq = (await this.eventLog.latestSequence(input.instanceId))!;
    await this.appendEvent({
      instanceId: input.instanceId,
      tenantId,
      sequenceNumber: nextSeq + 1,
      kind: "manual_action_taken",
      occurredAt,
      actorPrincipalId: input.actorPrincipalId,
      actorSystemId: null,
      previousState: null,
      newState: null,
      activityId: null,
      signalId: null,
      timerId: null,
      childInstanceId: null,
      variableName: null,
      payload: eventPayload,
      correlationId: null,
      causationEventId: null,
    });

    if (transition === null) {
      return { applied: false, transitionName: null };
    }
    await this.applyTransition(input.instanceId, definition, transition, state, null, null);
    await this.runStepLoop(input.instanceId, definition);
    return { applied: true, transitionName: transition.name };
  }

  async tickTimers(nowMs: number): Promise<TickTimersResult> {
    const firedTimerIds: string[] = [];
    const affected = new Set<string>();
    for (const [instanceId] of this.instanceTenant) {
      const state = await this.getInstanceState(instanceId);
      if (state === null) continue;
      if (
        state.status !== "waiting_for_timer" &&
        state.status !== "running" &&
        state.status !== "waiting_for_signal"
      )
        continue;
      const definition = this.definitions.get(state.definitionId);
      if (definition === undefined) continue;
      const events = await this.eventLog.listByInstance(instanceId);
      const scheduled = this.activeTimersFromEvents(events);
      for (const timer of scheduled.values()) {
        if (timer.fireAt > nowMs) continue;
        await this.emitInstrumentation("timer_fired", {
          tenantId: state.tenantId,
          instanceId,
          definitionId: this.instanceDefinition.get(instanceId) ?? null,
          correlationId: this.instanceCorrelation.get(instanceId) ?? null,
          attributes: {
            timerId: timer.id,
            timerName: timer.name,
            fireAt: timer.fireAt,
          },
        });
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
        affected.add(instanceId);
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
    }
    return { firedTimerIds, affectedInstanceIds: [...affected] };
  }

  async cancelInstance(input: {
    instanceId: string;
    reason: string;
    cancelledByUserId?: string | null;
  }): Promise<void> {
    const state = await this.getInstanceState(input.instanceId);
    if (state === null) throw new Error(`unknown instance ${input.instanceId}`);
    if (
      state.status === "completed" ||
      state.status === "cancelled" ||
      state.status === "compensated"
    ) {
      throw new Error(`cannot cancel instance in terminal status ${state.status}`);
    }
    const nextSeq = (await this.eventLog.latestSequence(input.instanceId))!;
    await this.emitInstrumentation("instance_cancelled", {
      tenantId: state.tenantId,
      instanceId: input.instanceId,
      definitionId: this.instanceDefinition.get(input.instanceId) ?? state.definitionId,
      correlationId: this.instanceCorrelation.get(input.instanceId) ?? null,
      attributes: {
        reason: input.reason,
        cancelledByUserId: input.cancelledByUserId ?? null,
      },
    });
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

  private async runStepLoop(instanceId: string, definition: WorkflowDefinition): Promise<void> {
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
        if (
          kind === "terminal_success" ||
          kind === "terminal_failure" ||
          kind === "terminal_cancelled"
        ) {
          await this.emitTerminalForStateKind(instanceId, state, kind);
        }
        return;
      }
      if (
        state.status === "waiting_for_signal" ||
        state.status === "waiting_for_timer" ||
        state.status === "waiting_for_activity" ||
        state.status === "waiting_for_manual" ||
        state.status === "waiting_for_child" ||
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
    await this.emitInstrumentation("state_transitioned", {
      tenantId: fromState.tenantId,
      instanceId,
      definitionId: definition.id,
      correlationId: this.instanceCorrelation.get(instanceId) ?? null,
      attributes: {
        previousState: transition.fromState,
        newState: transition.toState,
        transitionName: transition.name,
        signalId,
        timerId,
      },
    });
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
        await this.applyAction(
          instanceId,
          definition,
          action,
          fromState.tenantId,
          signalId,
          timerId,
        );
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
        await this.applyCancelTimer(instanceId, tenantId, action);
        return;
      case "send_signal":
        await this.applySendSignal(instanceId, tenantId, action);
        return;
      case "spawn_child_workflow":
        await this.applySpawnChildWorkflow(instanceId, tenantId, action);
        return;
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
    await this.emitInstrumentation("activity_scheduled", {
      tenantId,
      instanceId,
      definitionId: definition.id,
      correlationId: this.instanceCorrelation.get(instanceId) ?? null,
      attributes: { activityId, activityKey, activityKind: kind },
    });
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
        attemptNumber: 1,
        inputSha256: sha256(JSON.stringify(inputData)),
      },
      correlationId: null,
      causationEventId: null,
    });

    const handler =
      this.registry.resolve({
        kind: kind as never,
        definitionId: definition.id,
        activityKey,
      }) ?? unsupportedHandler;
    const state = await this.getInstanceState(instanceId);
    const activityStartedAt = this.clock.now().getTime();
    await this.emitInstrumentation("activity_started", {
      tenantId,
      instanceId,
      definitionId: definition.id,
      correlationId: this.instanceCorrelation.get(instanceId) ?? null,
      attributes: { activityId, activityKey, activityKind: kind },
    });
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
        attemptNumber: 1,
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
    const activityDurationMs = this.clock.now().getTime() - activityStartedAt;

    const completionSeq = (await this.eventLog.latestSequence(instanceId))!;
    if (outcome.status === "succeeded") {
      await this.emitInstrumentation("activity_completed", {
        tenantId,
        instanceId,
        definitionId: definition.id,
        correlationId: this.instanceCorrelation.get(instanceId) ?? null,
        durationMs: activityDurationMs,
        attributes: { activityId, activityKey, activityKind: kind },
      });
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
      await this.emitInstrumentation("activity_failed", {
        tenantId,
        instanceId,
        definitionId: definition.id,
        correlationId: this.instanceCorrelation.get(instanceId) ?? null,
        durationMs: activityDurationMs,
        attributes: {
          activityId,
          activityKey,
          activityKind: kind,
          errorCode: outcome.errorCode,
          errorMessage: outcome.errorMessage,
          retryable: outcome.retryable,
        },
      });
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
        payload: { errorCode: outcome.errorCode, errorMessage: outcome.errorMessage },
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
        payload: { errorMessage: outcome.errorMessage },
        correlationId: null,
        causationEventId: null,
      });
    }
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

  // Reconstruct the still-active timers for an instance from its event log:
  // every timer_scheduled minus those later fired or cancelled.
  private activeTimersFromEvents(
    events: readonly WorkflowEvent[],
  ): Map<string, { id: string; name: string; fireAt: number }> {
    const scheduled = new Map<string, { id: string; name: string; fireAt: number }>();
    for (const e of events) {
      if (e.kind === "timer_scheduled" && e.timerId !== null) {
        const name =
          typeof e.payload["timerName"] === "string" ? (e.payload["timerName"] as string) : "";
        const fireAt =
          typeof e.payload["fireAt"] === "string"
            ? Date.parse(e.payload["fireAt"] as string)
            : Number.MAX_SAFE_INTEGER;
        scheduled.set(e.timerId, { id: e.timerId, name, fireAt });
      } else if ((e.kind === "timer_fired" || e.kind === "timer_cancelled") && e.timerId !== null) {
        scheduled.delete(e.timerId);
      }
    }
    return scheduled;
  }

  // cancel_timer: cancel every still-active timer matching the action's
  // timerName (rescheduling can leave more than one). Cancelling an already-
  // fired / unknown timer is a safe no-op (common in saga compensation).
  private async applyCancelTimer(
    instanceId: string,
    tenantId: string,
    action: StateAction,
  ): Promise<void> {
    const timerName =
      typeof action.parameters["timerName"] === "string"
        ? (action.parameters["timerName"] as string)
        : null;
    if (timerName === null) return;
    const events = await this.eventLog.listByInstance(instanceId);
    const matches = [...this.activeTimersFromEvents(events).values()].filter(
      (t) => t.name === timerName,
    );
    for (const timer of matches) {
      await this.emitInstrumentation("timer_cancelled", {
        tenantId,
        instanceId,
        definitionId: this.instanceDefinition.get(instanceId) ?? null,
        correlationId: this.instanceCorrelation.get(instanceId) ?? null,
        attributes: {
          timerId: timer.id,
          timerName: timer.name,
        },
      });
      const nextSeq = (await this.eventLog.latestSequence(instanceId))!;
      await this.appendEvent({
        instanceId,
        tenantId,
        sequenceNumber: nextSeq + 1,
        kind: "timer_cancelled",
        occurredAt: this.clock.nowIso(),
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
    }
  }

  // send_signal: emit a signal to other instances correlated by the action's
  // correlationKey, reusing the submitSignal delivery path (the saga-coordinator
  // → participants pattern). Signals are tenant-scoped — the sender reaches only
  // instances in its own tenant. Signal delivery lives as signal_received /
  // signal_consumed events on the *receivers*; the sender's instanceId is threaded
  // as sourceSystem so each receiver's signal_received names the emitting instance,
  // and the sender records a signal_emitted instrumentation trace (with the
  // resulting signalId + matched count) for observability.
  private async applySendSignal(
    instanceId: string,
    tenantId: string,
    action: StateAction,
  ): Promise<void> {
    const signalName =
      typeof action.parameters["signalName"] === "string"
        ? (action.parameters["signalName"] as string)
        : null;
    const correlationKey =
      typeof action.parameters["correlationKey"] === "string"
        ? (action.parameters["correlationKey"] as string)
        : null;
    if (signalName === null || correlationKey === null) return;
    const rawPayload = action.parameters["payload"];
    const payload =
      typeof rawPayload === "object" && rawPayload !== null && !Array.isArray(rawPayload)
        ? (rawPayload as Record<string, unknown>)
        : undefined;
    const result = await this.submitSignal({
      tenantId,
      signalName,
      correlationKey,
      payload,
      sourceSystem: instanceId,
    });
    await this.emitInstrumentation("signal_emitted", {
      tenantId,
      instanceId,
      definitionId: this.instanceDefinition.get(instanceId) ?? null,
      correlationId: this.instanceCorrelation.get(instanceId) ?? null,
      attributes: {
        signalName,
        targetCorrelationKey: correlationKey,
        signalId: result.signalId,
        matchedInstanceCount: result.matchedInstanceIds.length,
      },
    });
  }

  private findPublishedDefinitionByKey(
    definitionKey: string,
    tenantId: string,
  ): WorkflowDefinition | undefined {
    for (const def of this.definitions.values()) {
      if (
        def.definitionKey === definitionKey &&
        def.status === "published" &&
        (def.tenantId === null || def.tenantId === tenantId)
      ) {
        return def;
      }
    }
    return undefined;
  }

  // spawn_child_workflow: start a child instance of the definition named by the
  // action's childDefinitionKey, linked to this (parent) instance. The parent's
  // child_workflow_spawned event (with the child's id) is appended BEFORE the
  // child runs, so a synchronously-terminating child's completion notification
  // sees the spawn already logged. No-op when childDefinitionKey is missing or
  // no published definition in the parent's tenant has that key.
  private async applySpawnChildWorkflow(
    parentInstanceId: string,
    tenantId: string,
    action: StateAction,
  ): Promise<void> {
    const childDefinitionKey =
      typeof action.parameters["childDefinitionKey"] === "string"
        ? (action.parameters["childDefinitionKey"] as string)
        : null;
    if (childDefinitionKey === null) return;
    const childDef = this.findPublishedDefinitionByKey(childDefinitionKey, tenantId);
    if (childDef === undefined) return;
    const rawInput = action.parameters["input"];
    const childVariables =
      typeof rawInput === "object" && rawInput !== null && !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>)
        : undefined;
    const childCorrelationKey =
      typeof action.parameters["correlationKey"] === "string"
        ? (action.parameters["correlationKey"] as string)
        : undefined;

    const childInstanceId = this.ids.generate("wfi");
    await this.emitInstrumentation("child_workflow_spawned", {
      tenantId,
      instanceId: parentInstanceId,
      definitionId: this.instanceDefinition.get(parentInstanceId) ?? null,
      correlationId: this.instanceCorrelation.get(parentInstanceId) ?? null,
      attributes: { childInstanceId, childDefinitionId: childDef.id, childDefinitionKey },
    });
    const nextSeq = (await this.eventLog.latestSequence(parentInstanceId))!;
    await this.appendEvent({
      instanceId: parentInstanceId,
      tenantId,
      sequenceNumber: nextSeq + 1,
      kind: "child_workflow_spawned",
      occurredAt: this.clock.nowIso(),
      actorPrincipalId: null,
      actorSystemId: this.systemActorId,
      previousState: null,
      newState: null,
      activityId: null,
      signalId: null,
      timerId: null,
      childInstanceId,
      variableName: null,
      payload: { childDefinitionId: childDef.id, childDefinitionKey },
      correlationId: null,
      causationEventId: null,
    });

    await this.startInstance({
      definitionId: childDef.id,
      tenantId,
      instanceId: childInstanceId,
      parentInstanceId,
      ...(childVariables !== undefined ? { variables: childVariables } : {}),
      ...(childCorrelationKey !== undefined ? { correlationKey: childCorrelationKey } : {}),
    });
  }

  // When a child instance reaches a terminal state, record child_workflow_completed
  // on its parent and fire the parent's matching child_workflow_completed
  // transition (matched by the child's definitionKey). Reuses submitSignal's
  // drive pattern. Skips a parent that no longer exists or is already terminal.
  private async notifyParentOfChildCompletion(
    parentInstanceId: string,
    childInstanceId: string,
    childState: ProjectedInstance,
    childKind: "terminal_success" | "terminal_failure" | "terminal_cancelled",
  ): Promise<void> {
    const parentState = await this.getInstanceState(parentInstanceId);
    if (parentState === null) return;
    if (
      parentState.status === "completed" ||
      parentState.status === "failed" ||
      parentState.status === "cancelled" ||
      parentState.status === "compensated"
    ) {
      return;
    }
    const parentDef = this.definitions.get(parentState.definitionId);
    if (parentDef === undefined) return;
    const childDefinitionKey = childState.definitionKey;

    await this.emitInstrumentation("child_workflow_completed", {
      tenantId: parentState.tenantId,
      instanceId: parentInstanceId,
      definitionId: parentState.definitionId,
      correlationId: this.instanceCorrelation.get(parentInstanceId) ?? null,
      attributes: { childInstanceId, childDefinitionKey, childTerminalKind: childKind },
    });
    const nextSeq = (await this.eventLog.latestSequence(parentInstanceId))!;
    await this.appendEvent({
      instanceId: parentInstanceId,
      tenantId: parentState.tenantId,
      sequenceNumber: nextSeq + 1,
      kind: "child_workflow_completed",
      occurredAt: this.clock.nowIso(),
      actorPrincipalId: null,
      actorSystemId: this.systemActorId,
      previousState: null,
      newState: null,
      activityId: null,
      signalId: null,
      timerId: null,
      childInstanceId,
      variableName: null,
      payload: { childDefinitionKey, childTerminalKind: childKind },
      correlationId: null,
      causationEventId: null,
    });

    const transition = evaluateNextTransition({
      definition: parentDef,
      fromState: parentState.currentState,
      trigger: { kind: "child_workflow_completed", childDefinitionKey },
      variables: parentState.variables,
      evaluator: this.guardEvaluator,
    });
    if (transition !== null) {
      await this.applyTransition(parentInstanceId, parentDef, transition, parentState, null, null);
      await this.runStepLoop(parentInstanceId, parentDef);
    }
  }

  private async emitTerminalForStateKind(
    instanceId: string,
    state: ProjectedInstance,
    kind: "terminal_success" | "terminal_failure" | "terminal_cancelled",
  ): Promise<void> {
    if (this.emittedTerminals.has(instanceId)) return;
    this.emittedTerminals.add(instanceId);
    const instrumentationKind: WorkflowInstrumentationKind =
      kind === "terminal_success"
        ? "instance_completed"
        : kind === "terminal_failure"
          ? "instance_failed"
          : "instance_cancelled";
    await this.emitInstrumentation(instrumentationKind, {
      tenantId: state.tenantId,
      instanceId,
      definitionId: state.definitionId,
      correlationId: this.instanceCorrelation.get(instanceId) ?? null,
      attributes: {
        terminalState: state.currentState,
        terminalKind: kind,
      },
    });
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

    if (state.parentInstanceId !== null) {
      await this.notifyParentOfChildCompletion(state.parentInstanceId, instanceId, state, kind);
    }
  }

  registerInstance(
    instanceId: string,
    tenantId: string,
    correlationKey?: string,
    definitionId?: string,
  ): void {
    this.instanceTenant.set(instanceId, tenantId);
    if (correlationKey !== undefined) {
      this.instanceCorrelation.set(instanceId, correlationKey);
    }
    if (definitionId !== undefined) {
      this.instanceDefinition.set(instanceId, definitionId);
    }
  }
}
