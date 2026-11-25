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

  readonly reserveCalls: Array<AddCall & { readonly limit: number }> = [];
  failReserve = false;

  async reserveMonthly(
    tenantId: string,
    periodKey: string,
    dollars: number,
    limitDollars: number,
  ): Promise<{ reserved: boolean; dollarsUsed: number | null }> {
    this.reserveCalls.push({ tenantId, periodKey, dollars, limit: limitDollars });
    if (this.failReserve) throw new Error("ledger unavailable");
    const key = `${tenantId}|${periodKey}`;
    const next = (this.totals.get(key) ?? 0) + dollars;
    if (next > limitDollars) return { reserved: false, dollarsUsed: null };
    this.totals.set(key, next);
    return { reserved: true, dollarsUsed: next };
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

  it("carries no per-request ceiling: that one is the designer's, which is the only thing that reads it", () => {
    // It used to: `maxUsdPerRequest` was accepted here, surfaced on the budget, and read by nothing,
    // so the shipped `--ai-max-request-dollars 2` enforced nothing (M-16). The designer takes
    // `maxRequestDollars` directly now, and a second spelling here would be a second place to set
    // a ceiling that is not enforced.
    const budget = buildAiDesignBudget({
      store: new FakeStore(),
      maxUsdPerMonth: 25,
      // @ts-expect-error the option was removed with its last reader
      maxUsdPerRequest: 0.5,
    });
    expect("maxUsdPerRequest" in budget).toBe(false);
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
    expect(check).toEqual({ allowed: true, reason: "ok", spentUsd: 10, limitUsd: 25, remainingUsd: 15 });
  });

  it("denies at exactly the ceiling", async () => {
    const store = new FakeStore();
    store.seed(TENANT, "2026-08", 25);
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 25, now: fixedNow(FIXED) });
    const check = await budget.check(TENANT);
    expect(check).toEqual({
      allowed: false,
      reason: "month_exceeded",
      spentUsd: 25,
      limitUsd: 25,
      remainingUsd: 0,
    });
  });

  it("denies over the ceiling and never reports a negative remaining", async () => {
    const store = new FakeStore();
    store.seed(TENANT, "2026-08", 40);
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 25, now: fixedNow(FIXED) });
    const check = await budget.check(TENANT);
    expect(check).toMatchObject({ allowed: false, reason: "month_exceeded", spentUsd: 40, remainingUsd: 0 });
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

  // This test used to pin the defect as the specification: an unreadable ledger answered
  // `month_exceeded` with `spentUsd: 25`, a figure nobody had read (ADR-0372's class; ADR-0470).
  it("fails closed when the store throws, as unavailable and with no spend figure", async () => {
    const store = new FakeStore();
    store.failGet = true;
    const denials: Array<[string, number, number]> = [];
    const unavailable: string[] = [];
    const budget = buildAiDesignBudget({
      store,
      maxUsdPerMonth: 25,
      now: fixedNow(FIXED),
      onDenied: (tenantId, spentUsd, limitUsd) => denials.push([tenantId, spentUsd, limitUsd]),
      onUnavailable: (tenantId) => unavailable.push(tenantId),
    });
    const check = await budget.check(TENANT);
    expect(check).toEqual({ allowed: false, reason: "unavailable", limitUsd: 25 });
    expect("spentUsd" in check).toBe(false);
    // Not reported as a spent month: the denial channel is for a figure that was read.
    expect(denials).toEqual([]);
    expect(unavailable).toEqual([TENANT]);
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

describe("the month is charged through reserve and settle, and nothing else", () => {
  // `record` charged the month after the call, swallowed a failed write and returned 0, and was the
  // only thing that moved the ledger: a design whose write failed was never charged (M-16). It is
  // gone, and these are its cases restated against the one path that charges now.
  it("has no after-the-fact record", () => {
    const budget = buildAiDesignBudget({ store: new FakeStore(), maxUsdPerMonth: 25 });
    expect("record" in budget).toBe(false);
  });

  it("accumulates settled spend across designs", async () => {
    const store = new FakeStore();
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 25, now: fixedNow(FIXED) });
    await (await budget.reserve(TENANT, 3))?.settle(3);
    await (await budget.reserve(TENANT, 4.5))?.settle(4.5);
    expect(store.totals.get(`${TENANT}|2026-08`)).toBe(7.5);
    expect(store.addCalls).toEqual([]);
  });

  it("flips a subsequent check to denied once the ceiling is reached", async () => {
    const store = new FakeStore();
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 10, now: fixedNow(FIXED) });
    await expect(budget.check(TENANT)).resolves.toMatchObject({ allowed: true });
    await (await budget.reserve(TENANT, 6))?.settle(6);
    await expect(budget.check(TENANT)).resolves.toMatchObject({ allowed: true, remainingUsd: 4 });
    await (await budget.reserve(TENANT, 4))?.settle(4);
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
    await (await budget.reserve(TENANT, 25))?.settle(25);
    await expect(budget.check(TENANT)).resolves.toMatchObject({ allowed: false, spentUsd: 25 });
    clock = new Date("2026-09-01T00:00:00.000Z");
    await expect(budget.check(TENANT)).resolves.toMatchObject({
      allowed: true,
      spentUsd: 0,
      remainingUsd: 25,
    });
    expect(store.getCalls.at(-1)?.periodKey).toBe("2026-09");
  });

  it("writes nothing to settle a call that cost exactly its reservation", async () => {
    const store = new FakeStore();
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 25, now: fixedNow(FIXED) });
    await (await budget.reserve(TENANT, 2))?.settle(2);
    expect(store.addCalls).toEqual([]);
  });

  it("reserves nothing for a zero, negative or non-finite estimate, and settles a junk actual as 0", async () => {
    const store = new FakeStore();
    store.seed(TENANT, "2026-08", 5);
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 25, now: fixedNow(FIXED) });
    for (const bad of [0, -12, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = await budget.reserve(TENANT, bad);
      expect(r?.dollars).toBe(0);
      await r?.settle(Number.NaN);
    }
    expect(store.reserveCalls.map((c) => c.dollars)).toEqual([0, 0, 0, 0]);
    expect(store.addCalls).toEqual([]);
    expect(store.totals.get(`${TENANT}|2026-08`)).toBe(5);
  });

  it("propagates a settle that cannot be written, so the caller knows the reservation stands", async () => {
    const store = new FakeStore();
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 25, now: fixedNow(FIXED) });
    const r = await budget.reserve(TENANT, 4);
    store.failAdd = true;
    await expect(r?.settle(1)).rejects.toThrow(/ledger unavailable/);
    // The over-count stands, which is the safe direction for a ceiling.
    expect(store.totals.get(`${TENANT}|2026-08`)).toBe(4);
  });

  it("keeps tenants isolated in the ledger", async () => {
    const store = new FakeStore();
    const other = "22222222-2222-4222-8222-222222222222";
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 25, now: fixedNow(FIXED) });
    await (await budget.reserve(TENANT, 20))?.settle(20);
    await expect(budget.check(TENANT)).resolves.toMatchObject({ remainingUsd: 5 });
    await expect(budget.check(other)).resolves.toMatchObject({ spentUsd: 0, remainingUsd: 25 });
  });
});

