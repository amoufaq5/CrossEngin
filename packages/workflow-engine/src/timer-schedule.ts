import { cronExpressionCanEverMatch, cronNextAfter, parseCron } from "@crossengin/jobs";

import type { TimerDefinition } from "./definitions.js";
import { TIMER_KINDS, type TimerKind } from "./timers.js";

/**
 * Why a declared timer cannot be turned into a concrete fire instant.
 *
 * Every member is a **refusal**, never a substituted instant, and that is the whole point of this
 * module. Until it existed the engine read `relativeSeconds` (defaulting to 60) and ignored the
 * declared `kind`, so a `cron_schedule` or `absolute_at` timer got a fire-once timer at `now + 60s`
 * — while `timer-provenance.ts` wrote the *declared* kind into `meta.workflow_timers`. The row said
 * `cron_schedule` and the behaviour was `relative_after`, so nothing disagreed with anything. A
 * substituted instant is the same defect with one more decimal place: a schedule nobody declared,
 * in the table the schedule is read back from (ADR-0331's `delivery_guarantee` argument).
 */
export const TIMER_SCHEDULE_DEFECTS = [
  "timer_undeclared",
  "timezone_unresolvable",
  "relative_seconds_undeclared",
  "absolute_variable_undeclared",
  "absolute_variable_unset",
  "absolute_variable_not_an_instant",
  "absolute_instant_not_in_future",
  "cron_expression_undeclared",
  "cron_expression_unparsable",
  "cron_never_matches",
  "cron_no_occurrence_in_horizon",
  "business_hours_unschedulable",
] as const;
export type TimerScheduleDefect = (typeof TIMER_SCHEDULE_DEFECTS)[number];

/** A resolved fire instant, or the named reason there is none. Pure: nothing is thrown. */
export type TimerScheduleResolution =
  | { readonly ok: true; readonly kind: TimerKind; readonly fireAt: string }
  | { readonly ok: false; readonly defect: TimerScheduleDefect; readonly detail: string };

/**
 * Which kinds fire more than once.
 *
 * This is a **kind** property and not a status one, which is why `TIMER_TRANSITIONS.fired` stays
 * `[]`. Three of the four kinds fire exactly once, so a status map saying `fired → scheduled` would
 * be false for three quarters of its own domain; recurrence is instead gated on the kind, and
 * `rearmTimer` is the only door. Same two-axes shape as ADR-0332's policy split — shape decides one
 * thing, kind decides the other, and conflating them is the trap.
 */
export const RECURRING_TIMER_KINDS: ReadonlySet<TimerKind> = new Set<TimerKind>(["cron_schedule"]);

export const isRecurringTimerKind = (kind: TimerKind): boolean => RECURRING_TIMER_KINDS.has(kind);

/**
 * How each kind is scheduled, as a **total** map over `TIMER_KINDS` — so a fifth kind is a compile
 * error here rather than a member silently inheriting whichever branch an `if`-chain ended on. That
 * is exactly how the defect this module fixes survived: `applyScheduleTimer` had no branch at all,
 * so every kind got `relative_after`'s.
 *
 * `reads` is what a kind consults beyond the clock, and it is the field that makes the fourth kind's
 * answer legible: `business_hours` reads a working-day configuration that `TimerDefinition` has
 * nowhere to declare.
 */
export const TIMER_KIND_SCHEDULING: Readonly<
  Record<
    TimerKind,
    {
      readonly recurring: boolean;
      readonly reads: readonly ("relativeSeconds" | "absoluteTimestampVariable" | "cronExpression" | "timezone" | "business_day_config")[];
      readonly schedulable: boolean;
    }
  >
> = {
  absolute_at: { recurring: false, reads: ["absoluteTimestampVariable"], schedulable: true },
  relative_after: { recurring: false, reads: ["relativeSeconds"], schedulable: true },
  cron_schedule: { recurring: true, reads: ["cronExpression", "timezone"], schedulable: true },
  business_hours: { recurring: false, reads: ["business_day_config", "timezone"], schedulable: false },
};

/**
 * Why `business_hours` is refused rather than approximated.
 *
 * `isWithinBusinessHours` in `timers.ts` takes `{startMinutesSinceMidnight, endMinutesSinceMidnight,
 * workdays}` — a configuration that exists **nowhere in the contract**. `TimerDefinition` is six
 * fields and none of them is a working day. So there are exactly three things this kind can do:
 *
 * 1. schedule it as a relative timer, which is the defect this module removes;
 * 2. invent a default business day (09:00–17:00, Mon–Fri), which writes a schedule nobody declared
 *    into the table the schedule is read back from — and a deployment in Riyadh or Tel Aviv whose
 *    working week is not Monday-to-Friday would be silently wrong;
 * 3. refuse by name.
 *
 * Declaring the configuration is the real fix and it is **not free**: a new field on
 * `TimerDefinition` joins `definitionContentSha256`'s content set, so every stored definition's
 * digest moves and every republication of one is refused — the same reason ADR-0333 did not add an
 * `ActivityDefinitionSchema` and ADR-0331 left `SignalDefinition.idempotencyKey` a documented
 * misnomer. It needs a `crossengin.workflow.definition.content.v2` tag and a story for stored rows,
 * which is a decision and not a wiring fix.
 *
 * So: refused here, and refused *at publication* by `WorkflowDefinitionSchema` — which is free,
 * because a `superRefine` narrows what is accepted and changes no accepted definition's bytes. A
 * deployment therefore cannot publish a timer it could not schedule, which is this family's "the
 * honest fix sits one level up from where the pain was felt".
 */
