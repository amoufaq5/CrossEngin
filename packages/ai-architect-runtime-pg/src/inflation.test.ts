import { describe, expect, it } from "vitest";

import {
  INFLATION_RELAXATION_PER_OBSERVATION,
  INITIAL_ESTIMATE_INFLATION,
  MAX_ESTIMATE_INFLATION,
  STORED_INFLATION_PROVENANCES,
  UNREADABLE_INFLATION_FALLBACK,
  clampInflation,
  nextInflation,
  nextWorstObserved,
  resolveStoredInflation,
} from "./inflation.js";

describe("constants", () => {
  it("names a fallback above 1, because an unreadable figure must fail pessimistic", () => {
    expect(UNREADABLE_INFLATION_FALLBACK).toBeGreaterThan(INITIAL_ESTIMATE_INFLATION);
  });

  it("relaxes by less than a whole observation, so forgetting is gradual and bounded", () => {
    expect(INFLATION_RELAXATION_PER_OBSERVATION).toBeGreaterThan(0);
    expect(INFLATION_RELAXATION_PER_OBSERVATION).toBeLessThan(1);
  });

  it("bounds the factor well above the fallback", () => {
    expect(MAX_ESTIMATE_INFLATION).toBeGreaterThan(UNREADABLE_INFLATION_FALLBACK);
  });

  it("lists four provenances", () => {
    expect([...STORED_INFLATION_PROVENANCES]).toEqual([
      "no_history",
      "learned",
      "clamped",
      "unreadable",
    ]);
  });
});

describe("resolveStoredInflation", () => {
  it("reads a missing row as no correction, not as a known-optimistic estimator", () => {
    for (const absent of [undefined, null]) {
      const r = resolveStoredInflation(absent);
      expect(r.provenance).toBe("no_history");
      expect(r.inflation).toBe(INITIAL_ESTIMATE_INFLATION);
      expect(r.rejected).toBeUndefined();
    }
  });

  it("reads a usable number", () => {
    const r = resolveStoredInflation(2.5);
    expect(r.provenance).toBe("learned");
    expect(r.inflation).toBe(2.5);
  });

  it("reads a NUMERIC column's string form, which is how node-postgres hands it back", () => {
    const r = resolveStoredInflation("3.250000");
    expect(r.provenance).toBe("learned");
    expect(r.inflation).toBeCloseTo(3.25, 10);
  });

  it("reads exactly 1 as learned, since no correction is a legitimate stored answer", () => {
    const r = resolveStoredInflation("1.000000");
    expect(r.provenance).toBe("learned");
    expect(r.inflation).toBe(1);
  });

  it("falls pessimistic on NaN rather than to no correction", () => {
    const r = resolveStoredInflation(Number.NaN);
    expect(r.provenance).toBe("unreadable");
    expect(r.inflation).toBe(UNREADABLE_INFLATION_FALLBACK);
    expect(r.rejected).toBe("NaN");
  });

  it("falls pessimistic on zero and on a negative figure", () => {
    for (const bad of [0, -1, "-4.5", "0"]) {
      const r = resolveStoredInflation(bad);
      expect(r.provenance).toBe("unreadable");
      expect(r.inflation).toBe(UNREADABLE_INFLATION_FALLBACK);
    }
  });

  it("falls pessimistic on a deflating factor below 1, which would loosen the ceiling", () => {
    const r = resolveStoredInflation("0.5");
    expect(r.provenance).toBe("unreadable");
    expect(r.inflation).toBe(UNREADABLE_INFLATION_FALLBACK);
  });

  it("falls pessimistic on non-numeric text and on an empty string", () => {
    for (const bad of ["", "   ", "nope", {}, [], true]) {
      const r = resolveStoredInflation(bad);
      expect(r.provenance).toBe("unreadable");
      expect(r.inflation).toBe(UNREADABLE_INFLATION_FALLBACK);
    }
  });

  it("clamps an absurd figure rather than letting it refuse every request forever", () => {
    const r = resolveStoredInflation(1e9);
    expect(r.provenance).toBe("clamped");
    expect(r.inflation).toBe(MAX_ESTIMATE_INFLATION);
    expect(r.rejected).toBe("1000000000");
  });

  it("treats Infinity as unreadable, not as the largest possible correction", () => {
    const r = resolveStoredInflation(Number.POSITIVE_INFINITY);
    expect(r.provenance).toBe("unreadable");
    expect(r.inflation).toBe(UNREADABLE_INFLATION_FALLBACK);
  });

  it("never answers below 1, whatever it was handed", () => {
    for (const raw of [undefined, null, 0, -5, "x", 1e12, Number.NaN, "0.25"]) {
      expect(resolveStoredInflation(raw).inflation).toBeGreaterThanOrEqual(
        INITIAL_ESTIMATE_INFLATION,
      );
    }
  });
});

