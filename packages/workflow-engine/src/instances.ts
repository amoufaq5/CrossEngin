import { z } from "zod";

import { type CompensationStrategy } from "./definitions.js";

export const INSTANCE_STATUSES = [
  "created",
  "running",
  "waiting_for_signal",
  "waiting_for_timer",
  "waiting_for_activity",
  "waiting_for_manual",
  "suspended",
  "completed",
  "failed",
  "cancelled",
  "compensating",
  "compensated",
] as const;
export type InstanceStatus = (typeof INSTANCE_STATUSES)[number];

export const ACTIVE_INSTANCE_STATUSES: ReadonlySet<InstanceStatus> = new Set([
  "running",
  "waiting_for_signal",
  "waiting_for_timer",
  "waiting_for_activity",
  "waiting_for_manual",
  "compensating",
]);

/**
 * Statuses the clock no longer advances — what `isInstanceTimedOut` asks about. `failed` belongs here
 * even though it has an outgoing transition, because a failed instance must not also time out.
 *
 * This is **not** "no way out": see `CLOSED_INSTANCE_STATUSES` for that question. The two differ by
 * exactly `failed`, whose `failed → compensating` edge is a saga compensating a failure, triggered
 * deliberately rather than by the passage of time.
 */
export const TERMINAL_INSTANCE_STATUSES: ReadonlySet<InstanceStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "compensated",
]);

export const INSTANCE_TRANSITIONS: Readonly<
  Record<InstanceStatus, readonly InstanceStatus[]>
> = {
  created: ["running", "cancelled"],
  running: [
    "waiting_for_signal",
    "waiting_for_timer",
    "waiting_for_activity",
    "waiting_for_manual",
    "suspended",
    "completed",
    "failed",
    "cancelled",
    "compensating",
  ],
  waiting_for_signal: ["running", "suspended", "cancelled", "failed"],
  waiting_for_timer: ["running", "suspended", "cancelled", "failed"],
  waiting_for_activity: ["running", "suspended", "cancelled", "failed"],
  waiting_for_manual: ["running", "suspended", "cancelled", "failed"],
  suspended: ["running", "cancelled"],
  compensating: ["compensated", "failed"],
  completed: [],
  failed: ["compensating"],
  cancelled: [],
  compensated: [],
};

export const canTransitionInstance = (
  from: InstanceStatus,
  to: InstanceStatus,
): boolean => INSTANCE_TRANSITIONS[from].includes(to);

export const RELATED_ENTITY_KINDS = [
  "purchase_request",
  "invoice",
  "patient_admission",
  "permit_application",
  "license_request",
  "claim",
  "ticket",
  "contract",
  "deployment",
  "tenant_signup",
  "user_offboarding",
  "ml_training_run",
  "access_review_campaign",
  "incident",
  "custom",
] as const;
export type RelatedEntityKind = (typeof RELATED_ENTITY_KINDS)[number];

export const RelatedEntityRefSchema = z
  .object({
    kind: z.enum(RELATED_ENTITY_KINDS),
    id: z.string().min(1).max(200),
    customKindName: z.string().max(120).nullable(),
  })
  .superRefine((r, ctx) => {
    if (r.kind === "custom" && r.customKindName === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customKindName"],
        message: "custom kind requires customKindName",
      });
    }
  });
export type RelatedEntityRef = z.infer<typeof RelatedEntityRefSchema>;