export const BUSINESS_HOURS_REFUSAL_DETAIL =
  "business_hours needs a working-day configuration (start, end, workdays) that TimerDefinition " +
  "cannot declare; declaring it changes definitionContentSha256 and so needs a content version bump";

/** `true` when the IANA zone resolves. Asked of `Intl` rather than matched against a list. */
export function isResolvableTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** `null` when the expression parses, else the parser's complaint. */
export function cronParseFailure(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function refuse(defect: TimerScheduleDefect, detail: string): TimerScheduleResolution {
  return { ok: false, defect, detail };
}

/**
 * The zone to hand the evaluator.
 *
 * This used to map UTC-equivalent names to `undefined` to dodge a 314x penalty: `cronNextAfter` read
 * wall-clock fields by constructing a **new `Intl.DateTimeFormat` on every minute it stepped**, and
 * took that path for any non-`undefined` zone — including the literal `"UTC"`, which is
 * `TimerDefinition.timezone`'s default and so what nearly every declared timer carries.
 *
 * **That is fixed at the source now**, in `packages/jobs/src/cron.ts`: the formatter is cached per
 * zone for the life of the process, `UTC_EQUIVALENT_ZONES` lives there so *every* caller gets the
 * short-circuit rather than only this one, and a date-mismatched step skips the whole local day.
 * Measured on the same question, `cronPrevOnOrBefore("0 0 1 * *", …, "UTC")`: **4,644 ms before,
 * 2.8 ms after.** So this is a pass-through, kept as a named seam because the declaration's zone and
 * the evaluator's argument are not the same concept — the evaluator takes `undefined` to mean UTC
 * and a declaration cannot — and because deleting the seam would scatter that distinction across
 * three call sites.
 *
 * Its old local name set was also **wrong in both directions** relative to the one in `cron.ts`: it
 * lacked `Etc/GMT+0`, `Etc/GMT-0`, `Etc/GMT0`, `UCT`, `Etc/UCT`, `Etc/Universal` and `Etc/Zulu`, and
 * a second copy of a list like that drifting is ADR-0332's `FEATURE_FLAG_COLUMN_NAMES` exactly.
 */
export function evaluatorTimezone(timezone: string): string | undefined {
  return timezone;
}

/**
 * The instant a declared timer first fires, from the declaration and nothing else.
 *
 * **The timezone is checked before any kind is consulted**, and that is deliberate. `cronNextAfter`
 * reads wall-clock fields through `Intl.DateTimeFormat` and *silently falls back to UTC* on a zone
 * it cannot resolve — so a timer declaring `Erope/London` would fire on UTC's schedule while the row
 * records the misspelling. That is this lane's defect in one field, so an unresolvable zone is a
 * refusal here even for the two kinds that never read it: a zone nobody can resolve is not a zone,
 * and letting it through for `relative_after` would leave the same row unreadable the day its kind
 * is corrected.
 */
export function resolveTimerFireAt(
  timer: TimerDefinition,
  context: { readonly now: Date; readonly variables: Readonly<Record<string, unknown>> },
): TimerScheduleResolution {
  if (!isResolvableTimezone(timer.timezone)) {
    return refuse(
      "timezone_unresolvable",
      `timezone ${JSON.stringify(timer.timezone)} is not an IANA zone Intl can resolve ` +
        "(an unresolved zone would silently evaluate in UTC)",
    );
  }
  const kind: TimerKind = timer.kind;
  switch (kind) {
    case "relative_after": {
      if (timer.relativeSeconds === null) {
        return refuse("relative_seconds_undeclared", "relative_after timer declares no relativeSeconds");
      }
      return {
        ok: true,
        kind,
        fireAt: new Date(context.now.getTime() + timer.relativeSeconds * 1000).toISOString(),
      };
    }
    case "absolute_at": {
      if (timer.absoluteTimestampVariable === null) {
        return refuse(
          "absolute_variable_undeclared",
          "absolute_at timer declares no absoluteTimestampVariable",
        );
      }
      const name = timer.absoluteTimestampVariable;
      if (!Object.prototype.hasOwnProperty.call(context.variables, name)) {
        return refuse(
          "absolute_variable_unset",
          `variable ${JSON.stringify(name)} holds the fire instant and the instance has not set it`,
        );
      }
      const raw = context.variables[name];
      const instant = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
      if (!Number.isFinite(instant)) {
        return refuse(
          "absolute_variable_not_an_instant",
          `variable ${JSON.stringify(name)} must hold an ISO 8601 instant, got ${JSON.stringify(raw)}`,
        );
      }
      // `WorkflowTimerSchema` requires `fireAt > scheduledAt`, so a past instant cannot be stored at
      // all — and clamping it to `now` would fire at a time nobody declared, which is the whole
      // family of defect this module exists to stop. Refused by name instead.
      if (instant <= context.now.getTime()) {
        return refuse(
          "absolute_instant_not_in_future",
          `variable ${JSON.stringify(name)} names ${new Date(instant).toISOString()}, which is not after ` +
            `${context.now.toISOString()} — a timer cannot be scheduled into the past`,
        );
      }
      return { ok: true, kind, fireAt: new Date(instant).toISOString() };
    }
    case "cron_schedule": {
      if (timer.cronExpression === null) {
        return refuse("cron_expression_undeclared", "cron_schedule timer declares no cronExpression");
      }
      return resolveCronOccurrence(timer.cronExpression, timer.timezone, context.now, kind);
    }
    case "business_hours":
      return refuse("business_hours_unschedulable", BUSINESS_HOURS_REFUSAL_DETAIL);
  }
}

/**
 * The next occurrence of a **recurring** timer strictly after `after`.
 *
 * `null` for a non-recurring kind is not a defect — it is the answer: `WorkflowTimerSchema` requires
 * `nextFireAt` to be null for every kind but `cron_schedule`, so the absence is the contract rather
 * than a missing computation. Separating that from the eleven refusals is what lets the caller treat
 * "fires once, nothing next" and "recurs and we could not say when" differently, which is the
 * distinction `cron_next_fire_unresolved` was invented for.
 */
export function resolveNextTimerFireAt(
  timer: TimerDefinition,
  context: { readonly after: Date },
): TimerScheduleResolution | null {
  if (!isRecurringTimerKind(timer.kind)) return null;
  if (!isResolvableTimezone(timer.timezone)) {
    return refuse(
      "timezone_unresolvable",
      `timezone ${JSON.stringify(timer.timezone)} is not an IANA zone Intl can resolve`,
    );
  }
  if (timer.cronExpression === null) {
    return refuse("cron_expression_undeclared", "cron_schedule timer declares no cronExpression");
  }
  return resolveCronOccurrence(timer.cronExpression, timer.timezone, context.after, timer.kind);
}

/**
 * One cron step, shared by the first fire and every re-arm — so an occurrence and its successor are
 * computed by the same function and a recurring timer cannot drift from its own schedule.
 *
 * `cronNextAfter` is **strictly** after its argument, which is the property that keeps a re-arm from
 * looping: a timer that fires ten minutes late is re-armed at the *next* occurrence rather than
 * immediately re-qualifying, so a worker cannot spin on a backlog of one row.
 */
function resolveCronOccurrence(
  expression: string,
  timezone: string,
  after: Date,
  kind: TimerKind,
): TimerScheduleResolution {
  const parseFailure = cronParseFailure(expression);
  if (parseFailure !== null) {
    return refuse("cron_expression_unparsable", `cronExpression ${JSON.stringify(expression)}: ${parseFailure}`);
  }
  // Asked before the search, because the two answers are different facts and `cronNextAfter` returns
  // the same `null` for both. `0 0 30 2 *` names 30 February and can never fire; `0 0 29 2 *` fires
  // every four years and **used to be refused here as "no occurrence in horizon"** — the evaluator's
  // step budget was 382 days of minutes, so a leap day was outside it. The budget now skips whole
  // date-mismatched days and reaches it (verified: 0.7 ms, `2028-02-29` from a 2026 start), so a
  // leap-day timer is schedulable and only a genuinely impossible date is refused.
  if (!cronExpressionCanEverMatch(expression)) {
    return refuse(
      "cron_never_matches",
      `cronExpression ${JSON.stringify(expression)} can never match a real calendar date, ` +
        `so the timer would never fire`,
    );
  }
  const next = cronNextAfter(expression, after, evaluatorTimezone(timezone));
  if (next === null) {
    return refuse(
      "cron_no_occurrence_in_horizon",
      `cronExpression ${JSON.stringify(expression)} has no occurrence after ${after.toISOString()} ` +
        `in ${JSON.stringify(timezone)} within the evaluator's search horizon`,
    );
  }
  return { ok: true, kind, fireAt: next.toISOString() };
}

/** Every kind, so a caller can enumerate what a deployment can and cannot schedule. */
export const SCHEDULABLE_TIMER_KINDS: readonly TimerKind[] = TIMER_KINDS.filter(
  (k) => TIMER_KIND_SCHEDULING[k].schedulable,
);
