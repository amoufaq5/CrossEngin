import { describe, expect, it } from "vitest";
import {
  CountingIdGenerator,
  FixedClock,
  RandomIdGenerator,
  SystemClock,
  parseDurationMs,
} from "./clock.js";

describe("SystemClock", () => {
  it("produces a Date, ms, and ISO string that agree closely", () => {
    const clock = new SystemClock();
    const before = Date.now();
    const iso = clock.nowIso();
    const ms = clock.nowMs();
    expect(clock.now()).toBeInstanceOf(Date);
    expect(new Date(iso).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(ms).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe("FixedClock", () => {
  it("returns a stable time", () => {
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    expect(clock.nowIso()).toBe("2026-01-01T00:00:00.000Z");
    expect(clock.nowMs()).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
  });

  it("advance moves time forward", () => {
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    clock.advance(60_000);
    expect(clock.nowIso()).toBe("2026-01-01T00:01:00.000Z");
  });

  it("set replaces time", () => {
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    clock.set(new Date("2027-06-01T00:00:00.000Z"));
    expect(clock.nowIso()).toBe("2027-06-01T00:00:00.000Z");
  });

  it("rejects negative advance", () => {
    const clock = new FixedClock(new Date());
    expect(() => clock.advance(-1)).toThrow(/backward/);
  });

  it("returns a defensive copy from now()", () => {
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const d = clock.now();
    d.setFullYear(1999);
    expect(clock.nowIso()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("CountingIdGenerator", () => {
  it("increments per prefix deterministically", () => {
    const ids = new CountingIdGenerator();
    expect(ids.next("fov")).toBe("fov_00000001");
    expect(ids.next("fov")).toBe("fov_00000002");
    expect(ids.next("drl")).toBe("drl_00000001");
  });

  it("reset clears counters", () => {
    const ids = new CountingIdGenerator();
    ids.next("fov");
    ids.reset();
    expect(ids.next("fov")).toBe("fov_00000001");
  });

  it("rejects empty prefix", () => {
    const ids = new CountingIdGenerator();
    expect(() => ids.next("")).toThrow(/prefix/);
  });

  it("rejects out-of-range padTo", () => {
    expect(() => new CountingIdGenerator(1)).toThrow(/padTo/);
    expect(() => new CountingIdGenerator(99)).toThrow(/padTo/);
  });
});

describe("RandomIdGenerator", () => {
  it("prefixes and produces unique ids", () => {
    const ids = new RandomIdGenerator();
    const a = ids.next("fov");
    const b = ids.next("fov");
    expect(a.startsWith("fov_")).toBe(true);
    expect(a).not.toBe(b);
  });

  it("respects the configured length", () => {
    const ids = new RandomIdGenerator(12);
    const id = ids.next("drl");
    expect(id.slice("drl_".length).length).toBe(12);
  });

  it("rejects out-of-range length", () => {
    expect(() => new RandomIdGenerator(4)).toThrow(/length/);
    expect(() => new RandomIdGenerator(64)).toThrow(/length/);
  });

  it("rejects empty prefix", () => {
    const ids = new RandomIdGenerator();
    expect(() => ids.next("")).toThrow(/prefix/);
  });
});

describe("parseDurationMs", () => {
  it("parses supported units", () => {
    expect(parseDurationMs("5m")).toBe(300_000);
    expect(parseDurationMs("1h")).toBe(3_600_000);
    expect(parseDurationMs("2d")).toBe(172_800_000);
    expect(parseDurationMs("1w")).toBe(604_800_000);
    expect(parseDurationMs("30s")).toBe(30_000);
  });

  it("rejects malformed durations", () => {
    expect(() => parseDurationMs("5")).toThrow();
    expect(() => parseDurationMs("0m")).toThrow();
    expect(() => parseDurationMs("5y")).toThrow();
  });
});
