import { cronNextAfter } from "@crossengin/jobs";
import { describe, expect, it } from "vitest";

import type { TimerDefinition } from "./definitions.js";
import {
  BUSINESS_HOURS_REFUSAL_DETAIL,
  evaluatorTimezone,
  RECURRING_TIMER_KINDS,
  SCHEDULABLE_TIMER_KINDS,
  TIMER_KIND_SCHEDULING,
  TIMER_SCHEDULE_DEFECTS,
  cronParseFailure,
  isRecurringTimerKind,
  isResolvableTimezone,
  resolveNextTimerFireAt,
  resolveTimerFireAt,
} from "./timer-schedule.js";
import { TIMER_KINDS, type TimerKind } from "./timers.js";

const NOW = new Date("2026-05-16T12:00:00.000Z");

function timer(over: Partial<TimerDefinition> = {}): TimerDefinition {
  return {
    name: "deadline",
    kind: "relative_after",
    relativeSeconds: 3_600,
    absoluteTimestampVariable: null,
    cronExpression: null,
    timezone: "UTC",
    ...over,
  };
}

const WALL_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock reading of an instant in a zone — what a cron expression is actually about. */
function wall(instant: string, timeZone: string): string {
  let formatter = WALL_FORMATTERS.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    WALL_FORMATTERS.set(timeZone, formatter);
  }
  return formatter.format(new Date(instant));
}

describe("TIMER_KIND_SCHEDULING", () => {
  it("is total over TIMER_KINDS, so a fifth kind is a compile error", () => {
    expect(Object.keys(TIMER_KIND_SCHEDULING).sort()).toEqual([...TIMER_KINDS].sort());
  });

  it("marks exactly cron_schedule recurring, and agrees with RECURRING_TIMER_KINDS", () => {
    const recurring = TIMER_KINDS.filter((k) => TIMER_KIND_SCHEDULING[k].recurring);
    expect(recurring).toEqual(["cron_schedule"]);
    expect([...RECURRING_TIMER_KINDS]).toEqual(["cron_schedule"]);
    for (const kind of TIMER_KINDS) {
      expect(isRecurringTimerKind(kind)).toBe(TIMER_KIND_SCHEDULING[kind].recurring);
    }
  });

  it("marks business_hours as the one kind this deployment cannot schedule", () => {
    expect(SCHEDULABLE_TIMER_KINDS).toEqual(["absolute_at", "relative_after", "cron_schedule"]);
    expect(TIMER_KIND_SCHEDULING.business_hours.schedulable).toBe(false);
  });

  it("names a business-day configuration as what business_hours reads and cannot find", () => {
    expect(TIMER_KIND_SCHEDULING.business_hours.reads).toContain("business_day_config");
    for (const kind of SCHEDULABLE_TIMER_KINDS) {
      expect(TIMER_KIND_SCHEDULING[kind].reads).not.toContain("business_day_config");
    }
  });

  it("has no duplicate defect names", () => {
    expect(new Set(TIMER_SCHEDULE_DEFECTS).size).toBe(TIMER_SCHEDULE_DEFECTS.length);
  });
});

describe("isResolvableTimezone", () => {
  it("accepts IANA zones Intl knows, including a half-hour offset and UTC", () => {
    for (const zone of ["UTC", "Europe/London", "America/New_York", "Asia/Kolkata", "Australia/Lord_Howe"]) {
      expect(isResolvableTimezone(zone)).toBe(true);
    }
  });

  it("rejects a misspelling, which would otherwise evaluate silently in UTC", () => {
    expect(isResolvableTimezone("Erope/London")).toBe(false);
    expect(isResolvableTimezone("Mars/Olympus_Mons")).toBe(false);
    expect(isResolvableTimezone("")).toBe(false);
  });
});

describe("cronParseFailure", () => {
  it("passes a 5-field and a 6-field expression", () => {
    expect(cronParseFailure("0 2 * * *")).toBeNull();
    expect(cronParseFailure("*/30 * * * * *")).toBeNull();
  });

  it("names the complaint for an out-of-range field and a bad step", () => {
    expect(cronParseFailure("0 99 * * *")).not.toBeNull();
    expect(cronParseFailure("*/0 * * * *")).not.toBeNull();
    expect(cronParseFailure("not a cron")).not.toBeNull();
  });
});

