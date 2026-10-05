import type { TimerKind, WorkflowDefinition, WorkflowEvent } from "@crossengin/workflow-engine";
import { projectTimers } from "@crossengin/workflow-runtime";

import type { TimerProjection } from "./timer-store.js";

/**
 * Why a timer's kind could not be resolved from the log plus its definition. Each is a refusal,
 * never a substituted value: `meta.workflow_timers.kind` is NOT NULL with no default, and its four
 * members are not interchangeable — a `cron_schedule` recurs where a `relative_after` fires once,
 * so guessing either way states a schedule nobody declared in the table a worker reads the schedule
 * back from.
 *
 * This is `signal-provenance.ts`'s shape on the sibling table, and for the same reason: a
 * `TimerDefinition.kind` is a required, non-defaulted field of the definition, exactly as
 * `SignalDefinition.deliveryGuarantee` is, and `WorkflowDefinitionSchema` refuses a `timer_fired`
 * transition naming an undeclared timer just as it refuses an undeclared signal. So the definition
 * is the only place in the contract where a timer's kind exists, and nothing else may answer for it.
 */
export const TIMER_PROVENANCE_DEFECTS = [
  "definition_unavailable",
  "timer_undeclared",
  "cron_next_fire_unresolved",
] as const;
export type TimerProvenanceDefect = (typeof TIMER_PROVENANCE_DEFECTS)[number];

export class TimerProvenanceUnresolved extends Error {
  readonly defect: TimerProvenanceDefect;
  readonly timerId: string;
  readonly timerName: string;

  constructor(opts: {
    readonly defect: TimerProvenanceDefect;
    readonly timerId: string;
    readonly timerName: string;
    readonly detail: string;
  }) {
    super(
      `cannot persist timer ${opts.timerId} (${opts.timerName}): ${opts.defect} — ${opts.detail}`,
    );
    this.name = "TimerProvenanceUnresolved";
    this.defect = opts.defect;
    this.timerId = opts.timerId;
    this.timerName = opts.timerName;
  }
}

/**
 * The kind `projectTimers` cannot produce, **and the parameters that travel with it**.
 *
 * The parameters are here rather than left NULL because the kind alone is not a storable fact.
 * `WorkflowTimerSchema` requires `cronExpression` for a `cron_schedule` and `relativeSeconds` for a
 * `relative_after`, while the columns are nullable — so writing the kind and omitting its parameter
 * produces a row the contract forbids and the CHECK permits, which is the very class this fix is
 * closing. `TimerDefinitionSchema` already enforces the pairing on its own side, so resolving the
 * kind from the definition hands over the parameter for free: one lookup, no second question.
 *
 * `timezone` rides along for the same reason in miniature — the column defaults to `'UTC'`, and a
 * `business_hours` timer declared in `Asia/Tokyo` and stored as UTC is a different timer.
 */
export interface TimerProvenance {
  readonly kind: TimerKind;
  readonly cronExpression: string | null;
  readonly relativeSeconds: number | null;
  readonly timezone: string;
  /**
   * The name of the transition whose `timer_fired` trigger names this timer — the one fact that
   * answers "what happens when this fires" from the row alone, and the column `claimDueTimers`
   * already surfaces on every `ClaimedTimer` while nothing wrote it.
   *
   * It is **not** on `TimerDefinition`, which is six fields and carries no state and no trigger: a
   * timer is bound to a state by the *transition* that waits on it, so this is a lookup over
   * `definition.transitions`. Two rules follow from that, and both matter.
   *
   * It is genuinely nullable — a declared timer that no transition names is expressible, and
   * `WorkflowDefinitionSchema` checks the implication only the other way (a `timer_fired` trigger
   * must name a declared timer, not that a declared timer is triggered).
   *
   * And it is `null` when **more than one** transition names the timer. `chooseTransition` returns
   * the first candidate whose guards pass, decided at fire time against live variables, so a column
   * holding one name cannot stand for a guard-decided choice between three — and a reader taking it
   * as the answer would route where the engine would not. One name is written only when it is the
   * only name. Nothing routes by this today (`buildTimerProcessor` calls
   * `fireDueTimersForInstance`, which re-derives the transition from the same definition), so this
   * is a record of the declaration rather than an input to it; a published definition is immutable,
   * so the two cannot disagree.
   */
  readonly transitionToTrigger: string | null;
}

