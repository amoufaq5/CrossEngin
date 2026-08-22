import { describe, expect, it } from "vitest";

import {
  DEFAULT_AI_DESIGN_MAX_USD_PER_MONTH,
  buildAiDesignBudget,
  type MonthlySpendStore,
} from "./ai-design-budget.js";

interface GetCall {
  readonly tenantId: string;
  readonly periodKey: string;
}
interface AddCall extends GetCall {
  readonly dollars: number;
}

class FakeStore implements MonthlySpendStore {
  readonly totals = new Map<string, number>();
  readonly getCalls: GetCall[] = [];
  readonly addCalls: AddCall[] = [];
  failGet = false;
  failAdd = false;

  seed(tenantId: string, periodKey: string, dollars: number): void {
    this.totals.set(`${tenantId}|${periodKey}`, dollars);
  }

  async getMonthly(tenantId: string, periodKey: string): Promise<number> {
    this.getCalls.push({ tenantId, periodKey });
    if (this.failGet) throw new Error("ledger unavailable");
    return this.totals.get(`${tenantId}|${periodKey}`) ?? 0;
  }

  async addMonthly(tenantId: string, periodKey: string, dollars: number): Promise<number> {
    this.addCalls.push({ tenantId, periodKey, dollars });
    if (this.failAdd) throw new Error("ledger unavailable");
    const key = `${tenantId}|${periodKey}`;
    const next = (this.totals.get(key) ?? 0) + dollars;
    this.totals.set(key, next);
    return next;
  }
}

const TENANT = "11111111-1111-4111-8111-111111111111";
const FIXED = new Date("2026-08-21T10:00:00.000Z");

function fixedNow(date: Date): () => Date {
  return () => date;
}

describe("DEFAULT_AI_DESIGN_MAX_USD_PER_MONTH", () => {
  it("is 25 USD", () => {
    expect(DEFAULT_AI_DESIGN_MAX_USD_PER_MONTH).toBe(25);
  });
});

describe("buildAiDesignBudget validation", () => {
  it("throws when maxUsdPerMonth is zero, negative, or non-finite", () => {
    const store = new FakeStore();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildAiDesignBudget({ store, maxUsdPerMonth: bad })).toThrow(/maxUsdPerMonth/);
    }
  });

  it("surfaces maxUsdPerRequest when configured", () => {
    const budget = buildAiDesignBudget({
      store: new FakeStore(),
      maxUsdPerMonth: 25,
      maxUsdPerRequest: 0.5,
    });
    expect(budget.maxUsdPerRequest).toBe(0.5);
  });

  it("reports maxUsdPerRequest as null when omitted", () => {
    const budget = buildAiDesignBudget({ store: new FakeStore(), maxUsdPerMonth: 25 });
    expect(budget.maxUsdPerRequest).toBeNull();
  });

  it("reports maxUsdPerRequest as null when non-positive", () => {
    const budget = buildAiDesignBudget({
      store: new FakeStore(),
      maxUsdPerMonth: 25,
      maxUsdPerRequest: 0,
    });
    expect(budget.maxUsdPerRequest).toBeNull();
  });
});

describe("check", () => {
  it("allows a tenant with no recorded spend and reports the full remaining", async () => {
    const store = new FakeStore();
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 25, now: fixedNow(FIXED) });
    await expect(budget.check(TENANT)).resolves.toEqual({
      allowed: true,
      reason: "ok",
      spentUsd: 0,
      limitUsd: 25,
      remainingUsd: 25,
    });
  });

  it("allows a tenant under budget with the correct remaining", async () => {
    const store = new FakeStore();
    store.seed(TENANT, "2026-08", 10);
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 25, now: fixedNow(FIXED) });
    const check = await budget.check(TENANT);
    expect(check.allowed).toBe(true);
    expect(check.reason).toBe("ok");
    expect(check.spentUsd).toBe(10);
    expect(check.remainingUsd).toBe(15);
  });

  it("denies at exactly the ceiling", async () => {
    const store = new FakeStore();
    store.seed(TENANT, "2026-08", 25);
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 25, now: fixedNow(FIXED) });
    const check = await budget.check(TENANT);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe("month_exceeded");
    expect(check.remainingUsd).toBe(0);
  });

  it("denies over the ceiling and never reports a negative remaining", async () => {
    const store = new FakeStore();
    store.seed(TENANT, "2026-08", 40);
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 25, now: fixedNow(FIXED) });
    const check = await budget.check(TENANT);
    expect(check.allowed).toBe(false);
    expect(check.spentUsd).toBe(40);
    expect(check.remainingUsd).toBe(0);
  });

  it("fires onDenied with the tenant, spend, and limit", async () => {
    const store = new FakeStore();
    store.seed(TENANT, "2026-08", 30);
    const denials: Array<[string, number, number]> = [];
    const budget = buildAiDesignBudget({
      store,
      maxUsdPerMonth: 25,
      now: fixedNow(FIXED),
      onDenied: (tenantId, spentUsd, limitUsd) => denials.push([tenantId, spentUsd, limitUsd]),
    });
    await budget.check(TENANT);
    expect(denials).toEqual([[TENANT, 30, 25]]);
  });

  it("does not fire onDenied while under budget", async () => {
    const store = new FakeStore();
    store.seed(TENANT, "2026-08", 1);
    let calls = 0;
    const budget = buildAiDesignBudget({
      store,
      maxUsdPerMonth: 25,
      now: fixedNow(FIXED),
      onDenied: () => {
        calls += 1;
      },
    });
    await budget.check(TENANT);
    expect(calls).toBe(0);
  });

  it("fails closed when the store throws", async () => {
    const store = new FakeStore();
    store.failGet = true;
    const denials: Array<[string, number, number]> = [];
    const budget = buildAiDesignBudget({
      store,
      maxUsdPerMonth: 25,
      now: fixedNow(FIXED),
      onDenied: (tenantId, spentUsd, limitUsd) => denials.push([tenantId, spentUsd, limitUsd]),
    });
    await expect(budget.check(TENANT)).resolves.toEqual({
      allowed: false,
      reason: "month_exceeded",
      spentUsd: 25,
      limitUsd: 25,
      remainingUsd: 0,
    });
    expect(denials).toEqual([[TENANT, 25, 25]]);
  });

  it("uses the default YYYY-MM period key in the store call", async () => {
    const store = new FakeStore();
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 25, now: fixedNow(FIXED) });
    await budget.check(TENANT);
    expect(store.getCalls).toEqual([{ tenantId: TENANT, periodKey: "2026-08" }]);
  });

  it("zero-pads a single-digit month in the default period key", async () => {
    const store = new FakeStore();
    const budget = buildAiDesignBudget({
      store,
      maxUsdPerMonth: 25,
      now: fixedNow(new Date("2026-01-05T00:00:00.000Z")),
    });
    await budget.check(TENANT);
    expect(store.getCalls[0]?.periodKey).toBe("2026-01");
  });

  it("uses a custom periodKeyFor when supplied", async () => {
    const store = new FakeStore();
    const budget = buildAiDesignBudget({
      store,
      maxUsdPerMonth: 25,
      now: fixedNow(FIXED),
      periodKeyFor: (date) => `week-${date.getUTCDate()}`,
    });
    await budget.check(TENANT);
    expect(store.getCalls[0]?.periodKey).toBe("week-21");
  });
});

