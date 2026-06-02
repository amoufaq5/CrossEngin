import { describe, expect, it } from "vitest";
import {
  RequestOutcomeSchema,
  RollingWindow,
  failureRate,
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