/** The sole `timer_fired` transition for this timer, or `null` when there is none or several. */
function soleTriggeredTransition(
  definition: WorkflowDefinition,
  timerName: string,
): string | null {
  const candidates = definition.transitions.filter(
    (t) => t.trigger.kind === "timer_fired" && t.trigger.timerName === timerName,
  );
  return candidates.length === 1 ? candidates[0]!.name : null;
}

export function resolveTimerProvenance(input: {
  readonly timerId: string;
  readonly timerName: string;
  readonly status: TimerProjection["status"];
  readonly fireCount: number;
  readonly definition: WorkflowDefinition | undefined;
}): TimerProvenance {
  const { timerId, timerName } = input;
  if (input.definition === undefined) {
    throw new TimerProvenanceUnresolved({
      defect: "definition_unavailable",
      timerId,
      timerName,
      detail: "the instance's workflow definition is not in the engine's definition map",
    });
  }
  const declared = input.definition.timers.find((t) => t.name === timerName);
  if (declared === undefined) {
    throw new TimerProvenanceUnresolved({
      defect: "timer_undeclared",
      timerId,
      timerName,
      detail: `definition ${input.definition.id} declares no timer by that name`,
    });
  }
  // The last line of defence for the row `WorkflowTimerSchema` forbids and the CHECK permits, and
  // the one refusal here that is not about a missing declaration.
  //
  // A fired `cron_schedule` timer requires a `nextFireAt`: it is a *recurring* timer, and the next
  // occurrence is what makes it one. Nothing in the engine computes it — `fireDueTimersForInstance`
  // appends `timer_fired` with `{timerName}` and reschedules nothing — so the honest answer is that
  // this deployment cannot recur a cron timer, and a stored row saying `fired` with no next
  // occurrence would record a recurring timer that has silently stopped recurring. That is the
  // worst of the three outcomes: worse than refusing, and worse than never having offered the kind.
  if (declared.kind === "cron_schedule" && input.status === "fired") {
    throw new TimerProvenanceUnresolved({
      defect: "cron_next_fire_unresolved",
      timerId,
      timerName,
      detail:
        `the definition declares cron_schedule and the log records ${String(input.fireCount)} fire(s), ` +
        "but no timer_fired event carries a nextFireAt — this engine does not compute a cron timer's next occurrence",
    });
  }
  return {
    kind: declared.kind,
    cronExpression: declared.cronExpression,
    relativeSeconds: declared.relativeSeconds,
    timezone: declared.timezone,
    transitionToTrigger: soleTriggeredTransition(input.definition, timerName),
  };
}

/**
 * `projectTimers` plus the kind the table requires — the one input `PostgresTimerStore.upsert`
 * accepts, so no caller can assemble a row that the column constraints will reject.
 */
export function projectPersistableTimers(
  events: readonly WorkflowEvent[],
  definition: WorkflowDefinition | undefined,
): readonly TimerProjection[] {
  return projectTimers(events).map((t): TimerProjection => {
    const provenance = resolveTimerProvenance({
      timerId: t.id,
      timerName: t.timerName,
      status: t.status,
      fireCount: t.fireCount,
      definition,
    });
    return {
      id: t.id,
      instanceId: t.instanceId,
      tenantId: t.tenantId,
      timerName: t.timerName,
      kind: provenance.kind,
      status: t.status,
      scheduledAt: t.scheduledAt,
      fireAt: t.fireAt,
      timezone: provenance.timezone,
      cronExpression: provenance.cronExpression,
      relativeSeconds: provenance.relativeSeconds,
      transitionToTrigger: provenance.transitionToTrigger,
      firedAt: t.firedAt,
      cancelledAt: t.cancelledAt,
      fireCount: t.fireCount,
    };
  });
}