export const WorkflowInstanceSchema = z
  .object({
    id: z.string().regex(/^wfi_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid(),
    definitionId: z.string().regex(/^wfd_[a-z0-9]{8,32}$/),
    definitionKey: z.string().regex(/^[a-z][a-z0-9_.-]*$/).max(120),
    definitionVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    status: z.enum(INSTANCE_STATUSES),
    currentState: z.string().regex(/^[a-z][a-z0-9_]*$/).max(80),
    variables: z.record(z.string(), z.unknown()).default({}),
    relatedEntity: RelatedEntityRefSchema.nullable(),
    correlationKey: z.string().max(200).nullable(),
    parentInstanceId: z.string().regex(/^wfi_[a-z0-9]{8,40}$/).nullable(),
    startedAt: z.string().datetime({ offset: true }),
    startedByUserId: z.string().uuid().nullable(),
    startedBySystem: z.string().max(120).nullable(),
    lastTransitionAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    cancelledAt: z.string().datetime({ offset: true }).nullable(),
    cancelledByUserId: z.string().uuid().nullable(),
    cancelledReason: z.string().max(500).nullable(),
    failedAt: z.string().datetime({ offset: true }).nullable(),
    failureCode: z.string().max(80).nullable(),
    failureMessage: z.string().max(2000).nullable(),
    suspendedAt: z.string().datetime({ offset: true }).nullable(),
    suspendedReason: z.string().max(500).nullable(),
    compensationStartedAt: z.string().datetime({ offset: true }).nullable(),
    compensationCompletedAt: z.string().datetime({ offset: true }).nullable(),
    timeoutAt: z.string().datetime({ offset: true }),
    sequenceCursor: z.number().int().min(0),
    awaitingActivityIds: z.array(z.string()).default([]),
    awaitingSignalNames: z.array(z.string()).default([]),
    awaitingTimerNames: z.array(z.string()).default([]),
  })
  .superRefine((i, ctx) => {
    const startedAt = Date.parse(i.startedAt);
    const lastTransitionAt = Date.parse(i.lastTransitionAt);
    if (lastTransitionAt < startedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastTransitionAt"],
        message: "lastTransitionAt cannot precede startedAt",
      });
    }
    const timeoutAt = Date.parse(i.timeoutAt);
    if (timeoutAt <= startedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timeoutAt"],
        message: "timeoutAt must be after startedAt",
      });
    }
    if (i.status === "completed" && i.completedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "completed instance requires completedAt",
      });
    }
    if (i.status === "cancelled") {
      if (i.cancelledAt === null || i.cancelledReason === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cancelledAt"],
          message: "cancelled instance requires cancelledAt + cancelledReason",
        });
      }
    }
    if (i.status === "failed") {
      if (
        i.failedAt === null ||
        i.failureCode === null ||
        i.failureMessage === null
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["failureCode"],
          message:
            "failed instance requires failedAt + failureCode + failureMessage",
        });
      }
    }
    if (i.status === "suspended") {
      if (i.suspendedAt === null || i.suspendedReason === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["suspendedAt"],
          message: "suspended instance requires suspendedAt + suspendedReason",
        });
      }
    }
    if (i.status === "compensating" && i.compensationStartedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["compensationStartedAt"],
        message: "compensating instance requires compensationStartedAt",
      });
    }
    if (i.status === "compensated") {
      if (
        i.compensationStartedAt === null ||
        i.compensationCompletedAt === null
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["compensationCompletedAt"],
          message:
            "compensated instance requires compensationStartedAt + compensationCompletedAt",
        });
      }
    }
    if (
      i.status === "waiting_for_signal" &&
      i.awaitingSignalNames.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["awaitingSignalNames"],
        message: "waiting_for_signal instance must have ≥ 1 awaitingSignalNames",
      });
    }
    if (
      i.status === "waiting_for_timer" &&
      i.awaitingTimerNames.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["awaitingTimerNames"],
        message: "waiting_for_timer instance must have ≥ 1 awaitingTimerNames",
      });
    }
    if (
      i.status === "waiting_for_activity" &&
      i.awaitingActivityIds.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["awaitingActivityIds"],
        message:
          "waiting_for_activity instance must have ≥ 1 awaitingActivityIds",
      });
    }
    if (i.startedByUserId === null && i.startedBySystem === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["startedByUserId"],
        message: "either startedByUserId or startedBySystem must be set",
      });
    }
  });
export type WorkflowInstance = z.infer<typeof WorkflowInstanceSchema>;

export const isInstanceActive = (instance: WorkflowInstance): boolean =>
  ACTIVE_INSTANCE_STATUSES.has(instance.status);

export const isInstanceTerminal = (instance: WorkflowInstance): boolean =>
  TERMINAL_INSTANCE_STATUSES.has(instance.status);

