import type {
  InstanceCancellationWorkSurvey,
  WorkflowEvent,
} from "@crossengin/workflow-engine";

import { listCompensatableActivities } from "./saga.js";

/** A timer the log says is still scheduled: neither fired nor cancelled. */
export interface OutstandingTimer {
  readonly id: string;
  readonly name: string;
  /** Epoch milliseconds. `Number.MAX_SAFE_INTEGER` when the event carried no parsable `fireAt`. */
  readonly fireAt: number;
}

/**
 * The instance's still-scheduled timers, derived from the log alone. Both the firing path and
 * `cancel_timer` read from here, so an already fired or cancelled timer is invisible to both: a
 * re-delivered claim fires nothing and a repeated cancel appends no second terminal event for one
 * timer.
 */
export function outstandingTimersFromLog(
  events: readonly WorkflowEvent[],
): readonly OutstandingTimer[] {
  const scheduled = new Map<string, OutstandingTimer>();
  for (const e of events) {
    if (e.timerId === null) continue;
    if (e.kind === "timer_scheduled") {
      const name = typeof e.payload["timerName"] === "string" ? e.payload["timerName"] : "";
      const fireAt =
        typeof e.payload["fireAt"] === "string"
          ? Date.parse(e.payload["fireAt"])
          : Number.MAX_SAFE_INTEGER;
      scheduled.set(e.timerId, {
        id: e.timerId,
        name,
        fireAt: Number.isFinite(fireAt) ? fireAt : Number.MAX_SAFE_INTEGER,
      });
    } else if (e.kind === "timer_fired" || e.kind === "timer_cancelled") {
      scheduled.delete(e.timerId);
    }
  }
  return [...scheduled.values()];
}

/** Where an activity attempt stood at the end of the log. */
type ActivityPosition = "scheduled" | "in_flight";

/**
 * Surveys what a cancellation would have to answer for, from the instance's log and nothing else.
 *
 * The two activity positions are what make the guarantee honest: `scheduled` means the engine owns
 * the decision to begin it (so it simply will not), while `in_flight` means a handler is already
 * running and can only be *told*. Reading them from the log rather than from in-process bookkeeping
 * is what lets a cancellation work for an instance this process never started — which is the same
 * reason `fireDueTimersForInstance` and `executeScheduledActivity` are log-driven.
 */
export function surveyCancellableWork(
  events: readonly WorkflowEvent[],
): InstanceCancellationWorkSurvey {
  const positions = new Map<string, ActivityPosition>();
  for (const e of events) {
    if (e.activityId === null) continue;
    switch (e.kind) {
      case "activity_scheduled":
        positions.set(e.activityId, "scheduled");
        break;
      case "activity_started":
        // Only an already-scheduled attempt advances: an `activity_started` for an id the log never
        // scheduled is a corrupt log, and inventing an in-flight activity from it would make the
        // cancellation claim it signalled something that does not exist.
        if (positions.has(e.activityId)) positions.set(e.activityId, "in_flight");
        break;
      case "activity_completed":
      case "activity_failed":
      case "activity_timed_out":
      case "activity_cancelled":
      case "activity_compensated":
        positions.delete(e.activityId);
        break;
      default:
        break;
    }
  }

  const scheduledActivityIds: string[] = [];
  const inFlightActivityIds: string[] = [];
  for (const [activityId, position] of positions) {
    if (position === "scheduled") scheduledActivityIds.push(activityId);
    else inFlightActivityIds.push(activityId);
  }

  return {
    outstandingTimerIds: outstandingTimersFromLog(events).map((t) => t.id),
    scheduledActivityIds,
    inFlightActivityIds,
    compensatableActivityIds: listCompensatableActivities(events)
      .filter((a) => a.compensationActivityKey !== null)
      .map((a) => a.activityId),
  };
}
