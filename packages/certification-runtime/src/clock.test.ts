import { describe, expect, it } from "vitest";
import {
  CountingIdGenerator,
  FixedClock,
  RandomIdGenerator,
  SystemClock,
} from "./clock.js";

describe("clock", () => {
  it("SystemClock returns coherent now/nowMs/nowIso", () => {
    const c = new SystemClock();
    const before = Date.now();
    const ms = c.nowMs();
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(c.nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(c.now()).toBeInstanceOf(Date);
  });

  it("FixedClock is deterministic and advances", () => {
    const c = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    expect(c.nowIso()).toBe("2026-01-01T00:00:00.000Z");
    c.advance(1000);
    expect(c.nowIso()).toBe("2026-01-01T00:00:01.000Z");
    c.set(new Date("2026-02-01T00:00:00.000Z"));
    expect(c.nowIso()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("FixedClock rejects moving backward", () => {
    const c = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    expect(() => c.advance(-1)).toThrow(/backward/);
  });
});

describe("id generators", () => {
  it("RandomIdGenerator produces prefixed base32 ids", () => {
    const g = new RandomIdGenerator();
    const id = g.next("cert");
    expect(id).toMatch(/^cert_[a-z0-9]{24}$/);
    expect(g.next("cert")).not.toBe(id);
  });

  it("RandomIdGenerator rejects empty prefix and bad length", () => {
    expect(() => new RandomIdGenerator(4)).toThrow();
    expect(() => new RandomIdGenerator().next("")).toThrow();
  });

  it("CountingIdGenerator is monotonic per prefix", () => {
    const g = new CountingIdGenerator();
    expect(g.next("cert")).toBe("cert_00000001");
    expect(g.next("cert")).toBe("cert_00000002");
    expect(g.next("other")).toBe("other_00000001");
    g.reset();
    expect(g.next("cert")).toBe("cert_00000001");
  });
});