/**
 * Statuses with no outgoing transition at all — genuinely nowhere left to go.
 *
 * **Derived from `INSTANCE_TRANSITIONS`, never hand-listed.** A second hand-maintained set is how
 * `TERMINAL_INSTANCE_STATUSES` came to disagree with the map in the first place: it claims `failed` is
 * an end state while the map gives it `failed → compensating`, so a reader asking "can this still
 * move?" and reaching for `isInstanceTerminal` got the wrong answer. Computing it means the two cannot
 * drift apart again.
 */
export const CLOSED_INSTANCE_STATUSES: ReadonlySet<InstanceStatus> = new Set(
  INSTANCE_STATUSES.filter((status) => INSTANCE_TRANSITIONS[status].length === 0),
);

/** Whether the state machine offers this instance any transition at all. */
export const isInstanceClosed = (instance: WorkflowInstance): boolean =>
  CLOSED_INSTANCE_STATUSES.has(instance.status);

export const isInstanceTimedOut = (
  instance: WorkflowInstance,
  now: Date,
): boolean => {
  if (isInstanceTerminal(instance)) return false;
  return now.getTime() >= Date.parse(instance.timeoutAt);
};

export const elapsedSinceLastTransitionSeconds = (
  instance: WorkflowInstance,
  now: Date,
): number =>
  Math.max(
    0,
    Math.floor(
      (now.getTime() - Date.parse(instance.lastTransitionAt)) / 1000,
    ),
  );

/**
 * What a workflow-instance cancellation promises, per kind of outstanding work.
 *
 * ADR-0315 bounded the *job* promise to "no further work will be **started**", because an arbitrary
 * handler cannot be preempted. An instance is a harder case: it owns several kinds of pending work
 * at once, and they do not all admit the same promise. Stating one sentence for all of them would
 * either over-promise (a running handler cannot be stopped) or under-promise (an unfired timer can
 * be dropped with complete certainty). So the promise is a **map**, and the strength is the value.
 */
export const INSTANCE_CANCELLATION_WORK_KINDS = [
  "unfired_timer",
  "scheduled_activity",
  "in_flight_activity",
  "automatic_transition",
  "inbound_signal",
  "child_instance",
] as const;
export type InstanceCancellationWorkKind =
  (typeof INSTANCE_CANCELLATION_WORK_KINDS)[number];

export const INSTANCE_CANCELLATION_STRENGTHS = [
  "dropped",
  "never_started",
  "signalled",
  "not_cascaded",
] as const;
export type InstanceCancellationStrength =
  (typeof INSTANCE_CANCELLATION_STRENGTHS)[number];

export const INSTANCE_CANCELLATION_GUARANTEES: Readonly<
  Record<InstanceCancellationStrength, string>
> = {
  dropped:
    "the engine owned it and removed it; a terminal event for it is in the log and it can never fire",
  never_started:
    "the engine owned the decision to begin it and will not; nothing ran, so there is nothing to undo",
  signalled:
    "it was already running and cannot be preempted; it is told via an AbortSignal, and one that ignores the signal still lands cancelled rather than succeeded",
  not_cascaded:
    "out of scope: a separate instance with its own id, its own side effects and its own compensation choice — cancel it by its own id",
};

/**
 * The promise, as data. Total over `INSTANCE_CANCELLATION_WORK_KINDS` so a work kind cannot be
 * added without an answer for it — the ADR-0317 rule, that a subsystem's silence must not read as
 * nothing to do.
 *
 * `child_instance` is `not_cascaded` on purpose, and it is the entry that most wants arguing with.
 * Cascading would mean choosing a *disposition* for an instance the caller did not name, and the
 * whole point of `InstanceCancellationDisposition` is that nobody but the caller may choose it.
 */
export const INSTANCE_CANCELLATION_EFFECTS: Readonly<
  Record<InstanceCancellationWorkKind, InstanceCancellationStrength>
> = {
  unfired_timer: "dropped",
  scheduled_activity: "never_started",
  in_flight_activity: "signalled",
  automatic_transition: "never_started",
  inbound_signal: "dropped",
  child_instance: "not_cascaded",
};

/**
 * Where an activity stood when the cancellation reached it. Deliberately ADR-0315's own two
 * checkpoint names, so a reader who knows the job contract reads this one for free — and because
 * the distinction is identical: before the handler was entered the engine's refusal is total, and
 * after it the engine can only ask.
 */
