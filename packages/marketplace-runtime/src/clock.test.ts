import { describe, expect, it } from "vitest";

import { CountingIdGenerator, FixedClock, RandomIdGenerator, formatInstallationId } from "./clock.js";

describe("FixedClock", () => {
  it("returns its instant and advances", () => {
    const clock = new FixedClock("2026-01-01T00:00:00.000Z");
    expect(clock.now()).toBe("2026-01-01T00:00:00.000Z");
    expect(clock.advance(1000)).toBe("2026-01-01T00:00:01.000Z");
    expect(clock.now()).toBe("2026-01-01T00:00:01.000Z");
  });
});

describe("CountingIdGenerator", () => {
  it("produces monotonic zero-padded ids", () => {
    const gen = new CountingIdGenerator();
    expect(gen.next()).toBe("inst_00000001");
    expect(gen.next()).toBe("inst_00000002");
  });

  it("honors a custom prefix", () => {
    expect(new CountingIdGenerator("pk").next()).toBe("pk_00000001");
  });
});

describe("RandomIdGenerator", () => {
  it("prefixes a uuid and yields distinct ids", () => {
    const gen = new RandomIdGenerator();
    const a = gen.next();
    const b = gen.next();
    expect(a).toMatch(/^inst_[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});

describe("formatInstallationId", () => {
  it("zero-pads to the inst_ shape", () => {
    expect(formatInstallationId(42)).toBe("inst_00000042");
  });
});
