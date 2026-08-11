import { describe, expect, it } from "vitest";

import { CountingUuidGenerator, FixedClock, RandomUuidGenerator, SystemClock } from "./clock.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("FixedClock", () => {
  it("holds + advances a fixed instant", () => {
    const clock = new FixedClock(new Date("2026-06-01T00:00:00.000Z"));
    expect(clock.nowIso()).toBe("2026-06-01T00:00:00.000Z");
    clock.advance(86_400_000);
    expect(clock.nowIso()).toBe("2026-06-02T00:00:00.000Z");
    clock.set(new Date("2027-01-01T00:00:00.000Z"));
    expect(clock.now().getUTCFullYear()).toBe(2027);
  });
});

describe("SystemClock", () => {
  it("returns matching now()/nowIso()", () => {
    const clock = new SystemClock();
    expect(clock.now()).toBeInstanceOf(Date);
    expect(clock.nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("uuid generators", () => {
  it("CountingUuidGenerator yields distinct valid v4-shaped uuids", () => {
    const gen = new CountingUuidGenerator();
    const a = gen.next();
    const b = gen.next();
    expect(a).toMatch(UUID_RE);
    expect(b).toMatch(UUID_RE);
    expect(a).not.toBe(b);
  });

  it("RandomUuidGenerator yields valid uuids", () => {
    expect(new RandomUuidGenerator().next()).toMatch(UUID_RE);
  });
});
