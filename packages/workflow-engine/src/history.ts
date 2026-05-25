import { z } from "zod";

export const EVENT_KINDS = [
  "instance_started",
  "instance_completed",
  "instance_failed",
  "instance_cancelled",
  "instance_suspended",
  "instance_resumed",
  "state_transitioned",
  "activity_scheduled",
  "activity_started",
  "activity_completed",
  "activity_failed",
  "activity_timed_out",
  "activity_compensated",
  "signal_received",
  "signal_consumed",
  "timer_scheduled",
  "timer_fired",
  "timer_cancelled",
  "variable_updated",
  "compensation_started",
  "compensation_step_completed",
  "compensation_completed",
  "manual_action_taken",
  "child_workflow_spawned",
  "child_workflow_completed",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const STATE_CHANGING_EVENTS: ReadonlySet<EventKind> = new Set([
  "instance_started",
  "instance_completed",
  "instance_failed",
  "instance_cancelled",
  "state_transitioned",
  "compensation_started",
  "compensation_completed",
]);

export const ACTIVITY_EVENTS: ReadonlySet<EventKind> = new Set([
  "activity_scheduled",
  "activity_started",
  "activity_completed",
  "activity_failed",
  "activity_timed_out",
  "activity_compensated",
]);

export const SIGNAL_EVENTS: ReadonlySet<EventKind> = new Set([
  "signal_received",
  "signal_consumed",
]);

export const TIMER_EVENTS: ReadonlySet<EventKind> = new Set([
  "timer_scheduled",
  "timer_fired",
  "timer_cancelled",
]);

export const WorkflowEventSchema = z
  .object({
    id: z.string().regex(/^wfe_[a-z0-9]{8,40}$/),
    instanceId: z.string().regex(/^wfi_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid(),
    sequenceNumber: z.number().int().min(0).max(1_000_000_000),
    kind: z.enum(EVENT_KINDS),
    occurredAt: z.string().datetime({ offset: true }),
    actorPrincipalId: z.string().uuid().nullable(),
    actorSystemId: z.string().max(120).nullable(),
    previousState: z.string().max(80).nullable(),
    newState: z.string().max(80).nullable(),
    activityId: z
      .string()
      .regex(/^wfa_[a-z0-9]{8,40}$/)
      .nullable(),
    signalId: z
      .string()
      .regex(/^wfs_[a-z0-9]{8,40}$/)
      .nullable(),
    timerId: z
      .string()
      .regex(/^wft_[a-z0-9]{8,40}$/)
      .nullable(),
    childInstanceId: z
      .string()
      .regex(/^wfi_[a-z0-9]{8,40}$/)
      .nullable(),
    variableName: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(80)
      .nullable(),
    payload: z.record(z.string(), z.unknown()).default({}),
    correlationId: z.string().max(200).nullable(),
    causationEventId: z
      .string()
      .regex(/^wfe_[a-z0-9]{8,40}$/)
      .nullable(),
  })
  .superRefine((e, ctx) => {
    if (e.kind === "state_transitioned") {
      if (e.previousState === null || e.newState === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["newState"],
          message: "state_transitioned event requires previousState + newState",
        });
      }
      if (e.previousState === e.newState) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["newState"],
          message: "state_transitioned event must change state",
        });
      }
    }
    if (ACTIVITY_EVENTS.has(e.kind) && e.activityId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activityId"],
        message: `${e.kind} event requires activityId`,
      });
    }
    if (SIGNAL_EVENTS.has(e.kind) && e.signalId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["signalId"],
        message: `${e.kind} event requires signalId`,
      });
    }
    if (TIMER_EVENTS.has(e.kind) && e.timerId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timerId"],
        message: `${e.kind} event requires timerId`,
      });
    }
    if (e.kind === "variable_updated" && e.variableName === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["variableName"],
        message: "variable_updated event requires variableName",
      });
    }
    if (
      (e.kind === "child_workflow_spawned" || e.kind === "child_workflow_completed") &&
      e.childInstanceId === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["childInstanceId"],
        message: `${e.kind} event requires childInstanceId`,
      });
    }
    if (e.kind === "manual_action_taken" && e.actorPrincipalId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actorPrincipalId"],
        message: "manual_action_taken event requires actorPrincipalId",
      });
    }
    if (
      e.actorPrincipalId === null &&
      e.actorSystemId === null &&
      e.kind !== "timer_fired" &&
      e.kind !== "activity_timed_out"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actorPrincipalId"],
        message:
          "either actorPrincipalId or actorSystemId must be set (except for system-firing events)",
      });
    }
  });
export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;

export interface InstanceHistorySummary {
  readonly totalEvents: number;
  readonly stateTransitionCount: number;
  readonly activityCount: number;
  readonly signalCount: number;
  readonly timerCount: number;
  readonly compensationEventCount: number;
  readonly firstEventAt: string | null;
  readonly lastEventAt: string | null;
  readonly durationSeconds: number;
}

export const summarizeInstanceHistory = (
  events: readonly WorkflowEvent[],
): InstanceHistorySummary => {
  if (events.length === 0) {
    return {
      totalEvents: 0,
      stateTransitionCount: 0,
      activityCount: 0,
      signalCount: 0,
      timerCount: 0,
      compensationEventCount: 0,
      firstEventAt: null,
      lastEventAt: null,
      durationSeconds: 0,
    };
  }
  let firstMs = Infinity;
  let lastMs = -Infinity;
  let firstAt = events[0]?.occurredAt ?? null;
  let lastAt = events[0]?.occurredAt ?? null;
  let stateTransitionCount = 0;
  let activityCount = 0;
  let signalCount = 0;
  let timerCount = 0;
  let compensationEventCount = 0;
  for (const e of events) {
    const t = Date.parse(e.occurredAt);
    if (t < firstMs) {
      firstMs = t;
      firstAt = e.occurredAt;
    }
    if (t > lastMs) {
      lastMs = t;
      lastAt = e.occurredAt;
    }
    if (e.kind === "state_transitioned") stateTransitionCount++;
    if (ACTIVITY_EVENTS.has(e.kind)) activityCount++;
    if (SIGNAL_EVENTS.has(e.kind)) signalCount++;
    if (TIMER_EVENTS.has(e.kind)) timerCount++;
    if (
      e.kind === "compensation_started" ||
      e.kind === "compensation_step_completed" ||
      e.kind === "compensation_completed" ||
      e.kind === "activity_compensated"
    ) {
      compensationEventCount++;
    }
  }
  return {
    totalEvents: events.length,
    stateTransitionCount,
    activityCount,
    signalCount,
    timerCount,
    compensationEventCount,
    firstEventAt: firstAt,
    lastEventAt: lastAt,
    durationSeconds: Math.max(0, Math.floor((lastMs - firstMs) / 1000)),
  };
};

export const isHistoryDense = (events: readonly WorkflowEvent[]): boolean => {
  if (events.length === 0) return true;
  const sorted = [...events].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i]?.sequenceNumber !== i) return false;
  }
  return true;
};

export const reconstructStateTimeline = (
  events: readonly WorkflowEvent[],
): readonly { readonly state: string; readonly enteredAt: string }[] => {
  const sorted = [...events].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const timeline: { state: string; enteredAt: string }[] = [];
  for (const e of sorted) {
    if (e.kind === "instance_started" && e.newState !== null) {
      timeline.push({ state: e.newState, enteredAt: e.occurredAt });
    }
    if (e.kind === "state_transitioned" && e.newState !== null) {
      timeline.push({ state: e.newState, enteredAt: e.occurredAt });
    }
  }
  return timeline;
};