export const ACTIVITY_CANCELLATION_CHECKPOINTS = [
  "before_handler",
  "cooperative_abort",
] as const;
export type ActivityCancellationCheckpoint =
  (typeof ACTIVITY_CANCELLATION_CHECKPOINTS)[number];

/**
 * Whether cancelling this instance also *rolls it back*.
 *
 * Both are offered because neither is right for every instance: an instance that has posted to the
 * general ledger and shipped nothing wants its postings reversed, and an instance that has barely
 * left its initial state wants nothing of the sort — making "cancel" mean "roll back" there would
 * run compensating handlers over side effects that never happened.
 *
 * The choice is on the **request**, with no schema default, because a default here decides whether a
 * half-written order is reversed. ADR-0328's rule: a `z.default()` is applied to silence, and
 * silence is exactly what must not choose this.
 */
export const INSTANCE_CANCELLATION_DISPOSITIONS = ["compensate", "abandon"] as const;
export type InstanceCancellationDisposition =
  (typeof INSTANCE_CANCELLATION_DISPOSITIONS)[number];

/** What actually became of the rollback, recorded on the finalizing event. */
export const INSTANCE_CANCELLATION_COMPENSATION_OUTCOMES = [
  "executed",
  "skipped_by_request",
  "deferred_to_human",
  "unavailable",
] as const;
export type InstanceCancellationCompensationOutcome =
  (typeof INSTANCE_CANCELLATION_COMPENSATION_OUTCOMES)[number];

export const INSTANCE_CANCELLATION_OUTCOMES = [
  "cancelled",
  "already_requested",
  "refused_terminal",
  "refused_not_cancellable",
  "unknown_instance",
] as const;
export type InstanceCancellationOutcome =
  (typeof INSTANCE_CANCELLATION_OUTCOMES)[number];

export const InstanceCancellationRequestSchema = z
  .object({
    instanceId: z.string().regex(/^wfi_[a-z0-9]{8,40}$/),
    disposition: z.enum(INSTANCE_CANCELLATION_DISPOSITIONS),
    // `WorkflowInstanceSchema` requires `cancelledReason` of a cancelled instance, so a cancellation
    // with no reason could only produce a record its own schema rejects.
    reason: z.string().min(1).max(500),
    requestedByUserId: z.string().uuid().nullable().default(null),
    requestedBySystem: z.string().max(120).nullable().default(null),
  })
  .superRefine((r, ctx) => {
    if (r.requestedByUserId === null && r.requestedBySystem === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requestedByUserId"],
        message:
          "either requestedByUserId or requestedBySystem must be set (mirroring how an instance records who started it)",
      });
    }
  });
/** A parsed request: both actor fields are present, one of them non-null. */
export type InstanceCancellationRequest = z.infer<
  typeof InstanceCancellationRequestSchema
>;

/**
 * What a *caller* supplies. Distinct from `InstanceCancellationRequest` because `.default(null)`
 * makes the two actor fields required on the parsed side while either may be omitted on the way in —
 * so an entry point that takes the parsed type would demand `requestedBySystem: null` of every
 * caller who named a user. `disposition` is required in both, which is the point.
 */
export type InstanceCancellationRequestInput = z.input<
  typeof InstanceCancellationRequestSchema
>;

/** The outstanding work a cancellation has to answer for, as derived from an instance's log. */
export interface InstanceCancellationWorkSurvey {
  /** Timers scheduled and neither fired nor cancelled. */
  readonly outstandingTimerIds: readonly string[];
  /** Activities recorded `activity_scheduled` whose handler was never entered. */
  readonly scheduledActivityIds: readonly string[];
  /** Activities recorded `activity_started` with no outcome yet. */
  readonly inFlightActivityIds: readonly string[];
  /**
   * Completed side-effect activities that carry a compensating handler key and have not been
   * compensated — strategy-independent, so a `no_compensation` definition still *reports* what it
   * cannot undo instead of reporting nothing.
   */
  readonly compensatableActivityIds: readonly string[];
}

