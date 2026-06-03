import { describe, expect, it } from "vitest";
import {
  RequestOutcomeSchema,
  RollingWindow,
  failureRate,
  percentile,
} from "./window.js";

const base = Date.parse("2026-06-02T12:00:00.000Z");
const iso = (offsetMs: number): string => new Date(base + offsetMs).toISOString();

describe("RequestOutcomeSchema", () => {
  it("accepts a minimal ok outcome", () => {
    const parsed = RequestOutcomeSchema.parse({
      surface: "POST /v1/orders",
      outcome: "ok",
      at: iso(0),
    });
    expect(parsed.outcome).toBe("ok");
  });

  it("accepts a 5xx error outcome", () => {
    const parsed = RequestOutcomeSchema.parse({
      surface: "POST /v1/orders",
      outcome: "error",
      at: iso(0),
      statusCode: 503,
      latencyMs: 12,
    });
    expect(parsed.statusCode).toBe(503);
  });

  it("rejects a 5xx status reported as ok", () => {
    const res = RequestOutcomeSchema.safeParse({
      surface: "s",
      outcome: "ok",
      at: iso(0),
      statusCode: 500,
    });
    expect(res.success).toBe(false);
  });

  it("allows a 4xx status to be ok", () => {
    const res = RequestOutcomeSchema.safeParse({
      surface: "s",
      outcome: "ok",
      at: iso(0),
      statusCode: 404,
    });
    expect(res.success).toBe(true);
  });

  it("rejects unknown keys", () => {
    const res = RequestOutcomeSchema.safeParse({
      surface: "s",
      outcome: "ok",
      at: iso(0),
      extra: 1,
    });
    expect(res.success).toBe(false);
  });
});

describe("failureRate", () => {
  it("is 0 for an empty window", () => {
    expect(failureRate({ total: 0, failed: 0 })).toBe(0);
  });
  it("computes the ratio", () => {
    expect(failureRate({ total: 200, failed: 50 })).toBeCloseTo(0.25);
  });
});

describe("RollingWindow", () => {
  const ok = { surface: "s", outcome: "ok" as const };
  const err = { surface: "s", outcome: "error" as const };

  it("counts outcomes inside the window only", () => {
    const w = new RollingWindow();
    w.record({ ...err, at: iso(-10 * 60_000) });
    w.record({ ...ok, at: iso(-60_000) });
    w.record({ ...err, at: iso(-1_000) });
    const counts = w.count("s", 5 * 60_000, base);
    expect(counts.total).toBe(2);
    expect(counts.failed).toBe(1);
  });

  it("returns zero counts for an unknown surface", () => {
    const w = new RollingWindow();
    expect(w.count("nope", 60_000, base)).toEqual({ total: 0, failed: 0 });
  });

  it("ignores samples in the future", () => {
    const w = new RollingWindow();
    w.record({ ...ok, at: iso(60_000) });
    expect(w.count("s", 5 * 60_000, base).total).toBe(0);
  });

  it("prunes samples beyond retention", () => {
    const w = new RollingWindow({ retentionMs: 60_000 });
    w.record({ ...ok, at: iso(-120_000) });
    w.record({ ...ok, at: iso(-1_000) });
    w.prune(base);
    expect(w.count("s", 10 * 60_000, base).total).toBe(1);
  });

  it("caps samples per surface", () => {
    const w = new RollingWindow({ maxSamplesPerSurface: 3 });
    for (let i = 0; i < 10; i += 1) w.record({ ...ok, at: iso(-i * 1_000) });
    expect(w.count("s", 60 * 60_000, base).total).toBeLessThanOrEqual(3);
  });

  it("tracks distinct surfaces", () => {
    const w = new RollingWindow();
    w.record({ surface: "a", outcome: "ok", at: iso(0) });
    w.record({ surface: "b", outcome: "ok", at: iso(0) });
    expect([...w.surfaces()].sort()).toEqual(["a", "b"]);
  });

  it("rejects an unparseable timestamp", () => {
    const w = new RollingWindow();
    expect(() => w.record({ surface: "s", outcome: "ok", at: "not-a-date" })).toThrow();
  });

  it("rejects a non-positive window", () => {
    const w = new RollingWindow();
    expect(() => w.count("s", 0, base)).toThrow();
  });
});

describe("percentile", () => {
  const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  it("returns null for an empty list", () => {
    expect(percentile([], 95)).toBeNull();
  });
  it("computes nearest-rank percentiles", () => {
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(100);
    expect(percentile(sorted, 90)).toBe(90);
  });
  it("clamps p<=0 and p>=100 to the extremes", () => {
    expect(percentile(sorted, 0)).toBe(10);
    expect(percentile(sorted, 100)).toBe(100);
  });
});

describe("RollingWindow.latencyStats", () => {
  it("computes p50/p95/p99 over latency samples in the window", () => {
    const w = new RollingWindow();
    for (let i = 1; i <= 100; i += 1) {
      w.record({ surface: "s", outcome: "ok", at: iso(-i), latencyMs: i });
    }
    const stats = w.latencyStats("s", 60 * 60_000, base);
    expect(stats.count).toBe(100);
    expect(stats.p50).toBe(50);
    expect(stats.p95).toBe(95);
    expect(stats.p99).toBe(99);
  });

  it("only counts samples that carry latency", () => {
    const w = new RollingWindow();
    w.record({ surface: "s", outcome: "ok", at: iso(-1_000) });
    w.record({ surface: "s", outcome: "ok", at: iso(-2_000), latencyMs: 42 });
    const stats = w.latencyStats("s", 60 * 60_000, base);
    expect(stats.count).toBe(1);
    expect(stats.p50).toBe(42);
  });

  it("returns nulls for an unknown surface", () => {
    expect(new RollingWindow().latencyStats("nope", 60_000, base)).toEqual({
      p50: null,
      p95: null,
      p99: null,
      count: 0,
    });
  });

  it("excludes latency samples outside the window", () => {
    const w = new RollingWindow();
    w.record({ surface: "s", outcome: "ok", at: iso(-10 * 60_000), latencyMs: 999 });
    w.record({ surface: "s", outcome: "ok", at: iso(-1_000), latencyMs: 50 });
    const stats = w.latencyStats("s", 5 * 60_000, base);
    expect(stats.count).toBe(1);
    expect(stats.p99).toBe(50);
  });
});