describe("resolveTimerFireAt — relative_after", () => {
  it("fires at now + relativeSeconds", () => {
    const r = resolveTimerFireAt(timer({ relativeSeconds: 90 }), { now: NOW, variables: {} });
    expect(r).toEqual({ ok: true, kind: "relative_after", fireAt: "2026-05-16T12:01:30.000Z" });
  });

  it("refuses when the declaration carries no relativeSeconds", () => {
    const r = resolveTimerFireAt(timer({ relativeSeconds: null }), { now: NOW, variables: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.defect).toBe("relative_seconds_undeclared");
  });

  it("does not read the action's parameters: the declaration is the only input", () => {
    // The old `applyScheduleTimer` read `parameters.relativeSeconds` and defaulted to 60. There is
    // nowhere in this signature for a parameter bag to arrive.
    const r = resolveTimerFireAt(timer({ relativeSeconds: 60 }), { now: NOW, variables: { relativeSeconds: 999 } });
    expect(r.ok && r.fireAt).toBe("2026-05-16T12:01:00.000Z");
  });
});

describe("resolveTimerFireAt — absolute_at", () => {
  const abs = timer({
    kind: "absolute_at",
    relativeSeconds: null,
    absoluteTimestampVariable: "due_at",
  });

  it("fires at the instant the named variable holds", () => {
    const r = resolveTimerFireAt(abs, {
      now: NOW,
      variables: { due_at: "2026-06-01T09:30:00.000Z" },
    });
    expect(r).toEqual({ ok: true, kind: "absolute_at", fireAt: "2026-06-01T09:30:00.000Z" });
  });

  it("does not fire at now + 60s, which is what it used to do", () => {
    const r = resolveTimerFireAt(abs, { now: NOW, variables: { due_at: "2026-06-01T09:30:00.000Z" } });
    expect(r.ok && r.fireAt).not.toBe("2026-05-16T12:01:00.000Z");
  });

  it("refuses when the declaration names no variable", () => {
    const r = resolveTimerFireAt(timer({ kind: "absolute_at", relativeSeconds: null }), {
      now: NOW,
      variables: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.defect).toBe("absolute_variable_undeclared");
  });

  it("refuses when the instance has not set the variable", () => {
    const r = resolveTimerFireAt(abs, { now: NOW, variables: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.defect).toBe("absolute_variable_unset");
  });

  it("refuses a variable holding something that is not an instant", () => {
    for (const value of ["tomorrow", 1_780_000_000_000, null, { at: "now" }]) {
      const r = resolveTimerFireAt(abs, { now: NOW, variables: { due_at: value } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.defect).toBe("absolute_variable_not_an_instant");
    }
  });

  it("refuses an instant in the past rather than clamping it to now", () => {
    // `WorkflowTimerSchema` requires `fireAt > scheduledAt`, so a clamped instant is a row the
    // contract forbids — and it would fire at a time nobody declared.
    const r = resolveTimerFireAt(abs, { now: NOW, variables: { due_at: "2026-05-16T11:59:59.000Z" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.defect).toBe("absolute_instant_not_in_future");
  });

  it("refuses an instant exactly equal to now", () => {
    const r = resolveTimerFireAt(abs, { now: NOW, variables: { due_at: NOW.toISOString() } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.defect).toBe("absolute_instant_not_in_future");
  });

  it("does not take an inherited property for a set variable", () => {
    const r = resolveTimerFireAt(abs, {
      now: NOW,
      variables: Object.create({ due_at: "2026-06-01T09:30:00.000Z" }) as Record<string, unknown>,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.defect).toBe("absolute_variable_unset");
  });
});

describe("resolveTimerFireAt — business_hours", () => {
  it("refuses by name, naming the missing configuration", () => {
    const r = resolveTimerFireAt(timer({ kind: "business_hours", relativeSeconds: null }), {
      now: NOW,
      variables: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.defect).toBe("business_hours_unschedulable");
      expect(r.detail).toBe(BUSINESS_HOURS_REFUSAL_DETAIL);
      expect(r.detail).toContain("definitionContentSha256");
    }
  });

  it("has no next occurrence either", () => {
    expect(
      resolveNextTimerFireAt(timer({ kind: "business_hours", relativeSeconds: null }), { after: NOW }),
    ).toBeNull();
  });
});

describe("resolveTimerFireAt — timezone", () => {
  it("refuses an unresolvable zone before the kind is consulted", () => {
    // Even for `relative_after`, which never reads it: an unresolved zone makes the cron evaluator
    // fall back to UTC silently, so a zone nobody can resolve is not a zone.
    for (const kind of TIMER_KINDS) {
      const r = resolveTimerFireAt(
        timer({ kind, timezone: "Erope/London", relativeSeconds: 60, cronExpression: "0 2 * * *", absoluteTimestampVariable: "x" }),
        { now: NOW, variables: { x: "2026-06-01T00:00:00.000Z" } },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.defect).toBe("timezone_unresolvable");
    }
  });
});

/**
 * The cron table.
 *
 * **Sources, not intuition.** Field semantics and the day-of-month / day-of-week OR rule come from
 * `crontab(5)` (Vixie cron): *"If both fields are restricted … the command will be run when either
 * field matches the current time."* The DST transition instants come from the IANA tz database as
 * this runtime's own `Intl` reports it — measured rather than remembered, and each zoned case
 * asserts the **wall-clock reading** beside the instant so an off-by-an-hour cannot pass.
 *
 * Measured transitions (America/New_York 2026, Europe/London 2026):
 *   2026-03-08T07:00Z  −05:00 → −04:00   local 01:59 → 03:00   (02:00–02:59 does not exist)
 *   2026-11-01T06:00Z  −04:00 → −05:00   local 01:59 → 01:00   (01:00–01:59 happens twice)
 *   2026-03-29T01:00Z  +00:00 → +01:00   local 00:59 → 02:00   (01:00–01:59 does not exist)
 *   2026-10-25T01:00Z  +01:00 → +00:00   local 01:59 → 01:00   (01:00–01:59 happens twice)
 */
describe("resolveTimerFireAt — cron_schedule", () => {
  function cron(expression: string, timezone = "UTC"): TimerDefinition {
    return timer({ kind: "cron_schedule", relativeSeconds: null, cronExpression: expression, timezone });
  }

  function next(expression: string, from: string, timezone = "UTC"): string | null {
    const r = resolveTimerFireAt(cron(expression, timezone), { now: new Date(from), variables: {} });
    return r.ok ? r.fireAt : null;
  }

  const cases: readonly [string, string, string, string][] = [
    // expression, timezone, from, expected next instant
    ["*/15 * * * *", "UTC", "2026-05-16T12:00:00.000Z", "2026-05-16T12:15:00.000Z"],
    ["*/15 * * * *", "UTC", "2026-05-16T12:50:00.000Z", "2026-05-16T13:00:00.000Z"],
    ["0 2 * * *", "UTC", "2026-05-16T12:00:00.000Z", "2026-05-17T02:00:00.000Z"],
    // Month end: February has no 31st, so the next 31st is March's.
    ["0 0 31 * *", "UTC", "2026-01-31T12:00:00.000Z", "2026-03-31T00:00:00.000Z"],
    // Leap day, inside the evaluator's horizon.
    ["0 0 29 2 *", "UTC", "2024-02-01T00:00:00.000Z", "2024-02-29T00:00:00.000Z"],
    // Half-hour offset, no DST: 02:00 IST on the 17th.
    ["0 2 * * *", "Asia/Kolkata", "2026-05-16T00:00:00.000Z", "2026-05-16T20:30:00.000Z"],
    // Spring forward, New York: 01:00 exists on the transition day.
    ["0 1 * * *", "America/New_York", "2026-03-07T12:00:00.000Z", "2026-03-08T06:00:00.000Z"],
    // Spring forward, New York: 02:00 does **not** exist on 2026-03-08, so that day is skipped.
    ["0 2 * * *", "America/New_York", "2026-03-07T12:00:00.000Z", "2026-03-09T06:00:00.000Z"],
    // Spring forward, London: 01:30 does not exist on 2026-03-29.
    ["30 1 * * *", "Europe/London", "2026-03-28T12:00:00.000Z", "2026-03-30T00:30:00.000Z"],
    // Fall back, New York: the first of the two local 01:30s.
    ["30 1 * * *", "America/New_York", "2026-11-01T00:00:00.000Z", "2026-11-01T05:30:00.000Z"],
    // Fall back, London: the first of the two local 01:30s.
    ["30 1 * * *", "Europe/London", "2026-10-25T00:00:00.000Z", "2026-10-25T00:30:00.000Z"],
    // Six-field (seconds) expressions are accepted by `CronExpressionSchema`.
    ["*/30 * * * * *", "UTC", "2026-05-16T12:00:00.000Z", "2026-05-16T12:00:30.000Z"],
  ];

  for (const [expression, timezone, from, expected] of cases) {
    it(`${expression} @ ${timezone} after ${from} → ${expected}`, () => {
      expect(next(expression, from, timezone)).toBe(expected);
    });
  }

  it("skips a wall-clock hour that does not exist on the spring-forward day", () => {
    const fired = next("0 2 * * *", "2026-03-07T12:00:00.000Z", "America/New_York");
    expect(fired).toBe("2026-03-09T06:00:00.000Z");
    expect(wall(fired!, "America/New_York")).toBe("03/09/2026, 02:00");
    // The skipped day is the decision: 2026-03-08 has no local 02:00 at all, so a `0 2 * * *` timer
    // does not fire that day rather than firing at 01:00 or 03:00 — neither of which was declared.
    for (let m = 0; m < 24 * 60; m += 1) {
      const instant = new Date(Date.parse("2026-03-08T00:00:00Z") + m * 60_000);
      expect(wall(instant.toISOString(), "America/New_York")).not.toBe("03/08/2026, 02:00");
    }
  });

  it("fires twice on the fall-back day, because the wall-clock minute happens twice", () => {
    const first = next("30 1 * * *", "2026-11-01T00:00:00.000Z", "America/New_York");
    expect(first).toBe("2026-11-01T05:30:00.000Z");
    const second = resolveNextTimerFireAt(cron("30 1 * * *", "America/New_York"), {
      after: new Date(first!),
    });
    expect(second?.ok === true && second.fireAt).toBe("2026-11-01T06:30:00.000Z");
    // Both instants read 01:30 locally — two occurrences of one declared wall-clock time, an hour
    // apart. The platform's job scheduler answers the same way (`scheduledJobsDue` keys idempotency
    // on the tick instant), so one evaluator gives one answer across both surfaces.
    expect(wall(first!, "America/New_York")).toBe("11/01/2026, 01:30");
    expect(wall("2026-11-01T06:30:00.000Z", "America/New_York")).toBe("11/01/2026, 01:30");
  });

  it("agrees with the platform's own cron evaluator rather than reimplementing it", () => {
    for (const [expression, timezone, from] of cases) {
      expect(next(expression, from, timezone)).toBe(
        cronNextAfter(expression, new Date(from), evaluatorTimezone(timezone))?.toISOString() ?? null,
      );
    }
  });

  it("refuses a declaration with no cronExpression", () => {
    const r = resolveTimerFireAt(timer({ kind: "cron_schedule", relativeSeconds: null }), {
      now: NOW,
      variables: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.defect).toBe("cron_expression_undeclared");
  });

  it("refuses an unparsable expression", () => {
    const r = resolveTimerFireAt(cron("0 99 * * *"), { now: NOW, variables: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.defect).toBe("cron_expression_unparsable");
  });

  it("refuses an expression with no occurrence inside the search horizon", () => {
    // 29 February is four years away from 2024-03-01, past the evaluator's ~382-day search.
    const r = resolveTimerFireAt(cron("0 0 29 2 *"), {
      now: new Date("2024-03-01T00:00:00.000Z"),
      variables: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.defect).toBe("cron_no_occurrence_in_horizon");
  });

  it("applies crontab(5)'s OR rule when both day fields are restricted", () => {
    // `0 0 13 * 5` — the 13th **or** a Friday. 2026-02-06 is a Friday and comes before the 13th.
    const fired = next("0 0 13 * 5", "2026-02-01T00:00:00.000Z");
    expect(fired).toBe("2026-02-06T00:00:00.000Z");
    expect(new Date(fired!).getUTCDay()).toBe(5);
    // With day-of-week unrestricted the same month fires on the 13th only.
    expect(next("0 0 13 * *", "2026-02-01T00:00:00.000Z")).toBe("2026-02-13T00:00:00.000Z");
  });

  it("is strictly after its argument, so a late fire cannot re-qualify immediately", () => {
    const at = "2026-05-16T12:00:00.000Z";
    const r = resolveNextTimerFireAt(cron("0 * * * *"), { after: new Date(at) });
    expect(r?.ok === true && r.fireAt).toBe("2026-05-16T13:00:00.000Z");
  });
});

describe("resolveNextTimerFireAt", () => {
  it("answers null for every kind that fires once — the contract, not a gap", () => {
    for (const kind of TIMER_KINDS.filter((k: TimerKind) => !isRecurringTimerKind(k))) {
      expect(
        resolveNextTimerFireAt(
          timer({ kind, absoluteTimestampVariable: "x", relativeSeconds: 60 }),
          { after: NOW },
        ),
      ).toBeNull();
    }
  });

  it("refuses an unresolvable zone on a recurring timer", () => {
    const r = resolveNextTimerFireAt(
      timer({ kind: "cron_schedule", relativeSeconds: null, cronExpression: "0 2 * * *", timezone: "Erope/London" }),
      { after: NOW },
    );
    expect(r?.ok).toBe(false);
    if (r !== null && !r.ok) expect(r.defect).toBe("timezone_unresolvable");
  });

  it("refuses a recurring timer with no expression to recur on", () => {
    const r = resolveNextTimerFireAt(timer({ kind: "cron_schedule", relativeSeconds: null }), {
      after: NOW,
    });
    expect(r?.ok).toBe(false);
    if (r !== null && !r.ok) expect(r.defect).toBe("cron_expression_undeclared");
  });
});

describe("evaluatorTimezone", () => {
  it("hands a UTC-equivalent zone over as undefined, selecting the evaluator's UTC field reader", () => {
    for (const zone of ["UTC", "Etc/UTC", "Etc/GMT", "GMT", "Universal", "Zulu", "Etc/Greenwich"]) {
      expect(evaluatorTimezone(zone)).toBeUndefined();
    }
  });

  it("does not treat Europe/London as UTC, because BST exists", () => {
    expect(evaluatorTimezone("Europe/London")).toBe("Europe/London");
    expect(evaluatorTimezone("America/New_York")).toBe("America/New_York");
  });

  it("every zone it elides really is UTC at every month of a year", () => {
    // The substitution is only sound if the two field readers agree, so this asserts it rather than
    // asserting the list. A zone with any offset or DST transition inside a cron horizon fails here.
    for (const zone of ["UTC", "Etc/UTC", "Etc/GMT", "GMT", "Universal", "Zulu", "Etc/Greenwich"]) {
      for (let month = 0; month < 12; month += 1) {
        const instant = new Date(Date.UTC(2026, month, 15, 13, 45)).toISOString();
        const asZone = wall(instant, zone);
        const asUtc = wall(instant, "UTC");
        expect(asZone, `${zone} @ month ${String(month)}`).toBe(asUtc);
      }
    }
  });

  it("gives the identical answer through both paths", () => {
    const expr = "0 2 * * *";
    const from = new Date("2026-05-16T12:00:00.000Z");
    expect(cronNextAfter(expr, from, undefined)?.toISOString()).toBe(
      cronNextAfter(expr, from, "UTC")?.toISOString(),
    );
  });
});