export interface InstanceCancellationPlan {
  readonly outcome: InstanceCancellationOutcome;
  readonly dropTimerIds: readonly string[];
  /** Scheduled-but-unentered activities, cancelled at `before_handler`. */
  readonly cancelBeforeHandlerActivityIds: readonly string[];
  /** In-flight activities, cancelled at `cooperative_abort` — told, not stopped. */
  readonly signalActivityIds: readonly string[];
  readonly compensationOutcome: InstanceCancellationCompensationOutcome;
  /** Activities whose compensating handler the plan will run (empty unless `executed`). */
  readonly compensateActivityIds: readonly string[];
  /**
   * Compensatable side effects this cancellation leaves standing. Non-empty for every
   * `compensationOutcome` but `executed`, and recorded on the finalizing event — an abandonment
   * that silently left real side effects behind is ADR-0317's defect in another costume.
   */
  readonly unreversedActivityIds: readonly string[];
}

const EMPTY_PLAN = {
  dropTimerIds: [],
  cancelBeforeHandlerActivityIds: [],
  signalActivityIds: [],
  compensationOutcome: "skipped_by_request",
  compensateActivityIds: [],
  unreversedActivityIds: [],
} as const;

/**
 * Decides what one cancellation request does, from the instance's status and its outstanding work.
 * Pure, and the only place the refusals live.
 *
 * **The authority for "may this be cancelled?" is `INSTANCE_TRANSITIONS`, not either terminal set.**
 * ADR-0307 pinned that `failed` is in `TERMINAL_INSTANCE_STATUSES` while the map gives it
 * `failed → compensating`, so neither "is terminal" nor "is closed" answers this question: the map
 * does, and its answer for `failed` is *no — compensate it instead*, which is the right answer and
 * the one a hand-listed guard would have got wrong. `compensating` is refused for the same reason
 * from the other direction: interrupting a rollback in progress is worse than not cancelling.
 */
export function planInstanceCancellation(input: {
  readonly status: InstanceStatus | null;
  readonly cancellationAlreadyRequested: boolean;
  readonly disposition: InstanceCancellationDisposition;
  readonly strategy: CompensationStrategy;
  readonly work: InstanceCancellationWorkSurvey;
}): InstanceCancellationPlan {
  if (input.status === null) {
    return { ...EMPTY_PLAN, outcome: "unknown_instance" };
  }
  // Checked before the refusals: `cancelled` is also closed, and reporting a second request as
  // `refused_terminal` would call an idempotent repeat a failure.
  if (input.cancellationAlreadyRequested || input.status === "cancelled") {
    return { ...EMPTY_PLAN, outcome: "already_requested" };
  }
  if (CLOSED_INSTANCE_STATUSES.has(input.status)) {
    return { ...EMPTY_PLAN, outcome: "refused_terminal" };
  }
  if (!canTransitionInstance(input.status, "cancelled")) {
    return { ...EMPTY_PLAN, outcome: "refused_not_cancellable" };
  }

  const compensatable = input.work.compensatableActivityIds;
  const compensationOutcome: InstanceCancellationCompensationOutcome =
    input.disposition === "abandon"
      ? "skipped_by_request"
      : input.strategy === "manual_review"
        ? "deferred_to_human"
        : input.strategy === "no_compensation"
          ? "unavailable"
          : "executed";

  return {
    outcome: "cancelled",
    dropTimerIds: input.work.outstandingTimerIds,
    cancelBeforeHandlerActivityIds: input.work.scheduledActivityIds,
    signalActivityIds: input.work.inFlightActivityIds,
    compensationOutcome,
    compensateActivityIds: compensationOutcome === "executed" ? compensatable : [],
    unreversedActivityIds: compensationOutcome === "executed" ? [] : compensatable,
  };
}

export const transitionInstance = (
  instance: WorkflowInstance,
  toStatus: InstanceStatus,
  toState: string,
  now: Date,
): WorkflowInstance => {
  if (!canTransitionInstance(instance.status, toStatus)) {
    throw new Error(
      `cannot transition instance from ${instance.status} to ${toStatus}`,
    );
  }
  return {
    ...instance,
    status: toStatus,
    currentState: toState,
    lastTransitionAt: now.toISOString(),
    sequenceCursor: instance.sequenceCursor + 1,
  };
};
