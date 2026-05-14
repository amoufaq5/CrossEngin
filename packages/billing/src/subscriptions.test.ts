import { describe, expect, it } from "vitest";
import {
  canTransitionSubscription,
  daysInCurrentPeriod,
  daysIntoCurrentPeriod,
  isPayable,
  isWithinTrial,
  SubscriptionSchema,
} from "./subscriptions.js";

const now = "2026-05-13T10:00:00.000Z";

const baseSub = {
  id: "sub_1",
  tenantId: "t_1",
  planId: "operate-base-monthly",
  status: "active" as const,
  stripeCustomerId: "cus_abc",
  stripeSubscriptionId: "sub_abc",
  currentPeriodStart: "2026-05-01T00:00:00.000Z",
  currentPeriodEnd: "2026-06-01T00:00:00.000Z",
  trialEnd: null,
  cancelAtPeriodEnd: false,
  canceledAt: null,
  pausedAt: null,
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: now,
};

describe("SubscriptionSchema", () => {
  it("parses an active subscription", () => {
    expect(() => SubscriptionSchema.parse(baseSub)).not.toThrow();
  });

  it("rejects currentPeriodEnd <= currentPeriodStart", () => {
    expect(() =>
      SubscriptionSchema.parse({
        ...baseSub,
        currentPeriodEnd: baseSub.currentPeriodStart,
      }),
    ).toThrow(/must be after currentPeriodStart/);
  });

  it("requires trialEnd when status is trialing", () => {
    expect(() =>
      SubscriptionSchema.parse({ ...baseSub, status: "trialing" }),
    ).toThrow(/trialing subscriptions must declare trialEnd/);
  });

  it("requires canceledAt when status is canceled", () => {
    expect(() =>
      SubscriptionSchema.parse({ ...baseSub, status: "canceled" }),
    ).toThrow(/canceled subscriptions must declare canceledAt/);
  });

  it("requires pausedAt when status is paused", () => {
    expect(() =>
      SubscriptionSchema.parse({ ...baseSub, status: "paused" }),
    ).toThrow(/paused subscriptions must declare pausedAt/);
  });
});

describe("canTransitionSubscription", () => {
  it("active → past_due / paused / canceled", () => {
    expect(canTransitionSubscription("active", "past_due")).toBe(true);
    expect(canTransitionSubscription("active", "paused")).toBe(true);
    expect(canTransitionSubscription("active", "canceled")).toBe(true);
  });

  it("trialing → active / canceled / incomplete", () => {
    expect(canTransitionSubscription("trialing", "active")).toBe(true);
    expect(canTransitionSubscription("trialing", "canceled")).toBe(true);
  });

  it("canceled is terminal", () => {
    expect(canTransitionSubscription("canceled", "active")).toBe(false);
    expect(canTransitionSubscription("canceled", "trialing")).toBe(false);
  });

  it("active → trialing is forbidden", () => {
    expect(canTransitionSubscription("active", "trialing")).toBe(false);
  });
});

describe("daysIntoCurrentPeriod / daysInCurrentPeriod", () => {
  const sub = SubscriptionSchema.parse(baseSub);

  it("counts days from currentPeriodStart", () => {
    const at = new Date("2026-05-13T10:00:00.000Z");
    expect(daysIntoCurrentPeriod(sub, at)).toBe(12);
  });

  it("returns 0 before the period starts", () => {
    expect(daysIntoCurrentPeriod(sub, new Date("2026-04-01T00:00:00.000Z"))).toBe(0);
  });

  it("daysInCurrentPeriod computes the cycle length", () => {
    expect(daysInCurrentPeriod(sub)).toBe(31);
  });
});

describe("isWithinTrial", () => {
  it("returns false when trialEnd is null", () => {
    expect(isWithinTrial(SubscriptionSchema.parse(baseSub))).toBe(false);
  });

  it("returns true while inside the trial window", () => {
    const trialingSub = SubscriptionSchema.parse({
      ...baseSub,
      status: "trialing",
      trialEnd: "2026-06-01T00:00:00.000Z",
    });
    expect(isWithinTrial(trialingSub, new Date("2026-05-13T00:00:00.000Z"))).toBe(true);
    expect(isWithinTrial(trialingSub, new Date("2026-06-02T00:00:00.000Z"))).toBe(false);
  });
});

describe("isPayable", () => {
  it("active + trialing + past_due are payable", () => {
    expect(isPayable(SubscriptionSchema.parse({ ...baseSub, status: "active" }))).toBe(true);
    const trialing = SubscriptionSchema.parse({
      ...baseSub,
      status: "trialing",
      trialEnd: "2026-06-01T00:00:00.000Z",
    });
    expect(isPayable(trialing)).toBe(true);
  });

  it("canceled + paused are not payable", () => {
    expect(
      isPayable(
        SubscriptionSchema.parse({
          ...baseSub,
          status: "canceled",
          canceledAt: now,
        }),
      ),
    ).toBe(false);
  });
});
