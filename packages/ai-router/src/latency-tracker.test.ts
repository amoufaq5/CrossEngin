import { describe, expect, it } from "vitest";

import { InMemoryLatencyTracker } from "./latency-tracker.js";

describe("InMemoryLatencyTracker", () => {
  it("returns zero stats with no samples", async () => {
    const t = new InMemoryLatencyTracker();
    const s = await t.stats("anthropic");
    expect(s.samples).toBe(0);
    expect(s.p50Ms).toBe(0);
    expect(s.p95Ms).toBe(0);
  });

  it("records samples and computes percentiles", async () => {
    const t = new InMemoryLatencyTracker();
    for (const ms of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
      await t.record({ providerId: "anthropic", latencyMs: ms, success: true });
    }
    const s = await t.stats("anthropic");
    expect(s.samples).toBe(10);
    expect(s.successes).toBe(10);
    expect(s.failures).toBe(0);
    expect(s.p50Ms).toBeGreaterThanOrEqual(50);
    expect(s.p95Ms).toBeGreaterThanOrEqual(90);
  });

  it("counts failures separately", async () => {
    const t = new InMemoryLatencyTracker();
    await t.record({ providerId: "x", latencyMs: 10, success: true });
    await t.record({ providerId: "x", latencyMs: 20, success: false });
    await t.record({ providerId: "x", latencyMs: 30, success: false });
    const s = await t.stats("x");
    expect(s.successes).toBe(1);
    expect(s.failures).toBe(2);
  });

  it("respects windowSize", async () => {
    const t = new InMemoryLatencyTracker({ windowSize: 3 });
    for (const ms of [1, 2, 3, 4, 5]) {
      await t.record({ providerId: "x", latencyMs: ms, success: true });
    }
    expect((await t.stats("x")).samples).toBe(3);
  });

  it("isolates providers", async () => {
    const t = new InMemoryLatencyTracker();
    await t.record({ providerId: "a", latencyMs: 100, success: true });
    await t.record({ providerId: "b", latencyMs: 500, success: true });
    expect((await t.stats("a")).p50Ms).toBe(100);
    expect((await t.stats("b")).p50Ms).toBe(500);
  });
});
