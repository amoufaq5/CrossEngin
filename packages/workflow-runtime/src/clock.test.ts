import { describe, expect, it } from "vitest";

import {
  CountingIdGenerator,
  FixedClock,
  RandomIdGenerator,
  SystemClock,
} from "./clock.js";

describe("SystemClock", () => {
  it("returns a recent Date from now()", () => {
    const c = new SystemClock();
    const before = Date.now();
    const got = c.now().getTime();
    const after = Date.now();
    expect(got).toBeGreaterThanOrEqual(before);
    expect(got).toBeLessThanOrEqual(after);
  });

  it("returns matching seconds + ISO from the same call", () => {
    const c = new SystemClock();
    expect(c.nowSeconds()).toBeGreaterThan(1_700_000_000);
    expect(c.nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("FixedClock", () => {
  it("returns its initial value from each accessor", () => {
    const initial = new Date("2026-05-16T12:00:00.000Z");
    const c = new FixedClock(initial);
    expect(c.now()).toEqual(initial);
    expect(c.nowSeconds()).toBe(Math.floor(initial.getTime() / 1000));
    expect(c.nowIso()).toBe("2026-05-16T12:00:00.000Z");
  });

  it("returns a fresh Date instance each time (caller cannot mutate)", () => {
    const c = new FixedClock(new Date("2026-05-16T00:00:00.000Z"));
    const a = c.now();
    a.setUTCFullYear(1900);
    expect(c.now().getUTCFullYear()).toBe(2026);
  });

  it("set() jumps to the new instant", () => {
    const c = new FixedClock(new Date("2026-05-16T00:00:00.000Z"));
    c.set(new Date("2026-05-17T00:00:00.000Z"));
    expect(c.nowIso()).toBe("2026-05-17T00:00:00.000Z");
  });

  it("advance() moves forward by milliseconds", () => {
    const c = new FixedClock(new Date("2026-05-16T00:00:00.000Z"));
    c.advance(60_000);
    expect(c.nowIso()).toBe("2026-05-16T00:01:00.000Z");
  });

  it("advance() rejects negative jumps", () => {
    const c = new FixedClock(new Date("2026-05-16T00:00:00.000Z"));
    expect(() => c.advance(-1)).toThrow(/backward/);
  });
});

describe("RandomIdGenerator", () => {
  it("returns ids matching the expected per-kind regex", () => {
    const g = new RandomIdGenerator();
    expect(g.generate("wfi")).toMatch(/^wfi_[a-z0-9]{24}$/);
    expect(g.generate("wfa")).toMatch(/^wfa_[a-z0-9]{24}$/);
    expect(g.generate("wfe")).toMatch(/^wfe_[a-z0-9]{24}$/);
    expect(g.generate("wfs")).toMatch(/^wfs_[a-z0-9]{24}$/);
    expect(g.generate("wft")).toMatch(/^wft_[a-z0-9]{24}$/);
    expect(g.generate("wfd")).toMatch(/^wfd_[a-z0-9]{24}$/);
  });

  it("returns unique ids per call", () => {
    const g = new RandomIdGenerator();
    const a = g.generate("wfi");
    const b = g.generate("wfi");
    expect(a).not.toBe(b);
  });

  it("respects a custom length", () => {
    const g = new RandomIdGenerator(16);
    expect(g.generate("wfi")).toMatch(/^wfi_[a-z0-9]{16}$/);
  });

  it("rejects out-of-range lengths", () => {
    expect(() => new RandomIdGenerator(4)).toThrow(/length/);
    expect(() => new RandomIdGenerator(60)).toThrow(/length/);
  });
});

describe("CountingIdGenerator", () => {
  it("returns sequential ids per kind", () => {
    const g = new CountingIdGenerator();
    expect(g.generate("wfi")).toBe("wfi_00000001");
    expect(g.generate("wfi")).toBe("wfi_00000002");
    expect(g.generate("wfa")).toBe("wfa_00000001");
  });

  it("respects a custom pad length", () => {
    const g = new CountingIdGenerator(12);
    expect(g.generate("wfe")).toBe("wfe_000000000001");
  });

  it("rejects out-of-range pad", () => {
    expect(() => new CountingIdGenerator(4)).toThrow(/padTo/);
  });

  it("reset() restarts counters", () => {
    const g = new CountingIdGenerator();
    g.generate("wfi");
    g.reset();
    expect(g.generate("wfi")).toBe("wfi_00000001");
  });
});