describe("buildAiDesignBudget reserve", () => {
  it("reserves against the month and settles the difference to the actual cost", async () => {
    const store = new FakeStore();
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 10, now: fixedNow(FIXED) });
    const r = await budget.reserve(TENANT, 4);
    expect(r?.periodKey).toBe("2026-08");
    expect(store.reserveCalls).toEqual([{ tenantId: TENANT, periodKey: "2026-08", dollars: 4, limit: 10 }]);
    expect(store.totals.get(`${TENANT}|2026-08`)).toBe(4);
    await r?.settle(1.5);
    expect(store.totals.get(`${TENANT}|2026-08`)).toBeCloseTo(1.5, 9);
    await (await budget.reserve(TENANT, 2))?.settle(2);
    expect(store.addCalls.filter((c) => c.dollars !== -2.5)).toEqual([]);
  });

  it("refuses the reservation the month cannot absorb, and reports it", async () => {
    const store = new FakeStore();
    store.seed(TENANT, "2026-08", 9);
    const refused: number[] = [];
    const budget = buildAiDesignBudget({
      store,
      maxUsdPerMonth: 10,
      now: fixedNow(FIXED),
      onReservationRefused: (_t, estimate) => refused.push(estimate),
    });
    expect(await budget.reserve(TENANT, 1.01)).toBeNull();
    expect(refused).toEqual([1.01]);
    expect(store.totals.get(`${TENANT}|2026-08`)).toBe(9);
  });

  it("settles into the reservation's own month even when the clock has moved on", async () => {
    const store = new FakeStore();
    let now = new Date("2026-08-31T23:59:59.000Z");
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 10, now: () => now });
    const r = await budget.reserve(TENANT, 3);
    now = new Date("2026-09-01T00:00:01.000Z");
    await r?.settle(5);
    expect(store.addCalls).toEqual([{ tenantId: TENANT, periodKey: "2026-08", dollars: 2 }]);
  });

  it("propagates a ledger that cannot be written, so the designer refuses rather than spends", async () => {
    const store = new FakeStore();
    store.failReserve = true;
    const budget = buildAiDesignBudget({ store, maxUsdPerMonth: 10, now: fixedNow(FIXED) });
    await expect(budget.reserve(TENANT, 1)).rejects.toThrow(/ledger unavailable/);
  });
});
