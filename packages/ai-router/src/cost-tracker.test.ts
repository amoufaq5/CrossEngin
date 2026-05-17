import { describe, expect, it } from "vitest";

import { CostCeilingExceededError, InMemoryCostTracker } from "./cost-tracker.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

describe("InMemoryCostTracker.recordUsage + getWindow", () => {
  it("starts a new window on first usage", async () => {
    const clock = makeClock(0);
    const tracker = new InMemoryCostTracker({ windowSeconds: 60, clock });
    await tracker.recordUsage({ tenantId: TENANT, costUsd: 0.10 });
    const w = await tracker.getWindow(TENANT);
    expect(w?.costUsd).toBe(0.10);
    expect(w?.windowStartUnixMs).toBe(0);
  });

  it("accumulates usage within the same window", async () => {
    const clock = makeClock(0);
    const tracker = new InMemoryCostTracker({ windowSeconds: 60, clock });
    await tracker.recordUsage({ tenantId: TENANT, costUsd: 0.10 });
    clock.advance(30_000);
    await tracker.recordUsage({ tenantId: TENANT, costUsd: 0.20 });
    const w = await tracker.getWindow(TENANT);
    expect(w?.costUsd).toBeCloseTo(0.30, 6);
  });

  it("rolls over to a fresh window after expiry", async () => {
    const clock = makeClock(0);
    const tracker = new InMemoryCostTracker({ windowSeconds: 60, clock });
    await tracker.recordUsage({ tenantId: TENANT, costUsd: 1.0 });
    clock.advance(120_000);
    await tracker.recordUsage({ tenantId: TENANT, costUsd: 0.5 });
    const w = await tracker.getWindow(TENANT);
    expect(w?.costUsd).toBe(0.5);
  });

  it("isolates tenants", async () => {
    const tracker = new InMemoryCostTracker();
    await tracker.recordUsage({ tenantId: TENANT, costUsd: 1 });
    await tracker.recordUsage({ tenantId: "other", costUsd: 5 });
    expect((await tracker.getWindow(TENANT))?.costUsd).toBe(1);
    expect((await tracker.getWindow("other"))?.costUsd).toBe(5);
  });
});

describe("InMemoryCostTracker.checkCeiling", () => {
  it("blocks per-request when estimated > maxUsdPerRequest", async () => {
    const tracker = new InMemoryCostTracker();
    const check = await tracker.checkCeiling({
      tenantId: TENANT,
      estimatedCostUsd: 1.0,
      ceiling: { maxUsdPerRequest: 0.5 },
    });
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe("per_request_exceeded");
  });

  it("allows per-request when estimated <= maxUsdPerRequest", async () => {
    const tracker = new InMemoryCostTracker();
    const check = await tracker.checkCeiling({
      tenantId: TENANT,
      estimatedCostUsd: 0.4,
      ceiling: { maxUsdPerRequest: 0.5 },
    });
    expect(check.allowed).toBe(true);
  });

  it("blocks when window total + estimated > maxUsdPerWindow", async () => {
    const tracker = new InMemoryCostTracker();
    await tracker.recordUsage({ tenantId: TENANT, costUsd: 0.9 });
    const check = await tracker.checkCeiling({
      tenantId: TENANT,
      estimatedCostUsd: 0.2,
      ceiling: { maxUsdPerWindow: 1.0 },
    });
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe("window_exceeded");
    expect(check.currentWindowUsd).toBe(0.9);
  });

  it("returns Infinity limit when no window ceiling supplied", async () => {
    const tracker = new InMemoryCostTracker();
    const check = await tracker.checkCeiling({
      tenantId: TENANT,
      estimatedCostUsd: 9999,
      ceiling: {},
    });
    expect(check.allowed).toBe(true);
    expect(check.limitUsd).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("CostCeilingExceededError", () => {
  it("is non-retryable", () => {
    const err = new CostCeilingExceededError({
      allowed: false,
      reason: "per_request_exceeded",
      currentWindowUsd: 0,
      limitUsd: 1,
    });
    expect(err.isRetryable()).toBe(false);
    expect(err.kind).toBe("cost_ceiling_exceeded");
  });
});

function makeClock(start: number): (() => number) & { advance: (ms: number) => void } {
  let now = start;
  const fn = (() => now) as (() => number) & { advance: (ms: number) => void };
  fn.advance = (ms: number) => {
    now += ms;
  };
  return fn;
}
