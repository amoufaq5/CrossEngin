import { describe, expect, it } from "vitest";
import {
  CountingIdGenerator,
  FixedClock,
  RandomIdGenerator,
  SystemClock,
  parseDurationMs,
} from "./clock.js";

describe("SystemClock", () => {
  it("returns a Date near the real now", () => {
    const clock = new SystemClock();
    const before = Date.now();
    const t = clock.nowMs();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(clock.now()).toBeInstanceOf(Date);
    expect(clock.nowIso()).toMatch(/Z$/);
  });
});

describe("FixedClock", () => {
  it("holds a fixed instant", () => {
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    expect(clock.nowIso()).toBe("2026-01-01T00:00:00.000Z");
    expect(clock.nowMs()).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
  });

  it("advances forward", () => {
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    clock.advance(86_400_000);
    expect(clock.nowIso()).toBe("2026-01-02T00:00:00.000Z");
  });

  it("can be set to a new instant", () => {
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    clock.set(new Date("2027-06-01T00:00:00.000Z"));
    expect(clock.nowIso()).toBe("2027-06-01T00:00:00.000Z");
  });

  it("rejects moving backward", () => {
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    expect(() => clock.advance(-1)).toThrow(/backward/);
  });

  it("returns copies so callers cannot mutate internal state", () => {
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const d = clock.now();
    d.setFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
});

describe("CountingIdGenerator", () => {
  it("produces monotonic ids with the given prefix", () => {
    const ids = new CountingIdGenerator();
    expect(ids.next("arc")).toBe("arc_00000001");
    expect(ids.next("arc")).toBe("arc_00000002");
    expect(ids.next("ari")).toBe("ari_00000003");
  });

  it("honors a custom start", () => {
    const ids = new CountingIdGenerator(10);
    expect(ids.next("ard")).toBe("ard_00000011");
  });

  it("matches the campaign/item/decision id regexes", () => {
    const ids = new CountingIdGenerator();
    expect(ids.next("arc")).toMatch(/^arc_[a-z0-9]{8,32}$/);
    expect(ids.next("ari")).toMatch(/^ari_[a-z0-9]{8,32}$/);
    expect(ids.next("ard")).toMatch(/^ard_[a-z0-9]{8,32}$/);
  });
});

describe("RandomIdGenerator", () => {
  it("produces prefix ids matching the suffix regex", () => {
    const ids = new RandomIdGenerator();
    for (const prefix of ["arc", "ari", "ard"]) {
      expect(ids.next(prefix)).toMatch(new RegExp(`^${prefix}_[a-z0-9]{8,32}$`));
    }
  });

  it("produces distinct ids across calls", () => {
    const ids = new RandomIdGenerator();
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) seen.add(ids.next("arc"));
    expect(seen.size).toBe(50);
  });

  it("rejects an out-of-range length", () => {
    expect(() => new RandomIdGenerator(4)).toThrow();
    expect(() => new RandomIdGenerator(64)).toThrow();
  });
});

describe("parseDurationMs", () => {
  it("parses supported units", () => {
    expect(parseDurationMs("5m")).toBe(300_000);
    expect(parseDurationMs("1h")).toBe(3_600_000);
    expect(parseDurationMs("30d")).toBe(2_592_000_000);
    expect(parseDurationMs("2w")).toBe(1_209_600_000);
    expect(parseDurationMs("45s")).toBe(45_000);
  });

  it("rejects malformed durations", () => {
    expect(() => parseDurationMs("")).toThrow();
    expect(() => parseDurationMs("10")).toThrow();
    expect(() => parseDurationMs("0h")).toThrow();
    expect(() => parseDurationMs("5y")).toThrow();
  });
});
