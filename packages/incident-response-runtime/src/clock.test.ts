import { describe, expect, it } from "vitest";
import { FixedClock, SystemClock } from "./clock.js";

describe("SystemClock", () => {
  it("agrees across its three readings", () => {
    const clock = new SystemClock();
    const ms = clock.nowMs();
    expect(Math.abs(clock.now().getTime() - ms)).toBeLessThan(1_000);
    expect(clock.nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns an ISO string parseable back to the same instant", () => {
    const clock = new SystemClock();
    const iso = clock.nowIso();
    expect(new Date(iso).toISOString()).toBe(iso);
  });
});

describe("FixedClock", () => {
  const at = new Date("2026-09-30T10:00:00.000Z");

  it("holds the instant it was constructed with", () => {
    const clock = new FixedClock(at);
    expect(clock.nowIso()).toBe("2026-09-30T10:00:00.000Z");
    expect(clock.nowMs()).toBe(at.getTime());
  });

  it("hands out copies, so a caller cannot move it", () => {
    const clock = new FixedClock(at);
    const first = clock.now();
    first.setUTCFullYear(2030);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });

  it("does not alias the date it was constructed from", () => {
    const seed = new Date(at.getTime());
    const clock = new FixedClock(seed);
    seed.setUTCFullYear(2030);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });

  it("moves to an explicit instant", () => {
    const clock = new FixedClock(at);
    clock.set(new Date("2027-01-01T00:00:00.000Z"));
    expect(clock.nowIso()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("advances by a duration", () => {
    const clock = new FixedClock(at);
    clock.advance(90_000);
    expect(clock.nowIso()).toBe("2026-09-30T10:01:30.000Z");
  });

  it("advancing by zero is a no-op", () => {
    const clock = new FixedClock(at);
    clock.advance(0);
    expect(clock.nowMs()).toBe(at.getTime());
  });

  it("refuses to move backward", () => {
    const clock = new FixedClock(at);
    expect(() => clock.advance(-1)).toThrow(/cannot move backward/);
  });
});