describe("record", () => {
  it("accumulates spend and returns the new monthly total", async () => {
    const store = new FakeStore();
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 25, now: fixedNow(FIXED) });
    await expect(budget.record(TENANT, 3)).resolves.toBe(3);
    await expect(budget.record(TENANT, 4.5)).resolves.toBe(7.5);
    expect(store.addCalls).toEqual([
      { tenantId: TENANT, periodKey: "2026-08", dollars: 3 },
      { tenantId: TENANT, periodKey: "2026-08", dollars: 4.5 },
    ]);
  });

  it("flips a subsequent check to denied once the ceiling is crossed", async () => {
    const store = new FakeStore();
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 10, now: fixedNow(FIXED) });
    await expect(budget.check(TENANT)).resolves.toMatchObject({ allowed: true });
    await budget.record(TENANT, 6);
    await expect(budget.check(TENANT)).resolves.toMatchObject({ allowed: true, remainingUsd: 4 });
    await budget.record(TENANT, 6);
    await expect(budget.check(TENANT)).resolves.toMatchObject({
      allowed: false,
      reason: "month_exceeded",
      remainingUsd: 0,
    });
  });

  it("resets spend on a period rollover", async () => {
    const store = new FakeStore();
    let clock = new Date("2026-08-31T23:00:00.000Z");
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 25, now: () => clock });
    await budget.record(TENANT, 25);
    await expect(budget.check(TENANT)).resolves.toMatchObject({ allowed: false, spentUsd: 25 });
    clock = new Date("2026-09-01T00:00:00.000Z");
    await expect(budget.check(TENANT)).resolves.toMatchObject({
      allowed: true,
      spentUsd: 0,
      remainingUsd: 25,
    });
    expect(store.getCalls.at(-1)?.periodKey).toBe("2026-09");
  });

  it("does not write for a zero cost and returns the current total", async () => {
    const store = new FakeStore();
    store.seed(TENANT, "2026-08", 5);
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 25, now: fixedNow(FIXED) });
    await expect(budget.record(TENANT, 0)).resolves.toBe(5);
    expect(store.addCalls).toEqual([]);
  });

  it("does not write for a negative cost", async () => {
    const store = new FakeStore();
    store.seed(TENANT, "2026-08", 5);
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 25, now: fixedNow(FIXED) });
    await expect(budget.record(TENANT, -12)).resolves.toBe(5);
    expect(store.addCalls).toEqual([]);
  });

  it("does not write for NaN or Infinity", async () => {
    const store = new FakeStore();
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 25, now: fixedNow(FIXED) });
    await expect(budget.record(TENANT, Number.NaN)).resolves.toBe(0);
    await expect(budget.record(TENANT, Number.POSITIVE_INFINITY)).resolves.toBe(0);
    expect(store.addCalls).toEqual([]);
    expect(store.getCalls).toHaveLength(2);
  });

  it("resolves instead of throwing when the store write fails", async () => {
    const store = new FakeStore();
    store.failAdd = true;
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 25, now: fixedNow(FIXED) });
    await expect(budget.record(TENANT, 2)).resolves.toBe(0);
  });

  it("leaves a later check working after a failed write", async () => {
    const store = new FakeStore();
    store.seed(TENANT, "2026-08", 4);
    store.failAdd = true;
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 25, now: fixedNow(FIXED) });
    await budget.record(TENANT, 2);
    await expect(budget.check(TENANT)).resolves.toMatchObject({ allowed: true, spentUsd: 4 });
  });

  it("keeps tenants isolated in the ledger", async () => {
    const store = new FakeStore();
    const other = "22222222-2222-4222-8222-222222222222";
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 25, now: fixedNow(FIXED) });
    await budget.record(TENANT, 20);
    await expect(budget.check(TENANT)).resolves.toMatchObject({ remainingUsd: 5 });
    await expect(budget.check(other)).resolves.toMatchObject({ spentUsd: 0, remainingUsd: 25 });
  });
});
