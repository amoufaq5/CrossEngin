import { sha256 } from "@crossengin/crypto";
import {
  InstanceCancellationRequestSchema,
  TERMINAL_STATE_KINDS,
  TIMER_KIND_SCHEDULING,
  planInstanceCancellation,
  resolveNextTimerFireAt,
  resolveTimerFireAt,
  type ActionKind,
  type ActivityCancellationCheckpoint,
  type InstanceCancellationCompensationOutcome,
  type InstanceCancellationOutcome,
  type InstanceCancellationRequestInput,
  type StateAction,
  type TimerDefinition,
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
import {
  type OutstandingTimer,
  outstandingTimersFromLog,
  surveyCancellableWork,
} from "./instance-cancellation.js";
import {
  type ProjectedInstance,
  isInstanceCancellationRequested,
  projectInstance,
} from "./projection.js";
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
 * How many parents a spawned instance may already have above it. A definition whose child spawns
 * back into its own lineage would otherwise recurse until the stack died; bounding the chain turns
 * that authoring mistake into a named refusal.
 */
export const MAX_CHILD_WORKFLOW_DEPTH = 8;

/** How deep a `send_signal` chain may nest before it is refused (A signals B, B signals A, …). */
export const MAX_SIGNAL_DISPATCH_DEPTH = 8;

export const WORKFLOW_ACTION_FAILURES = [
  "missing_parameter",
  "unknown_child_definition",
  "unresolved_correlation_key",
  "child_depth_exceeded",
  "signal_depth_exceeded",
  /** `schedule_timer` names a timer the definition does not declare. */
  "undeclared_timer",
  /**
   * The declared timer cannot be turned into a fire instant — the eleven
   * `TIMER_SCHEDULE_DEFECTS`, surfaced as one action failure carrying the defect in its detail.
   * One member rather than eleven because the caller's remedy is the same for all of them (fix the
   * declaration) and the defect name is already in the message.
   */
  "unschedulable_timer",
] as const;
export type WorkflowActionFailure = (typeof WORKFLOW_ACTION_FAILURES)[number];

/**
 * A state action the engine understands but cannot carry out for *this* definition — a required
 * parameter the `StateActionSchema` does not itself demand, a child definition key that resolves to
 * nothing registered, or a dispatch chain deep enough to be a cycle. It names the action, the
 * instance and what the caller has to change, which an `Error` carrying a milestone label did not.
 */
export class WorkflowActionError extends Error {
  readonly actionKind: ActionKind;
  readonly failure: WorkflowActionFailure;
  readonly instanceId: string;

  constructor(input: {
    readonly actionKind: ActionKind;
    readonly failure: WorkflowActionFailure;
    readonly instanceId: string;
    readonly detail: string;
  }) {
    super(`${input.actionKind} action on instance ${input.instanceId} cannot run: ${input.detail}`);
    this.name = "WorkflowActionError";
    this.actionKind = input.actionKind;
    this.failure = input.failure;
    this.instanceId = input.instanceId;
  }
}

/**
 * The signal id this instance already received under `(signalName, idempotencyKey)`, or `null`.
 *
 * Read from the instance's own history, which is the only authority that cannot be stale: a
 * deduplicator's read happens before the appends it is meant to prevent, so two concurrent submits
 * of one key can both get past it.
 */
export function priorReceiptSignalId(
  events: readonly WorkflowEvent[],
  signalName: string,
  idempotencyKey: string,
): string | null {
  for (const event of events) {
    if (event.kind !== "signal_received" || event.signalId === null) continue;
    if (event.payload["signalName"] !== signalName) continue;
    if (event.payload["idempotencyKey"] !== idempotencyKey) continue;
    return event.signalId;
  }
  return null;
}

/** A non-empty string action parameter, or `null` when absent or of another type. */
function stringParam(action: StateAction, key: string): string | null {
  const value = action.parameters[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordParam(action: StateAction, key: string): Record<string, unknown> {
  const value = action.parameters[key];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** Orders `a.b.c` versions numerically so the newest published definition of a key is pickable. */
function compareDefinitionVersions(left: string, right: string): number {
  const l = left.split(".").map((p) => Number.parseInt(p, 10));
  const r = right.split(".").map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < Math.max(l.length, r.length); i++) {
    const a = Number.isFinite(l[i]) ? (l[i] as number) : 0;
    const b = Number.isFinite(r[i]) ? (r[i] as number) : 0;
    if (a !== b) return a - b;
  }
  return 0;
}

export interface CancelInstanceResult {
  readonly outcome: InstanceCancellationOutcome;
  /** Unfired timers dropped, each with a `timer_cancelled` in the log. */
  readonly cancelledTimerIds: readonly string[];
  /** Scheduled activities whose handler was never entered. */
  readonly beforeHandlerActivityIds: readonly string[];
  /**
   * In-flight activities recorded cancelled at `cooperative_abort`. A subset of these had their
   * `AbortSignal` actually tripped — see `signalDeliveredActivityIds`.
   */
  readonly cooperativeAbortActivityIds: readonly string[];
  /**
   * The in-flight activities this process could really tell. An activity started by *another*
   * process is recorded cancelled but cannot be signalled from here, and claiming otherwise would
   * overstate the one guarantee that is already the weakest.
   */
  readonly signalDeliveredActivityIds: readonly string[];
  readonly compensationOutcome: InstanceCancellationCompensationOutcome;
  readonly compensatedActivityIds: readonly string[];
  readonly unreversedActivityIds: readonly string[];
}

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
   * Who answers a duplicate submit. Defaults to `InMemorySignalDeduplicator`, which is correct for
   * one process; `buildPersistentEngine` supplies the one that reads the signal table.
   */
  readonly signalDeduplicator?: SignalDeduplicator;
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

/**
 * One instance's copy of a submitted signal.
 *
 * This pair is what the contract calls a `WorkflowSignal`: `instanceId` is singular there and
 * `matchSignalToInstance` returns one id, so a submit that fans out to N instances is N signals and
 * not one signal seen N times. `meta.workflow_signals.signal_id` is UNIQUE, so minting one id for
 * the whole fan-out collapsed the N rows into one — attributed to whichever instance was projected
 * last, with every earlier delivery invisible in the projection table.
 */
export interface SignalDelivery {
  readonly instanceId: string;
  readonly signalId: string;
}

/** The three fields `meta.workflow_signals`' unique key is on, as one value. */
export interface SignalIdempotency {
  readonly tenantId: string;
  readonly signalName: string;
  readonly idempotencyKey: string;
}

/**
 * Who answers "has this idempotency key already been accepted, and what did it deliver?".
 *
 * A seam rather than a field because the honest answer lives wherever the signals do: in this
 * package that is process memory, and in `workflow-runtime-pg` it is the `(tenant_id, signal_name,
 * idempotency_key)` unique key on `meta.workflow_signals` — which is the only answer that survives
 * a restart or reaches a second replica. `lookup` distinguishes **unseen** (`null`) from **seen and
 * delivered nothing** (`[]`), and `remember` is a no-op for a deduplicator whose ledger is the rows
 * the projection already writes.
 */
export interface SignalDeduplicator {
  lookup(key: SignalIdempotency): Promise<readonly SignalDelivery[] | null>;
  remember(key: SignalIdempotency, deliveries: readonly SignalDelivery[]): Promise<void>;
}

/** `tenantId|signalName|idempotencyKey`, the key both deduplicators agree on. */
export function signalIdempotencyCacheKey(key: SignalIdempotency): string {
  return `${key.tenantId}|${key.signalName}|${key.idempotencyKey}`;
}

/**
 * The offline deduplicator: correct for one process and for nothing else, which is why it is a
 * default rather than the mechanism.
 *
 * **A submit that matched no instance is not remembered.** The persistent deduplicator cannot
 * remember one — nothing was written, so there is no row to find — and the two must agree, because
 * the pure engine's tests are the contract. The reading that makes them agree is also the right
 * one: "no instance matched" is not a delivery, and a retry once an instance exists should deliver.
 */
export class InMemorySignalDeduplicator implements SignalDeduplicator {
  private readonly seen: Map<string, readonly SignalDelivery[]> = new Map();

  async lookup(key: SignalIdempotency): Promise<readonly SignalDelivery[] | null> {
    return this.seen.get(signalIdempotencyCacheKey(key)) ?? null;
  }

  async remember(
    key: SignalIdempotency,
    deliveries: readonly SignalDelivery[],
  ): Promise<void> {
    if (deliveries.length === 0) return;
    this.seen.set(signalIdempotencyCacheKey(key), deliveries);
  }
}

/**
 * A signal whose definition promises `exactly_once_idempotent` and whose submission carried no key.
 *
 * Refused before the `signal_received` event is appended, not after: the stored row would satisfy
 * every CHECK on `meta.workflow_signals` — `idempotency_key` is nullable — and fail
 * `WorkflowSignalSchema`, whose `superRefine` requires the key for that guarantee. That is an
 * ADR-0289-class row, and the only place it can be stopped for good is where it is submitted.
 */
export class SignalIdempotencyRequired extends Error {
  readonly signalName: string;
  readonly instanceId: string;
  readonly definitionId: string;

  constructor(input: {
    readonly signalName: string;
    readonly instanceId: string;
    readonly definitionId: string;
  }) {
    super(
      `signal ${input.signalName} is declared exactly_once_idempotent by definition ${input.definitionId}; ` +
        `submitting it to instance ${input.instanceId} requires an idempotencyKey`,
    );
    this.name = "SignalIdempotencyRequired";
    this.signalName = input.signalName;
    this.instanceId = input.instanceId;
    this.definitionId = input.definitionId;
  }
}

export interface SubmitSignalResult {
  readonly deduplicated: boolean;
  /** One entry per instance the signal reached, each with its own signal id. */
  readonly deliveries: readonly SignalDelivery[];
  /** `deliveries` projected to instance ids, in delivery order. */
  readonly matchedInstanceIds: readonly string[];
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
  private readonly signalDedup: SignalDeduplicator;
  private readonly instanceTenant: Map<string, string> = new Map();
  private readonly instanceCorrelation: Map<string, string> = new Map();
  /**
   * The `AbortController` of every activity handler this process currently has running, so a
   * cancellation can *tell* one. Keyed by instance then activity; an entry exists only for the
   * window between `activity_started` and the handler settling, which is exactly the window in
   * which `in_flight_activity`'s weaker guarantee applies.
   */
  private readonly inFlightActivities: Map<string, Map<string, AbortController>> = new Map();
  /** Nesting of in-flight `send_signal` dispatches, so a signal cycle is refused, not recursed. */
  private signalDispatchDepth = 0;

  constructor(opts: EngineOptions) {
    this.eventLog = opts.eventLog;
    this.definitions = opts.definitions;
    this.registry = opts.activityRegistry;
    this.clock = opts.clock ?? new SystemClock();
    this.ids = opts.idGenerator ?? new RandomIdGenerator();
    this.guardEvaluator = opts.guardEvaluator ?? defaultGuardEvaluator;
    this.systemActorId = opts.systemActorId ?? "workflow-engine";
    this.signalDedup = opts.signalDeduplicator ?? new InMemorySignalDeduplicator();
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

  /**
   * Delivers one submitted signal to every instance correlated to it.
   *
   * **The signal id is minted per delivery**, inside the loop. One id for the fan-out made N
   * deliveries one row (see `SignalDelivery`), which is why the result reports `deliveries` rather
   * than a single `signalId`: with N instances there is no such thing.
   *
   * **Dedup is asked, not assumed, and asked twice.** A `SignalDeduplicator` answers whether this
   * key has already been accepted anywhere, and a duplicate returns *the deliveries it originally
   * produced* instead of an empty match list — a caller retrying a webhook wants the instances it
   * already reached, and the old answer gave it nothing to hold. Then each instance's **own log**
   * is asked again before its receipt is appended, because the first answer can be stale: two
   * concurrent submits of one key both read "unseen", and without this the loser would append a
   * second receipt whose row the unique key refuses — leaving an instance whose projection can
   * never be rebuilt. The log is the authority, the deduplicator is the fast path.
   *
   * `deduplicated` therefore means **this submit delivered nothing new**, which both paths satisfy.
   */
  async submitSignal(input: SubmitSignalInput): Promise<SubmitSignalResult> {
    const idempotency: SignalIdempotency | null =
      input.idempotencyKey === undefined
        ? null
        : {
            tenantId: input.tenantId,
            signalName: input.signalName,
            idempotencyKey: input.idempotencyKey,
          };
    if (idempotency !== null) {
      const prior = await this.signalDedup.lookup(idempotency);
      if (prior !== null) {
        return {
          deduplicated: true,
          deliveries: prior,
          matchedInstanceIds: prior.map((d) => d.instanceId),
        };
      }
    }

    const deliveries: SignalDelivery[] = [];
    let appended = 0;
    // Snapshot the registry: delivering a signal can run a `spawn_child_workflow` action, which
    // registers the child mid-loop — a live Map iteration would then deliver this same signal to an
    // instance that did not exist when it was submitted.
    for (const [instanceId, tenantId] of [...this.instanceTenant]) {
      if (tenantId !== input.tenantId) continue;
      const corr = this.instanceCorrelation.get(instanceId);
      if (corr !== input.correlationKey) continue;
      const state = await this.getInstanceState(instanceId);
      if (state === null) continue;
      // Driver fence 3 of 4. As with timers, the status check does not cover it: between the fence
      // and the finalizing event the instance is still `running`, and a delivered signal would
      // transition it — running on-entry actions, scheduling activities, spawning children.
      if (isInstanceCancellationRequested(state)) continue;
      if (state.status !== "running" && state.status !== "waiting_for_signal") continue;
      const definition = this.definitions.get(state.definitionId);
      if (definition === undefined) continue;
      // Before this instance's own append, so the refusal is what stops the unparseable row rather
      // than something downstream noticing it after the fact.
      this.assertIdempotencyKeyStorable(
        definition,
        input.signalName,
        instanceId,
        idempotency,
      );
      if (idempotency !== null) {
        const already = priorReceiptSignalId(
          await this.eventLog.listByInstance(instanceId),
          input.signalName,
          idempotency.idempotencyKey,
        );
        if (already !== null) {
          deliveries.push({ instanceId, signalId: already });
          continue;
        }
      }

      const signalId = this.ids.generate("wfs");
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
          // On the receipt because the key is a fact of *arrival*, like the source system beside
          // it: `resolveSignalProvenance` reads both off this event, so the stored row carries the
          // key the submitter sent and the unique index finally enforces something.
          idempotencyKey: idempotency?.idempotencyKey ?? null,
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
      deliveries.push({ instanceId, signalId });
      appended += 1;
    }

    if (idempotency !== null) await this.signalDedup.remember(idempotency, deliveries);
    return {
      deduplicated: deliveries.length > 0 && appended === 0,
      deliveries,
      matchedInstanceIds: deliveries.map((d) => d.instanceId),
    };
  }

  /**
   * Refuses a submission the signal table could only store as a row the contract forbids.
   *
   * The guarantee is the *definition's*, never the submitter's, so this reads it off the declared
   * `SignalDefinition` — and an undeclared signal is left alone, because
   * `WorkflowDefinitionSchema` already refuses a `signal_received` transition naming one, so
   * nothing can be delivered under a name the definition does not hold.
   */
  private assertIdempotencyKeyStorable(
    definition: WorkflowDefinition,
    signalName: string,
    instanceId: string,
    idempotency: SignalIdempotency | null,
  ): void {
    if (idempotency !== null) return;
    const declared = definition.signals.find((s) => s.name === signalName);
    if (declared?.deliveryGuarantee !== "exactly_once_idempotent") return;
    throw new SignalIdempotencyRequired({
      signalName,
      instanceId,
      definitionId: definition.id,
    });
  }

  async tickTimers(nowMs: number): Promise<TickTimersResult> {
    const firedTimerIds: string[] = [];
    const affected = new Set<string>();
    // Snapshot for the same reason as submitSignal: a fired timer's transition may spawn a child.
    for (const [instanceId] of [...this.instanceTenant]) {
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
    // Driver fence 1 of 4. The status check below does not cover this: a cancellation leaves the
    // instance `running` until its finalizing event, so without this a timer could fire into an
    // instance that is on its way out — and a cancellation that fires timers is worse than none.
    if (isInstanceCancellationRequested(state)) {
      return { firedTimerIds: [], affectedInstanceIds: [] };
    }
    if (state.status !== "waiting_for_timer" && state.status !== "running") {
      return { firedTimerIds: [], affectedInstanceIds: [] };
    }
    const definition = this.definitions.get(state.definitionId);
    if (definition === undefined) return { firedTimerIds: [], affectedInstanceIds: [] };
    const scheduled = await this.outstandingTimers(instanceId);
    const firedTimerIds: string[] = [];
    for (const timer of scheduled) {
      if (timer.fireAt > nowMs) continue;
      const declared = definition.timers.find((t) => t.name === timer.name);
      // A fired timer the definition does not declare cannot be re-armed and cannot be told apart
      // from a one-shot, so it fires once and nothing recurs — the honest answer for a log written
      // against a definition that has since been superseded. `applyScheduleTimer` refuses to arm one,
      // so this is unreachable from the write path.
      const nextFireAt =
        declared === undefined ? null : this.nextOccurrenceFor(instanceId, declared, nowMs);
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
        // `nextFireAt` is in the *firing* event and not only in the re-arm, because the projection
        // has to be able to answer "when does this next fire" for a timer that fired and was not
        // re-armed — which is every recurring timer on an instance that ended in the same fire.
        payload: {
          timerName: timer.name,
          ...(nextFireAt === null ? {} : { nextFireAt }),
        },
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
      // Re-armed **after** the transition and the step loop, and only while the instance can still
      // act on the next occurrence. Re-arming unconditionally would leave a `scheduled` row on a
      // completed instance, which `fireDueTimersForInstance` refuses to advance on its status check —
      // so a worker would claim it, fire nothing, let the lease lapse and claim it again forever.
      // That is the hot loop ADR-0333 found on the UUID/TEXT mismatch, rebuilt deliberately.
      if (declared !== null && declared !== undefined && nextFireAt !== null) {
        const after = await this.getInstanceState(instanceId);
        if (after !== null && (after.status === "running" || after.status === "waiting_for_timer")) {
          await this.appendTimerRearm(
            instanceId,
            state.tenantId,
            declared,
            timer.id,
            nowMs,
            nextFireAt,
          );
        }
      }
    }
    return { firedTimerIds, affectedInstanceIds: firedTimerIds.length > 0 ? [instanceId] : [] };
  }

  /** This instance's still-scheduled timers, from the log (see `outstandingTimersFromLog`). */
  private async outstandingTimers(instanceId: string): Promise<readonly OutstandingTimer[]> {
    return outstandingTimersFromLog(await this.eventLog.listByInstance(instanceId));
  }

  /**
   * Cancels a workflow instance: drops its unfired timers, refuses to start anything further, tells
   * whatever is already running, optionally rolls the instance back, and finalizes it.
   *
   * **The order of the appends is the guarantee.** `instance_cancellation_requested` goes first and
   * is the fence every driver loop reads, so from that moment no timer fires, no activity starts and
   * no automatic transition runs — and that is true *before* any of the slower work below, which is
   * why the fence is an event and not the terminal status. `instance_cancelled` goes last, because
   * it seals the projection: once folded, nothing moves the status, which is what lets a handler
   * that ignored its signal report afterwards without resurrecting the instance.
   *
   * **Nothing is thrown for a refusal.** The five outcomes are reported distinctly, as ADR-0315's
   * route does, because "the instance does not exist", "somebody already cancelled it" and "it
   * failed, compensate it instead" are three different answers a caller has to act on differently.
   */
  async cancelInstance(input: InstanceCancellationRequestInput): Promise<CancelInstanceResult> {
    const request = InstanceCancellationRequestSchema.parse(input);
    const state = await this.getInstanceState(request.instanceId);
    const events =
      state === null ? [] : await this.eventLog.listByInstance(request.instanceId);
    const definition =
      state === null ? undefined : this.definitions.get(state.definitionId);
    const plan = planInstanceCancellation({
      status: state?.status ?? null,
      cancellationAlreadyRequested:
        state !== null && isInstanceCancellationRequested(state),
      disposition: request.disposition,
      // An unregistered definition cannot name a rollback strategy, so the honest reading is that no
      // compensation is available here — not that the caller's `compensate` silently did nothing.
      strategy: definition?.compensationStrategy ?? "no_compensation",
      work: surveyCancellableWork(events),
    });
    if (plan.outcome !== "cancelled" || state === null) {
      return {
        outcome: plan.outcome,
        cancelledTimerIds: [],
        beforeHandlerActivityIds: [],
        cooperativeAbortActivityIds: [],
        signalDeliveredActivityIds: [],
        compensationOutcome: plan.compensationOutcome,
        compensatedActivityIds: [],
        unreversedActivityIds: [],
      };
    }

    const tenantId = state.tenantId;
    await this.appendInstanceEvent(request.instanceId, tenantId, {
      kind: "instance_cancellation_requested",
      actorPrincipalId: request.requestedByUserId,
      actorSystemId: request.requestedBySystem ?? this.systemActorId,
      payload: {
        reason: request.reason,
        disposition: request.disposition,
        compensationOutcome: plan.compensationOutcome,
      },
    });

    for (const timerId of plan.dropTimerIds) {
      const timer = (await this.outstandingTimers(request.instanceId)).find(
        (t) => t.id === timerId,
      );
      if (timer === undefined) continue;
      await this.appendInstanceEvent(request.instanceId, tenantId, {
        kind: "timer_cancelled",
        timerId,
        // The projection keys `awaitingTimerNames` by name, so the drop has to carry the name the
        // schedule carried or the instance stays recorded as waiting on a timer that cannot fire.
        payload: { timerName: timer.name, cancelledBy: "instance_cancellation" },
      });
    }

    for (const activityId of plan.cancelBeforeHandlerActivityIds) {
      await this.appendActivityCancelled(
        request.instanceId,
        tenantId,
        activityId,
        "before_handler",
        false,
      );
    }

    const signalDelivered: string[] = [];
    for (const activityId of plan.signalActivityIds) {
      const controller = this.inFlightActivities.get(request.instanceId)?.get(activityId);
      if (controller !== undefined && !controller.signal.aborted) {
        controller.abort();
        signalDelivered.push(activityId);
      }
      await this.appendActivityCancelled(
        request.instanceId,
        tenantId,
        activityId,
        "cooperative_abort",
        controller !== undefined,
      );
    }

    const compensatedActivityIds =
      plan.compensationOutcome === "executed" && definition !== undefined
        ? await this.compensateForCancellation(request.instanceId, definition, state)
        : [];

    await this.appendInstanceEvent(request.instanceId, tenantId, {
      kind: "instance_cancelled",
      actorPrincipalId: request.requestedByUserId,
      actorSystemId: request.requestedBySystem ?? this.systemActorId,
      payload: {
        reason: request.reason,
        disposition: request.disposition,
        compensationOutcome: plan.compensationOutcome,
        compensatedActivityIds,
        // What this cancellation leaves standing. On the record rather than only in a return value,
        // because the caller's process is not what a later reader has.
        unreversedActivityIds: plan.unreversedActivityIds,
      },
    });

    return {
      outcome: "cancelled",
      cancelledTimerIds: plan.dropTimerIds,
      beforeHandlerActivityIds: plan.cancelBeforeHandlerActivityIds,
      cooperativeAbortActivityIds: plan.signalActivityIds,
      signalDeliveredActivityIds: signalDelivered,
      compensationOutcome: plan.compensationOutcome,
      compensatedActivityIds,
      unreversedActivityIds: plan.unreversedActivityIds,
    };
  }

  /**
   * Runs the saga rollback as part of a cancellation, emitting `activity_compensated` per step and
   * **not** the `compensation_started` / `compensation_completed` bracket the failure path uses.
   *
   * Those two move the instance to `compensating` and then `compensated`, and `INSTANCE_TRANSITIONS`
   * offers no `compensated → cancelled` edge — so using them would either leave the instance ending
   * `compensated` (indistinguishable from a saga unwinding a *failure*, losing the fact that a human
   * cancelled it) or write a path the state machine forbids. The instance ends `cancelled` in both
   * dispositions; the rollback is part of that act, not a state the instance passes through.
   */
  private async compensateForCancellation(
    instanceId: string,
    definition: WorkflowDefinition,
    state: ProjectedInstance,
  ): Promise<readonly string[]> {
    const events = await this.eventLog.listByInstance(instanceId);
    const plan = planCompensation({ definition, events });
    if (plan.steps.length === 0) return [];
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
    const compensated: string[] = [];
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
      compensated.push(step.originalActivityId);
    }
    return compensated;
  }

  /** Appends one `activity_cancelled`, carrying which of the two guarantees applied. */
  private async appendActivityCancelled(
    instanceId: string,
    tenantId: string,
    activityId: string,
    checkpoint: ActivityCancellationCheckpoint,
    signalDelivered: boolean,
  ): Promise<void> {
    await this.appendInstanceEvent(instanceId, tenantId, {
      kind: "activity_cancelled",
      activityId,
      payload: { checkpoint, signalDelivered },
    });
  }

  /**
   * Appends one event at the instance's next sequence number, defaulting every field a cancellation
   * does not set. The sequence is read immediately before the append so a run of appends stays
   * dense, which `isHistoryDense` asserts.
   */
  private async appendInstanceEvent(
    instanceId: string,
    tenantId: string,
    input: {
      readonly kind: WorkflowEvent["kind"];
      readonly payload: Record<string, unknown>;
      readonly actorPrincipalId?: string | null;
      readonly actorSystemId?: string | null;
      readonly activityId?: string | null;
      readonly timerId?: string | null;
    },
  ): Promise<void> {
    const nextSeq = (await this.eventLog.latestSequence(instanceId))!;
    await this.appendEvent({
      instanceId,
      tenantId,
      sequenceNumber: nextSeq + 1,
      kind: input.kind,
      occurredAt: this.clock.nowIso(),
      actorPrincipalId: input.actorPrincipalId ?? null,
      actorSystemId: input.actorSystemId ?? this.systemActorId,
      previousState: null,
      newState: null,
      activityId: input.activityId ?? null,
      signalId: null,
      timerId: input.timerId ?? null,
      childInstanceId: null,
      variableName: null,
      payload: input.payload,
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
      // Driver fence 2 of 4, and it is placed above the terminal-state-kind check on purpose: a
      // cancelled instance sitting in a `terminal_success` state must not emit `instance_completed`.
      if (isInstanceCancellationRequested(state)) return;
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
    // The triggering signal/timer is not threaded into any action: an action's effect is a function
    // of the instance's projected state, so it replays from the log without knowing what woke it.
    void signalId;
    void timerId;
    switch (action.kind) {
      case "set_variable":
        await this.applySetVariable(instanceId, tenantId, action);
        return;
      case "audit_log":
      case "emit_event":
        // Observational only: the append-only history *is* the audit trail, and an emitted domain
        // event leaves the workflow boundary, so neither changes this instance's projected state.
        return;
      case "schedule_activity":
        await this.applyScheduleActivity(instanceId, definition, action, tenantId);
        return;
      case "schedule_timer":
        await this.applyScheduleTimer(instanceId, definition, tenantId, action);
        return;
      case "cancel_timer":
        await this.applyCancelTimer(instanceId, tenantId, action);
        return;
      case "spawn_child_workflow":
        await this.applySpawnChildWorkflow(instanceId, tenantId, action);
        return;
      case "send_signal":
        await this.applySendSignal(instanceId, tenantId, action);
        return;
    }
  }

  /**
   * Cancels every outstanding timer of the named timer, as `timer_cancelled` events. The projection
   * keys `awaitingTimerNames` by *name*, so a name scheduled twice has to lose both timers before the
   * instance stops waiting — cancelling only the first would leave it parked forever.
   */
  private async applyCancelTimer(
    instanceId: string,
    tenantId: string,
    action: StateAction,
  ): Promise<void> {
    const timerName = stringParam(action, "timerName");
    if (timerName === null) {
      throw new WorkflowActionError({
        actionKind: "cancel_timer",
        failure: "missing_parameter",
        instanceId,
        detail: "parameters.timerName must be a non-empty string naming the timer to cancel",
      });
    }
    for (const timer of await this.outstandingTimers(instanceId)) {
      if (timer.name !== timerName) continue;
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
        payload: { timerName },
        correlationId: null,
        causationEventId: null,
      });
    }
  }

  /**
   * Starts a child instance from this engine's own definition registry and anchors it to the parent
   * with a `child_workflow_spawned`. The child is a first-class instance in the same log, so its
   * state is re-derived from its own events and the parent's log records only the link — replaying
   * the parent never re-spawns anything.
   *
   * A child that reaches a terminal status during its own start (the common case for a short
   * in-process child) is reported back immediately: nothing else would, since an in-process child has
   * no callback to fire later.
   */
  private async applySpawnChildWorkflow(
    instanceId: string,
    tenantId: string,
    action: StateAction,
  ): Promise<void> {
    const childDefinition = this.resolveChildDefinition(instanceId, action);
    const depth = await this.lineageDepth(instanceId);
    if (depth >= MAX_CHILD_WORKFLOW_DEPTH) {
      throw new WorkflowActionError({
        actionKind: "spawn_child_workflow",
        failure: "child_depth_exceeded",
        instanceId,
        detail: `child workflow lineage is already ${depth.toString()} deep (limit ${MAX_CHILD_WORKFLOW_DEPTH.toString()}); definition ${childDefinition.definitionKey} spawns back into its own lineage`,
      });
    }
    const correlationKey = stringParam(action, "correlationKey");
    const child = await this.startInstance({
      definitionId: childDefinition.id,
      tenantId,
      variables: recordParam(action, "variables"),
      parentInstanceId: instanceId,
      ...(correlationKey !== null ? { correlationKey } : {}),
    });

    const spawnSeq = (await this.eventLog.latestSequence(instanceId))!;
    await this.appendEvent({
      instanceId,
      tenantId,
      sequenceNumber: spawnSeq + 1,
      kind: "child_workflow_spawned",
      occurredAt: this.clock.nowIso(),
      actorPrincipalId: null,
      actorSystemId: this.systemActorId,
      previousState: null,
      newState: null,
      activityId: null,
      signalId: null,
      timerId: null,
      childInstanceId: child.instanceId,
      variableName: null,
      payload: {
        childDefinitionId: childDefinition.id,
        childDefinitionKey: childDefinition.definitionKey,
        childDefinitionVersion: childDefinition.version,
        childStatus: child.status,
      },
      correlationId: correlationKey,
      causationEventId: null,
    });

    if (
      child.status !== "completed" &&
      child.status !== "failed" &&
      child.status !== "cancelled" &&
      child.status !== "compensated"
    ) {
      return;
    }
    const doneSeq = (await this.eventLog.latestSequence(instanceId))!;
    await this.appendEvent({
      instanceId,
      tenantId,
      sequenceNumber: doneSeq + 1,
      kind: "child_workflow_completed",
      occurredAt: this.clock.nowIso(),
      actorPrincipalId: null,
      actorSystemId: this.systemActorId,
      previousState: null,
      newState: null,
      activityId: null,
      signalId: null,
      timerId: null,
      childInstanceId: child.instanceId,
      variableName: null,
      payload: {
        childDefinitionKey: childDefinition.definitionKey,
        childStatus: child.status,
        childState: child.currentState,
      },
      correlationId: correlationKey,
      causationEventId: null,
    });
    const liveState = await this.getInstanceState(instanceId);
    const parentDefinition = this.definitions.get(liveState?.definitionId ?? "");
    if (liveState === null || parentDefinition === undefined) return;
    const transition = evaluateNextTransition({
      definition: parentDefinition,
      fromState: liveState.currentState,
      trigger: {
        kind: "child_workflow_completed",
        childDefinitionKey: childDefinition.definitionKey,
      },
      variables: liveState.variables,
      evaluator: this.guardEvaluator,
    });
    if (transition !== null) {
      await this.applyTransition(instanceId, parentDefinition, transition, liveState, null, null);
    }
  }

  /**
   * Resolves the child definition from `definitionId` (exact) or `definitionKey` — the vocabulary the
   * `child_workflow_completed` trigger matches on. Several published versions of one key resolve to
   * the highest, so a key names one definition deterministically rather than whichever the registry
   * happened to hold first.
   */
  private resolveChildDefinition(instanceId: string, action: StateAction): WorkflowDefinition {
    const definitionId = stringParam(action, "definitionId");
    if (definitionId !== null) {
      const byId = this.definitions.get(definitionId);
      if (byId === undefined) {
        throw new WorkflowActionError({
          actionKind: "spawn_child_workflow",
          failure: "unknown_child_definition",
          instanceId,
          detail: `no workflow definition with id ${definitionId} is registered with this engine`,
        });
      }
      return byId;
    }
    const definitionKey = stringParam(action, "definitionKey");
    if (definitionKey === null) {
      throw new WorkflowActionError({
        actionKind: "spawn_child_workflow",
        failure: "missing_parameter",
        instanceId,
        detail: "parameters must carry definitionKey or definitionId naming the child workflow",
      });
    }
    const published = [...this.definitions.values()].filter(
      (d) => d.definitionKey === definitionKey && d.status === "published",
    );
    published.sort((a, b) => compareDefinitionVersions(b.version, a.version));
    const chosen = published[0];
    if (chosen === undefined) {
      throw new WorkflowActionError({
        actionKind: "spawn_child_workflow",
        failure: "unknown_child_definition",
        instanceId,
        detail: `no published workflow definition with key ${definitionKey} is registered with this engine`,
      });
    }
    return chosen;
  }

  /** How many parents this instance already has above it, following `parentInstanceId` in the log. */
  private async lineageDepth(instanceId: string): Promise<number> {
    const seen = new Set<string>([instanceId]);
    let cursor: string | null = instanceId;
    let depth = 0;
    while (cursor !== null && depth <= MAX_CHILD_WORKFLOW_DEPTH) {
      const state: ProjectedInstance | null = await this.getInstanceState(cursor);
      if (state === null) break;
      cursor = state.parentInstanceId;
      if (cursor === null || seen.has(cursor)) break;
      seen.add(cursor);
      depth += 1;
    }
    return depth;
  }

  /**
   * Delivers a signal from inside a workflow through the engine's own `submitSignal`, so an
   * instance-to-instance signal takes exactly the path an inbound one does — correlation matching,
   * `signal_received` / `signal_consumed`, the receiver's step loop. Delivery reaches the instances
   * this engine knows, which is the same reach `tickTimers` has; crossing a process boundary is the
   * `-runtime-pg` layer's job, not this one's.
   */
  private async applySendSignal(
    instanceId: string,
    tenantId: string,
    action: StateAction,
  ): Promise<void> {
    const signalName = stringParam(action, "signalName");
    if (signalName === null) {
      throw new WorkflowActionError({
        actionKind: "send_signal",
        failure: "missing_parameter",
        instanceId,
        detail: "parameters.signalName must be a non-empty string",
      });
    }
    const correlationKey = await this.resolveSignalCorrelationKey(instanceId, action);
    if (this.signalDispatchDepth >= MAX_SIGNAL_DISPATCH_DEPTH) {
      throw new WorkflowActionError({
        actionKind: "send_signal",
        failure: "signal_depth_exceeded",
        instanceId,
        detail: `signal dispatch is already ${this.signalDispatchDepth.toString()} deep (limit ${MAX_SIGNAL_DISPATCH_DEPTH.toString()}); signal ${signalName} is part of a cycle`,
      });
    }
    // An internal dispatch can carry a key too, and must be able to: a target signal declared
    // `exactly_once_idempotent` is refused without one, so without this parameter a workflow could
    // address every signal in the catalog except the ones with the strongest guarantee. It is read
    // from `parameters` rather than synthesised, because a key the engine invents is either a
    // nonce (which deduplicates nothing) or a function of the send site (which deduplicates two
    // legitimately distinct sends into one).
    const idempotencyKey = stringParam(action, "idempotencyKey");
    this.signalDispatchDepth += 1;
    try {
      await this.submitSignal({
        signalName,
        correlationKey,
        tenantId,
        payload: recordParam(action, "payload"),
        sourceSystem: this.systemActorId,
        ...(idempotencyKey !== null ? { idempotencyKey } : {}),
      });
    } finally {
      this.signalDispatchDepth -= 1;
    }
  }

  /**
   * The correlation key a `send_signal` addresses: a literal `correlationKey`, or the value of the
   * instance variable named by `correlationVariable` — which is how one workflow addresses a sibling
   * it learned about at runtime. An absent or non-scalar variable is refused rather than stringified,
   * since `"undefined"` would correlate to nothing and the send would look delivered.
   */
  private async resolveSignalCorrelationKey(
    instanceId: string,
    action: StateAction,
  ): Promise<string> {
    const literal = stringParam(action, "correlationKey");
    if (literal !== null) return literal;
    const variableName = stringParam(action, "correlationVariable");
    if (variableName === null) {
      throw new WorkflowActionError({
        actionKind: "send_signal",
        failure: "missing_parameter",
        instanceId,
        detail: "parameters must carry correlationKey or correlationVariable",
      });
    }
    const state = await this.getInstanceState(instanceId);
    const value = state?.variables[variableName];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isFinite(value)) return value.toString();
    throw new WorkflowActionError({
      actionKind: "send_signal",
      failure: "unresolved_correlation_key",
      instanceId,
      detail: `variable ${variableName} holds no usable correlation key (expected a non-empty string or a finite number)`,
    });
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
    // Driver fence 4a of 4. The single choke point through which every activity attempt passes —
    // the first one and every retry — so a cancelled instance neither records a new scheduled
    // activity nor leaves one claimable by a worker in another process.
    const fenceState = await this.getInstanceState(instanceId);
    if (fenceState !== null && isInstanceCancellationRequested(fenceState)) return;

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

  /** Registers a running handler's abort channel, so a cancellation can tell it. */
  private registerInFlight(
    instanceId: string,
    activityId: string,
    controller: AbortController,
  ): void {
    const existing = this.inFlightActivities.get(instanceId);
    if (existing === undefined) {
      this.inFlightActivities.set(instanceId, new Map([[activityId, controller]]));
      return;
    }
    existing.set(activityId, controller);
  }

  private clearInFlight(instanceId: string, activityId: string): void {
    const byActivity = this.inFlightActivities.get(instanceId);
    if (byActivity === undefined) return;
    byActivity.delete(activityId);
    if (byActivity.size === 0) this.inFlightActivities.delete(instanceId);
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
  ): Promise<boolean> {
    const handler =
      this.registry.resolve({
        kind: kind as never,
        definitionId: definition.id,
        activityKey,
      }) ?? unsupportedHandler;
    const state = await this.getInstanceState(instanceId);
    // Driver fence 4b of 4. 4a stops a *new* attempt being recorded; this stops an attempt already
    // sitting `scheduled` in the log from being entered, which is the case a distributed worker
    // reaches through `executeScheduledActivity` — the one path that does not come via 4a.
    if (state !== null && isInstanceCancellationRequested(state)) return false;
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
    const controller = new AbortController();
    this.registerInFlight(instanceId, activityId, controller);
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
        signal: controller.signal,
      });
    } catch (err) {
      outcome = {
        status: "failed" as const,
        errorCode: "HANDLER_EXCEPTION",
        errorMessage: err instanceof Error ? err.message : String(err),
        retryable: false,
      };
    } finally {
      // Deregistered the moment the handler settles, so no cancellation ever aborts a controller
      // whose work is already over — the same rule as `abortWhile`'s watcher not outliving its task.
      this.clearInFlight(instanceId, activityId);
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
      // A handler that ignored its signal is allowed to *report* — the outcome above is a fact and
      // ADR-0315 says so out loud. It is not allowed to *move* the instance: applying its trigger
      // would run the next state's on-entry actions, which is new work starting after a
      // cancellation. The projection's seal keeps the status right; this keeps the log right.
      if (liveState !== null && !isInstanceCancellationRequested(liveState)) {
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
        if (liveState !== null && !isInstanceCancellationRequested(liveState)) {
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
    return true;
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
    const handlerRan = await this.runActivityHandler(
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
    // `executed` has to mean the handler ran. A cancellation refuses it at fence 4b, and reporting
    // `true` there would tell a worker its claim was honoured when nothing was invoked.
    if (!handlerRan) return { executed: false };
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
          // A compensating handler is never registered as in-flight and gets a signal that cannot
          // trip: it is the *undo*, so the cancellation that asked for it must not then abort it.
          signal: new AbortController().signal,
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

  /**
   * Arms a declared timer **at the instant its own kind says**, which is what this did not do.
   *
   * It used to read `parameters.relativeSeconds` (defaulting to 60) and ignore the declared `kind`
   * entirely, so a definition declaring `cron_schedule`, `absolute_at` or `business_hours` got a
   * fire-once timer at `now + 60s` — while `timer-provenance.ts` wrote the **declared** kind into
   * `meta.workflow_timers`. The row said `cron_schedule` and the behaviour was `relative_after`,
   * which is the sharpest shape of this family's defect: the record is right, the behaviour is
   * wrong, and so nothing disagrees with anything.
   *
   * The declaration is the only input. An undeclared timer name is a named refusal rather than the
   * old `"timer"` fallback — which armed a timer no transition could ever be triggered by, because
   * `evaluateNextTransition` matches a `timer_fired` trigger by name. `WorkflowDefinitionSchema`
   * refuses both at publication now; this is the second fence, for a definition stored before it.
   */
  private async applyScheduleTimer(
    instanceId: string,
    definition: WorkflowDefinition,
    tenantId: string,
    action: StateAction,
  ): Promise<void> {
    const timerName = stringParam(action, "timerName");
    if (timerName === null) {
      throw new WorkflowActionError({
        actionKind: "schedule_timer",
        failure: "missing_parameter",
        instanceId,
        detail: "parameters.timerName must be a non-empty string naming a declared timer",
      });
    }
    const declared = definition.timers.find((t) => t.name === timerName);
    if (declared === undefined) {
      throw new WorkflowActionError({
        actionKind: "schedule_timer",
        failure: "undeclared_timer",
        instanceId,
        detail:
          `definition ${definition.id} declares no timer named ${JSON.stringify(timerName)} ` +
          `(declared: ${definition.timers.map((t) => t.name).join(", ") || "none"})`,
      });
    }
    // `absolute_at` reads its instant out of an instance variable, so the projection is an input to
    // scheduling — log-driven like every other read here, so this works for an instance this engine
    // never started. The extra read is taken only for the kinds that need it, decided by reading
    // `TIMER_KIND_SCHEDULING` rather than by naming the kind here: a fifth kind that reads a
    // variable would otherwise get an empty variable bag and refuse `absolute_variable_unset`.
    const needsVariables = TIMER_KIND_SCHEDULING[declared.kind].reads.includes(
      "absoluteTimestampVariable",
    );
    const projected = needsVariables ? await this.getInstanceState(instanceId) : null;
    const resolution = resolveTimerFireAt(declared, {
      now: this.clock.now(),
      variables: projected?.variables ?? {},
    });
    if (!resolution.ok) {
      throw new WorkflowActionError({
        actionKind: "schedule_timer",
        failure: "unschedulable_timer",
        instanceId,
        detail: `timer ${timerName} (${declared.kind}): ${resolution.defect} — ${resolution.detail}`,
      });
    }
    const fireAt = resolution.fireAt;
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
      // `timerKind` rides along so the log alone says what schedule this arming came from. Nothing
      // reads it back for scheduling (the definition is the authority and is immutable once
      // published), but a `timer_scheduled` that does not name its kind cannot be told from one
      // written by the engine that scheduled everything as `relative_after`.
      payload: { timerName, fireAt, timerKind: declared.kind },
      correlationId: null,
      causationEventId: null,
    });
  }

  /**
   * The instant a recurring timer next fires after this one, or `null` when the kind fires once.
   *
   * `null` is the contract rather than a gap: `WorkflowTimerSchema` requires `nextFireAt` to be null
   * for every kind but `cron_schedule`. A *recurring* timer whose next occurrence cannot be computed
   * throws instead, because a `fired` cron row with no next occurrence is a recurring timer that has
   * silently stopped recurring — the row `timer-provenance.ts` refuses to store.
   */
  private nextOccurrenceFor(
    instanceId: string,
    declared: TimerDefinition,
    firedAtMs: number,
  ): string | null {
    const resolution = resolveNextTimerFireAt(declared, { after: new Date(firedAtMs) });
    if (resolution === null) return null;
    if (!resolution.ok) {
      throw new WorkflowActionError({
        actionKind: "schedule_timer",
        failure: "unschedulable_timer",
        instanceId,
        detail:
          `timer ${declared.name} (${declared.kind}) fired but its next occurrence could not be ` +
          `computed: ${resolution.defect} — ${resolution.detail}`,
      });
    }
    return resolution.fireAt;
  }

  /**
   * Arms a recurring timer's next occurrence on the **same timer id**.
   *
   * One row per schedule, moving — not one row per occurrence — because that is what the contract
   * already models: `projectTimers` *counts* fires rather than setting a flag, `WorkflowTimerSchema`
   * caps `fireCount` at a million for `cron_schedule` and at one for every other kind, and
   * `meta.workflow_timers` carries `fire_count` and `next_fire_at` on one row.
   *
   * It must be appended **after** the `timer_fired` it follows: `outstandingTimersFromLog` drops a
   * timer id on `timer_fired` and re-admits it on a later `timer_scheduled`, so the other order
   * would arm the next occurrence and then immediately cancel it out.
   */
  private async appendTimerRearm(
    instanceId: string,
    tenantId: string,
    declared: TimerDefinition,
    timerId: string,
    firedAtMs: number,
    nextFireAt: string,
  ): Promise<void> {
    const nextSeq = (await this.eventLog.latestSequence(instanceId))!;
    await this.appendEvent({
      instanceId,
      tenantId,
      sequenceNumber: nextSeq + 1,
      kind: "timer_scheduled",
      occurredAt: new Date(firedAtMs).toISOString(),
      actorPrincipalId: null,
      actorSystemId: this.systemActorId,
      previousState: null,
      newState: null,
      activityId: null,
      signalId: null,
      timerId,
      childInstanceId: null,
      variableName: null,
      payload: {
        timerName: declared.name,
        fireAt: nextFireAt,
        timerKind: declared.kind,
        rearm: true,
      },
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
