import { describe, expect, it } from "vitest";
import {
  TIMER_KINDS,
  TIMER_STATUSES,
  TIMER_TRANSITIONS,
  WorkflowTimerSchema,
  cancelTimer,
  canTransitionTimer,
  fireTimer,
  isTimerDue,
  isWithinBusinessHours,
  type WorkflowTimer,
} from "./timers.js";

const baseTimer: WorkflowTimer = {
  id: "wft_review01",
  instanceId: "wfi_pr00000001",
  tenantId: "11111111-1111-1111-1111-111111111111",
  timerName: "review_deadline",
  kind: "relative_after",
  status: "scheduled",
  scheduledAt: "2026-05-16T10:00:00.000Z",
  fireAt: "2026-05-17T10:00:00.000Z",
  timezone: "UTC",
  cronExpression: null,
  relativeSeconds: 86_400,
  firedAt: null,
  cancelledAt: null,
  cancelledReason: null,
  expiredAt: null,
  transitionToTrigger: "escalate_to_director",
  fireCount: 0,
  nextFireAt: null,
};

describe("constants", () => {
  it("has 4 timer kinds", () => {
    expect(TIMER_KINDS).toHaveLength(4);
  });
  it("has 4 timer statuses", () => {
    expect(TIMER_STATUSES).toHaveLength(4);
  });
});

describe("canTransitionTimer", () => {
  it("allows scheduled → fired", () => {
    expect(canTransitionTimer("scheduled", "fired")).toBe(true);
  });
  it("blocks fired → scheduled (no rewind)", () => {
    expect(canTransitionTimer("fired", "scheduled")).toBe(false);
  });
  it("fired is terminal", () => {
    expect(TIMER_TRANSITIONS.fired).toEqual([]);
  });
});

describe("WorkflowTimerSchema", () => {
  it("accepts a scheduled relative_after timer", () => {
    expect(() => WorkflowTimerSchema.parse(baseTimer)).not.toThrow();
  });

  it("rejects fireAt <= scheduledAt", () => {
    expect(() =>
      WorkflowTimerSchema.parse({
        ...baseTimer,
        fireAt: baseTimer.scheduledAt,
      }),
    ).toThrow(/fireAt must be after scheduledAt/);
  });

  it("rejects cron_schedule without cronExpression", () => {
    expect(() =>
      WorkflowTimerSchema.parse({
        ...baseTimer,
        kind: "cron_schedule",
        relativeSeconds: null,
      }),
    ).toThrow(/cron_schedule timer requires cronExpression/);
  });

  it("rejects relative_after without relativeSeconds", () => {
    expect(() =>
      WorkflowTimerSchema.parse({
        ...baseTimer,
        relativeSeconds: null,
      }),
    ).toThrow(/relative_after timer requires relativeSeconds/);
  });

  it("rejects fired status without firedAt", () => {
    expect(() =>
      WorkflowTimerSchema.parse({
        ...baseTimer,
        status: "fired",
        fireCount: 1,
      }),
    ).toThrow(/firedAt/);
  });

  it("rejects cancelled without cancelledReason", () => {
    expect(() =>
      WorkflowTimerSchema.parse({
        ...baseTimer,
        status: "cancelled",
        cancelledAt: "2026-05-16T11:00:00.000Z",
      }),
    ).toThrow(/cancelledReason/);
  });

  it("rejects non-cron timer with fireCount > 1", () => {
    expect(() =>
      WorkflowTimerSchema.parse({
        ...baseTimer,
        status: "fired",
        firedAt: "2026-05-17T10:00:00.000Z",
        fireCount: 2,
      }),
    ).toThrow(/non-cron timers fire at most once/);
  });

  it("rejects fired cron_schedule timer without nextFireAt", () => {
    expect(() =>
      WorkflowTimerSchema.parse({
        ...baseTimer,
        kind: "cron_schedule",
        cronExpression: "0 9 * * *",
        relativeSeconds: null,
        status: "fired",
        firedAt: "2026-05-17T09:00:00.000Z",
        fireCount: 1,
      }),
    ).toThrow(/nextFireAt/);
  });
});

