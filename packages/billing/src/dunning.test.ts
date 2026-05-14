import { describe, expect, it } from "vitest";
import {
  canTransitionDunning,
  DEFAULT_DUNNING_POLICY,
  DunningPolicySchema,
  DunningStateSchema,
  nextActionAt,
  nextDunningStage,
} from "./dunning.js";

const now = "2026-05-13T10:00:00.000Z";

describe("DunningPolicySchema", () => {
  it("applies the ADR-0021 default 0/3/7/14/30 schedule", () => {
    expect(DEFAULT_DUNNING_POLICY.firstRetryAfterDays).toBe(3);
    expect(DEFAULT_DUNNING_POLICY.secondRetryAfterDays).toBe(7);
    expect(DEFAULT_DUNNING_POLICY.restrictAfterDays).toBe(14);
    expect(DEFAULT_DUNNING_POLICY.cancelAfterDays).toBe(30);
  });

  it("rejects out-of-order retry days", () => {
    expect(() =>
      DunningPolicySchema.parse({
        firstRetryAfterDays: 7,
        secondRetryAfterDays: 3,
        restrictAfterDays: 14,
        cancelAfterDays: 30,
      }),
    ).toThrow(/secondRetryAfterDays must be >/);
  });
});

describe("canTransitionDunning", () => {
  it("current → notified is allowed", () => {
    expect(canTransitionDunning("current", "notified")).toBe(true);
  });

  it("canceled is terminal", () => {
    expect(canTransitionDunning("canceled", "current")).toBe(false);
  });

  it("notified → retry_1 is allowed; → escalation is not", () => {
    expect(canTransitionDunning("notified", "retry_1")).toBe(true);
    expect(canTransitionDunning("notified", "escalation")).toBe(false);
  });

  it("any stage → canceled (except canceled itself)", () => {
    expect(canTransitionDunning("retry_2", "canceled")).toBe(true);
    expect(canTransitionDunning("escalation", "canceled")).toBe(true);
    expect(canTransitionDunning("restricted", "canceled")).toBe(true);
  });
});

describe("nextDunningStage", () => {
  it("advances current → notified on day 0", () => {
    expect(nextDunningStage("current", 0)).toBe("notified");
  });

  it("notified → retry_2 by day 3 (firstRetryAfterDays)", () => {
    expect(nextDunningStage("notified", 3)).toBe("retry_2");
  });

  it("→ escalation by day 7", () => {
    expect(nextDunningStage("retry_2", 7)).toBe("escalation");
  });

  it("→ restricted by day 14", () => {
    expect(nextDunningStage("escalation", 14)).toBe("restricted");
  });

  it("→ canceled by day 30", () => {
    expect(nextDunningStage("restricted", 30)).toBe("canceled");
  });

  it("canceled stays canceled", () => {
    expect(nextDunningStage("canceled", 100)).toBe("canceled");
  });
});

describe("nextActionAt", () => {
  it("returns null when failedSince is null", () => {
    const state = DunningStateSchema.parse({
      tenantId: "t",
      invoiceId: "i",
      stage: "current",
    });
    expect(nextActionAt(state)).toBeNull();
  });

  it("schedules retry_1 at firstRetryAfterDays past failedSince", () => {
    const state = DunningStateSchema.parse({
      tenantId: "t",
      invoiceId: "i",
      stage: "notified",
      failedSince: now,
    });
    const expected = new Date(new Date(now).getTime() + 3 * 86_400_000);
    expect(nextActionAt(state)?.toISOString()).toBe(expected.toISOString());
  });

  it("returns null for canceled state", () => {
    const state = DunningStateSchema.parse({
      tenantId: "t",
      invoiceId: "i",
      stage: "canceled",
      failedSince: now,
    });
    expect(nextActionAt(state)).toBeNull();
  });
});
