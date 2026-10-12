import { z } from "zod";

export const TIMER_KINDS = [
  "absolute_at",
  "relative_after",
  "cron_schedule",
  "business_hours",
] as const;
export type TimerKind = (typeof TIMER_KINDS)[number];

export const TIMER_STATUSES = [
  "scheduled",
  "fired",
  "cancelled",
  "expired_before_fire",
] as const;
export type TimerStatus = (typeof TIMER_STATUSES)[number];

export const TIMER_TRANSITIONS: Readonly<
  Record<TimerStatus, readonly TimerStatus[]>
> = {
  scheduled: ["fired", "cancelled", "expired_before_fire"],
  fired: [],
  cancelled: [],
  expired_before_fire: [],
};

export const canTransitionTimer = (
  from: TimerStatus,
  to: TimerStatus,
): boolean => TIMER_TRANSITIONS[from].includes(to);

export const WorkflowTimerSchema = z
  .object({
    id: z.string().regex(/^wft_[a-z0-9]{8,40}$/),
    instanceId: z.string().regex(/^wfi_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid(),
    timerName: z.string().regex(/^[a-z][a-z0-9_]*$/).max(80),
    kind: z.enum(TIMER_KINDS),
    status: z.enum(TIMER_STATUSES),
    scheduledAt: z.string().datetime({ offset: true }),
    fireAt: z.string().datetime({ offset: true }),
    timezone: z.string().min(1).max(80).default("UTC"),
    cronExpression: z.string().max(120).nullable(),
    relativeSeconds: z.number().int().min(1).max(31_536_000).nullable(),
    firedAt: z.string().datetime({ offset: true }).nullable(),
    cancelledAt: z.string().datetime({ offset: true }).nullable(),
    cancelledReason: z.string().max(500).nullable(),
    expiredAt: z.string().datetime({ offset: true }).nullable(),
    transitionToTrigger: z.string().max(120).nullable(),
    fireCount: z.number().int().min(0).max(1_000_000),
    nextFireAt: z.string().datetime({ offset: true }).nullable(),
  })
  .superRefine((t, ctx) => {
    if (Date.parse(t.fireAt) <= Date.parse(t.scheduledAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fireAt"],
        message: "fireAt must be after scheduledAt",
      });
    }
    if (t.kind === "cron_schedule" && t.cronExpression === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cronExpression"],
        message: "cron_schedule timer requires cronExpression",
      });
    }
    if (t.kind === "relative_after" && t.relativeSeconds === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relativeSeconds"],
        message: "relative_after timer requires relativeSeconds",
      });
    }
    if (t.status === "fired") {
      if (t.firedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["firedAt"],
          message: "fired timer requires firedAt",
        });
      }
      if (t.fireCount < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fireCount"],
          message: "fired timer requires fireCount >= 1",
        });
      }
    }
    if (t.status === "cancelled") {
      if (t.cancelledAt === null || t.cancelledReason === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cancelledAt"],
          message: "cancelled timer requires cancelledAt + cancelledReason",
        });
      }
    }
    if (t.status === "expired_before_fire" && t.expiredAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiredAt"],
        message: "expired_before_fire timer requires expiredAt",
      });
    }
    if (t.kind !== "cron_schedule" && t.fireCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fireCount"],
        message: "non-cron timers fire at most once",
      });
    }
    if (t.kind === "cron_schedule" && t.status === "fired" && t.nextFireAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextFireAt"],
        message:
          "fired cron_schedule timer requires nextFireAt (recurring timers compute next fire)",
      });
    }
  });
export type WorkflowTimer = z.infer<typeof WorkflowTimerSchema>;

export const isTimerDue = (timer: WorkflowTimer, now: Date): boolean => {
  if (timer.status !== "scheduled") return false;
  return now.getTime() >= Date.parse(timer.fireAt);
};

export const fireTimer = (
  timer: WorkflowTimer,
  now: Date,
  nextFireAt: string | null,
): WorkflowTimer => {
  if (!canTransitionTimer(timer.status, "fired")) {
    throw new Error(
      `cannot transition timer from ${timer.status} to fired`,
    );
  }
  if (timer.kind === "cron_schedule" && nextFireAt === null) {
    throw new Error("cron_schedule timer requires nextFireAt on fire");
  }
  return {
    ...timer,
    status: "fired",
    firedAt: now.toISOString(),
    fireCount: timer.fireCount + 1,
    nextFireAt: timer.kind === "cron_schedule" ? nextFireAt : null,
  };
};

/**
 * Arms the next occurrence of a **recurring** timer: one row, one timer id, `fireCount` advancing
 * and `fireAt` moving to the occurrence `nextFireAt` already named.
 *
 * `TIMER_TRANSITIONS.fired` is `[]` and stays that way, so `canTransitionTimer("fired",
 * "scheduled")` is false and this does not go through it. That is not an inconsistency of the
 * ADR-0307 kind — it is the two axes kept apart. **Status** says whether this occurrence is over;
 * **kind** says whether there is another one. Three of the four kinds fire exactly once, so an edge
 * on the status map would be false for three quarters of its domain and would quietly let a
 * `relative_after` timer be re-armed; a kind-gated door cannot.
 *
 * `scheduledAt` moves to `now` because `WorkflowTimerSchema`'s only invariant on it is
 * `fireAt > scheduledAt` — it is the start of *this* wait, not a creation stamp, and the full arming
 * history is in the log's `timer_scheduled` events either way. `firedAt` is kept: "when did this
 * last fire" is still true, and it is what tells a re-armed row from one that has never fired.
 */
export const rearmTimer = (
  timer: WorkflowTimer,
  nextFireAt: string,
  now: Date,
): WorkflowTimer => {
  if (timer.kind !== "cron_schedule") {
    throw new Error(`cannot re-arm a ${timer.kind} timer: only cron_schedule recurs`);
  }
  if (timer.status !== "fired") {
    throw new Error(`cannot re-arm a timer in status ${timer.status}: re-arming follows a fire`);
  }
  if (Date.parse(nextFireAt) <= now.getTime()) {
    throw new Error("cannot re-arm a timer into the past");
  }
  return {
    ...timer,
    status: "scheduled",
    scheduledAt: now.toISOString(),
    fireAt: nextFireAt,
    nextFireAt: null,
  };
};

export const cancelTimer = (
  timer: WorkflowTimer,
  reason: string,
  now: Date,
): WorkflowTimer => {
  if (!canTransitionTimer(timer.status, "cancelled")) {
    throw new Error(
      `cannot transition timer from ${timer.status} to cancelled`,
    );
  }
  return {
    ...timer,
    status: "cancelled",
    cancelledAt: now.toISOString(),
    cancelledReason: reason,
  };
};

export const isWithinBusinessHours = (
  config: {
    readonly startMinutesSinceMidnight: number;
    readonly endMinutesSinceMidnight: number;
    readonly workdays: readonly number[];
  },
  localTime: {
    readonly minutesSinceMidnight: number;
    readonly dayOfWeek: number;
  },
): boolean => {
  if (!config.workdays.includes(localTime.dayOfWeek)) return false;
  return (
    localTime.minutesSinceMidnight >= config.startMinutesSinceMidnight &&
    localTime.minutesSinceMidnight < config.endMinutesSinceMidnight
  );
};