describe("isTimerDue", () => {
  it("returns true past fireAt", () => {
    expect(isTimerDue(baseTimer, new Date("2026-05-17T11:00:00Z"))).toBe(true);
  });
  it("returns false before fireAt", () => {
    expect(isTimerDue(baseTimer, new Date("2026-05-16T20:00:00Z"))).toBe(false);
  });
  it("returns false for fired timer", () => {
    expect(
      isTimerDue(
        {
          ...baseTimer,
          status: "fired",
          firedAt: "2026-05-17T10:00:00.000Z",
          fireCount: 1,
        },
        new Date("2026-05-17T11:00:00Z"),
      ),
    ).toBe(false);
  });
});

describe("fireTimer", () => {
  it("transitions scheduled → fired and increments fireCount", () => {
    const r = fireTimer(baseTimer, new Date("2026-05-17T10:00:00Z"), null);
    expect(r.status).toBe("fired");
    expect(r.fireCount).toBe(1);
  });

  it("requires nextFireAt for cron_schedule timer", () => {
    expect(() =>
      fireTimer(
        {
          ...baseTimer,
          kind: "cron_schedule",
          cronExpression: "0 9 * * *",
          relativeSeconds: null,
        },
        new Date("2026-05-17T09:00:00Z"),
        null,
      ),
    ).toThrow(/nextFireAt/);
  });

  it("sets nextFireAt on cron timer fire", () => {
    const r = fireTimer(
      {
        ...baseTimer,
        kind: "cron_schedule",
        cronExpression: "0 9 * * *",
        relativeSeconds: null,
      },
      new Date("2026-05-17T09:00:00Z"),
      "2026-05-18T09:00:00.000Z",
    );
    expect(r.nextFireAt).toBe("2026-05-18T09:00:00.000Z");
  });
});

describe("cancelTimer", () => {
  it("transitions scheduled → cancelled", () => {
    const r = cancelTimer(
      baseTimer,
      "user_cancelled_request",
      new Date("2026-05-16T15:00:00Z"),
    );
    expect(r.status).toBe("cancelled");
    expect(r.cancelledReason).toBe("user_cancelled_request");
  });

  it("throws on already-fired timer", () => {
    expect(() =>
      cancelTimer(
        {
          ...baseTimer,
          status: "fired",
          firedAt: "2026-05-17T10:00:00.000Z",
          fireCount: 1,
        },
        "too_late",
        new Date(),
      ),
    ).toThrow();
  });
});

describe("isWithinBusinessHours", () => {
  it("returns true Mon 10:00 with M-F 9-17", () => {
    expect(
      isWithinBusinessHours(
        {
          startMinutesSinceMidnight: 9 * 60,
          endMinutesSinceMidnight: 17 * 60,
          workdays: [1, 2, 3, 4, 5],
        },
        { minutesSinceMidnight: 10 * 60, dayOfWeek: 1 },
      ),
    ).toBe(true);
  });

  it("returns false Sat 10:00 with M-F 9-17", () => {
    expect(
      isWithinBusinessHours(
        {
          startMinutesSinceMidnight: 9 * 60,
          endMinutesSinceMidnight: 17 * 60,
          workdays: [1, 2, 3, 4, 5],
        },
        { minutesSinceMidnight: 10 * 60, dayOfWeek: 6 },
      ),
    ).toBe(false);
  });

  it("returns false Mon 18:00 (after hours)", () => {
    expect(
      isWithinBusinessHours(
        {
          startMinutesSinceMidnight: 9 * 60,
          endMinutesSinceMidnight: 17 * 60,
          workdays: [1, 2, 3, 4, 5],
        },
        { minutesSinceMidnight: 18 * 60, dayOfWeek: 1 },
      ),
    ).toBe(false);
  });
});
