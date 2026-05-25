import { describe, expect, it } from "vitest";
import {
  EMPTY_VECTOR_CLOCK,
  StampedEventSchema,
  VectorClockSchema,
  compareVectorClocks,
  dominates,
  getCounter,
  happensBefore,
  incrementVectorClock,
  isCausallyConcurrent,
  mergeVectorClocks,
  tickEvent,
  type VectorClock,
} from "./vectors.js";

describe("EMPTY_VECTOR_CLOCK", () => {
  it("is an empty array", () => {
    expect(EMPTY_VECTOR_CLOCK).toEqual([]);
  });
});

describe("VectorClockSchema", () => {
  it("accepts a sorted clock", () => {
    expect(() =>
      VectorClockSchema.parse([
        { region: "eu-central", counter: 5 },
        { region: "us-east", counter: 3 },
      ]),
    ).not.toThrow();
  });

  it("rejects duplicate region", () => {
    expect(() =>
      VectorClockSchema.parse([
        { region: "eu-central", counter: 5 },
        { region: "eu-central", counter: 3 },
      ]),
    ).toThrow(/duplicate region/);
  });

  it("rejects unsorted entries", () => {
    expect(() =>
      VectorClockSchema.parse([
        { region: "us-east", counter: 3 },
        { region: "eu-central", counter: 5 },
      ]),
    ).toThrow(/sorted by region/);
  });
});

describe("getCounter / incrementVectorClock", () => {
  it("getCounter returns 0 for unknown region", () => {
    expect(getCounter([], "eu-central")).toBe(0);
  });

  it("incrementVectorClock adds a new entry sorted", () => {
    const c = incrementVectorClock([], "us-east");
    expect(c).toEqual([{ region: "us-east", counter: 1 }]);
  });

  it("incrementVectorClock bumps existing counter", () => {
    const c = incrementVectorClock([{ region: "eu-central", counter: 5 }], "eu-central");
    expect(c).toEqual([{ region: "eu-central", counter: 6 }]);
  });

  it("keeps entries sorted after insert", () => {
    const c = incrementVectorClock([{ region: "us-east", counter: 1 }], "eu-central");
    expect(c.map((e) => e.region)).toEqual(["eu-central", "us-east"]);
  });
});

describe("mergeVectorClocks", () => {
  it("takes the max per region", () => {
    const a: VectorClock = [
      { region: "eu-central", counter: 5 },
      { region: "us-east", counter: 1 },
    ];
    const b: VectorClock = [
      { region: "eu-central", counter: 3 },
      { region: "us-east", counter: 7 },
    ];
    expect(mergeVectorClocks(a, b)).toEqual([
      { region: "eu-central", counter: 5 },
      { region: "us-east", counter: 7 },
    ]);
  });

  it("handles disjoint clocks", () => {
    const a: VectorClock = [{ region: "eu-central", counter: 5 }];
    const b: VectorClock = [{ region: "us-east", counter: 3 }];
    expect(mergeVectorClocks(a, b)).toEqual([
      { region: "eu-central", counter: 5 },
      { region: "us-east", counter: 3 },
    ]);
  });
});

describe("compareVectorClocks", () => {
  it("returns equal for identical clocks", () => {
    expect(
      compareVectorClocks(
        [{ region: "eu-central", counter: 5 }],
        [{ region: "eu-central", counter: 5 }],
      ),
    ).toBe("equal");
  });

  it("returns after when a dominates b", () => {
    expect(
      compareVectorClocks(
        [{ region: "eu-central", counter: 5 }],
        [{ region: "eu-central", counter: 3 }],
      ),
    ).toBe("after");
  });

  it("returns before when b dominates a", () => {
    expect(
      compareVectorClocks(
        [{ region: "eu-central", counter: 3 }],
        [{ region: "eu-central", counter: 5 }],
      ),
    ).toBe("before");
  });

  it("returns concurrent when neither dominates", () => {
    expect(
      compareVectorClocks(
        [{ region: "eu-central", counter: 5 }],
        [{ region: "us-east", counter: 3 }],
      ),
    ).toBe("concurrent");
  });
});

describe("happensBefore / dominates / isCausallyConcurrent", () => {
  const a: VectorClock = [{ region: "eu-central", counter: 5 }];
  const b: VectorClock = [{ region: "eu-central", counter: 3 }];
  const c: VectorClock = [{ region: "us-east", counter: 1 }];

  it("happensBefore", () => {
    expect(happensBefore(b, a)).toBe(true);
    expect(happensBefore(a, b)).toBe(false);
  });

  it("dominates", () => {
    expect(dominates(a, b)).toBe(true);
    expect(dominates(a, a)).toBe(true);
    expect(dominates(b, a)).toBe(false);
  });

  it("isCausallyConcurrent", () => {
    expect(isCausallyConcurrent(a, c)).toBe(true);
    expect(isCausallyConcurrent(a, b)).toBe(false);
  });
});

describe("StampedEventSchema", () => {
  it("accepts a valid stamped event", () => {
    expect(() =>
      StampedEventSchema.parse({
        eventId: "ev-1",
        originRegion: "eu-central",
        clock: [{ region: "eu-central", counter: 1 }],
        occurredAt: "2026-05-15T10:00:00Z",
      }),
    ).not.toThrow();
  });
});

describe("tickEvent", () => {
  it("increments the origin region's counter", () => {
    expect(tickEvent([], "eu-central")).toEqual([{ region: "eu-central", counter: 1 }]);
  });
});
