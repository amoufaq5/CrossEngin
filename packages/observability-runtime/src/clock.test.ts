import { describe, expect, it } from "vitest";
import { FixedClock, SystemClock, parseDurationMs } from "./clock.js";

describe("SystemClock", () => {
  it("returns a Date, ms, and ISO string that agree within tolerance", () => {
    const clock = new SystemClock();
    const before = Date.now();
    const ms = clock.nowMs();
    const after = Date.now();
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
    expect(clock.now()).toBeInstanceOf(Date);
    expect(clock.nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("FixedClock", () => {
  const base = new Date("2026-06-02T12:00:00.000Z");

  it("returns the fixed instant", () => {
    const clock = new FixedClock(base);
    expect(clock.nowMs()).toBe(base.getTime());
    expect(clock.nowIso()).toBe("2026-06-02T12:00:00.000Z");
  });

  it("advances forward by milliseconds", () => {
    const clock = new FixedClock(base);
    clock.advance(60_000);
    expect(clock.nowMs()).toBe(base.getTime() + 60_000);
  });

  it("refuses to move backward", () => {
    const clock = new FixedClock(base);
    expect(() => clock.advance(-1)).toThrow(/backward/);
  });

  it("can be set to a new instant", () => {
    const clock = new FixedClock(base);
    const next = new Date("2026-06-03T00:00:00.000Z");
    clock.set(next);
    expect(clock.nowMs()).toBe(next.getTime());
  });

  it("does not leak the internal reference", () => {
    const clock = new FixedClock(base);
    const d = clock.now();
    d.setFullYear(2000);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
});

describe("parseDurationMs", () => {
  it.each([
    ["5m", 300_000],
    ["1h", 3_600_000],
    ["6h", 21_600_000],
    ["30s", 30_000],
    ["7d", 604_800_000],
    ["2w", 1_209_600_000],
  ])("parses %s", (input, expected) => {
    expect(parseDurationMs(input)).toBe(expected);
  });

  it.each(["", "5", "m", "0h", "-3m", "5x", "1.5h", "5 m"])(
    "rejects %s",
    (input) => {
      expect(() => parseDurationMs(input)).toThrow();
    },
  );
});