describe("clampInflation", () => {
  it("floors at 1, caps at the maximum, and reads a non-finite value as no correction", () => {
    expect(clampInflation(0.2)).toBe(1);
    expect(clampInflation(5)).toBe(5);
    expect(clampInflation(1e6)).toBe(MAX_ESTIMATE_INFLATION);
    expect(clampInflation(Number.NaN)).toBe(1);
  });
});

describe("nextInflation", () => {
  it("rises to a worse observation immediately", () => {
    expect(nextInflation(1, 4)).toBe(4);
  });

  it("relaxes when a better observation arrives, but only by the fixed fraction", () => {
    expect(nextInflation(10, 1.2)).toBeCloseTo(10 * INFLATION_RELAXATION_PER_OBSERVATION, 10);
  });

  it("never relaxes below 1, however many good observations arrive", () => {
    let mark = 10;
    for (let i = 0; i < 500; i++) mark = nextInflation(mark, 0.1);
    expect(mark).toBe(INITIAL_ESTIMATE_INFLATION);
  });

  it("returns to no correction in a bounded number of observations, not forever", () => {
    let mark = nextInflation(1, 10);
    let observations = 0;
    while (mark > INITIAL_ESTIMATE_INFLATION && observations < 1000) {
      mark = nextInflation(mark, 0.5);
      observations += 1;
    }
    expect(mark).toBe(INITIAL_ESTIMATE_INFLATION);
    expect(observations).toBeLessThan(60);
  });

  it("never relaxes below the newest observation", () => {
    expect(nextInflation(10, 9.5)).toBe(9.5);
  });

  it("does not relax on an unusable observation: silence must not loosen a ceiling", () => {
    expect(nextInflation(10, Number.NaN)).toBe(10);
    expect(nextInflation(10, 0)).toBe(10);
    expect(nextInflation(10, -3)).toBe(10);
  });

  it("caps a pathological observation at the maximum", () => {
    expect(nextInflation(1, 1e9)).toBe(MAX_ESTIMATE_INFLATION);
  });

  it("sanitises a corrupt current mark before using it", () => {
    expect(nextInflation(Number.NaN, 3)).toBe(3);
    expect(nextInflation(-10, 3)).toBe(3);
  });
});

describe("nextWorstObserved", () => {
  it("is a high-water mark that never relaxes, so the original peak stays answerable", () => {
    let worst = nextWorstObserved(1, 8);
    expect(worst).toBe(8);
    for (let i = 0; i < 50; i++) worst = nextWorstObserved(worst, 1.1);
    expect(worst).toBe(8);
  });

  it("ignores an unusable observation and stays inside the bounds", () => {
    expect(nextWorstObserved(4, Number.NaN)).toBe(4);
    expect(nextWorstObserved(4, 1e9)).toBe(MAX_ESTIMATE_INFLATION);
    expect(nextWorstObserved(0.1, 0.2)).toBe(INITIAL_ESTIMATE_INFLATION);
  });
});
