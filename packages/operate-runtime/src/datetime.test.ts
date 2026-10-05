import { describe, expect, it } from "vitest";

import {
  compareInstantText,
  datetimeSubmillisecondExceeded,
  DATETIME_SQL_PATTERN,
  DATETIME_WIRE_RE,
  isDatetimeSqlSafe,
  isTemporalKind,
  parseInstant,
  TEMPORAL_KINDS,
  TEMPORAL_REFUSALS,
  TEMPORAL_WIRE_CONVERTERS,
  toDateWire,
  toDatetimeWire,
  toTemporalWire,
  toTimeWire,
} from "./datetime.js";

/** The four spellings of 10:00 UTC that sorted into three positions, plus the 11:00 they straddled. */
const SPELLINGS = [
  "2026-01-31T05:00:00-05:00",
  "2026-01-31T10:00:00.000Z",
  "2026-01-31T10:00:00Z",
  "2026-01-31T11:00:00.000Z",
  "2026-01-31T19:00:00+09:00",
] as const;

describe("TEMPORAL_KINDS", () => {
  it("is exactly the three manifest kinds that name civil time", () => {
    expect(TEMPORAL_KINDS).toEqual(["date", "time", "datetime"]);
  });

  it("names the four refusals", () => {
    expect(TEMPORAL_REFUSALS).toEqual([
      "not_an_instant",
      "not_a_calendar_date",
      "not_a_time_of_day",
      "submillisecond_precision",
    ]);
  });

  it("recognises its own members and nothing else", () => {
    expect(isTemporalKind("datetime")).toBe(true);
    expect(isTemporalKind("date")).toBe(true);
    expect(isTemporalKind("time")).toBe(true);
    expect(isTemporalKind("duration")).toBe(false);
    expect(isTemporalKind("text")).toBe(false);
  });
});

describe("TEMPORAL_WIRE_CONVERTERS", () => {
  it("is total over the temporal kinds", () => {
    expect(Object.keys(TEMPORAL_WIRE_CONVERTERS).sort()).toEqual([...TEMPORAL_KINDS].sort());
  });

  it("dispatches through toTemporalWire", () => {
    expect(toTemporalWire("2026-01-31T10:00:00Z", "datetime")).toEqual({
      ok: true,
      wire: "2026-01-31T10:00:00.000Z",
    });
    expect(toTemporalWire("2026-01-31", "date")).toEqual({ ok: true, wire: "2026-01-31" });
    expect(toTemporalWire("9:05", "time")).toEqual({ ok: true, wire: "09:05:00" });
  });
});

describe("toDatetimeWire", () => {
  it("collapses every spelling of one instant to one canonical string", () => {
    // The defect, in one assertion: four of the five SPELLINGS are 10:00 UTC and sorted into
    // three positions as text. Canonically they are one string.
    const wires = SPELLINGS.map((s) => {
      const r = toDatetimeWire(s);
      return r.ok ? r.wire : `REFUSED:${r.reason}`;
    });
    expect(wires).toEqual([
      "2026-01-31T10:00:00.000Z",
      "2026-01-31T10:00:00.000Z",
      "2026-01-31T10:00:00.000Z",
      "2026-01-31T11:00:00.000Z",
      "2026-01-31T10:00:00.000Z",
    ]);
  });

  it("makes byte order chronological, which is the whole point of the form", () => {
    const wires = SPELLINGS.map((s) => {
      const r = toDatetimeWire(s);
      if (!r.ok) throw new Error("unreachable");
      return r.wire;
    });
    const sorted = [...wires].sort();
    const byInstant = [...wires].sort((a, b) => Date.parse(a) - Date.parse(b));
    expect(sorted).toEqual(byInstant);
    // Every canonical instant is the same width, which is what makes the above true in general.
    expect(new Set(wires.map((w) => w.length))).toEqual(new Set([24]));
  });

  it("accepts a Date and renders it as UTC", () => {
    expect(toDatetimeWire(new Date(Date.UTC(2026, 0, 31, 10, 0, 0, 250)))).toEqual({
      ok: true,
      wire: "2026-01-31T10:00:00.250Z",
    });
  });

  it("accepts a space separator and a bare-hour offset, which Postgres emits and Date.parse refuses", () => {
    // `Date.parse("2026-01-31T19:00:00+09")` is NaN; parsing the match's own fields is why this
    // module does not go through it.
    expect(toDatetimeWire("2026-01-31 10:00:00+00")).toEqual({
      ok: true,
      wire: "2026-01-31T10:00:00.000Z",
    });
    expect(toDatetimeWire("2026-01-31T19:00:00+09")).toEqual({
      ok: true,
      wire: "2026-01-31T10:00:00.000Z",
    });
    expect(toDatetimeWire("2026-01-31T19:00:00+0900")).toEqual({
      ok: true,
      wire: "2026-01-31T10:00:00.000Z",
    });
  });

  it("truncates sub-millisecond digits rather than rounding", () => {
    // node-postgres truncates building the Date, so the typed store already does this; rounding
    // here would make the two disagree at exactly the boundary.
    expect(toDatetimeWire("2026-01-31T10:00:00.999999Z")).toEqual({
      ok: true,
      wire: "2026-01-31T10:00:00.999Z",
    });
  });

  it("refuses an instant with no offset, because it names no instant", () => {
    // Postgres reads it in the session TimeZone, ECMAScript in the process's local zone.
    expect(toDatetimeWire("2026-01-31T10:00:00")).toEqual({
      ok: false,
      reason: "not_an_instant",
    });
  });

  it("refuses the words timestamptz accepts but no row holds", () => {
    for (const v of ["infinity", "-infinity", "now", "today", "epoch", "2026", "Jan 31 2026"]) {
      expect(toDatetimeWire(v)).toEqual({ ok: false, reason: "not_an_instant" });
    }
  });

  it("refuses an impossible calendar date and an out-of-range clock", () => {
    expect(toDatetimeWire("2026-02-30T10:00:00Z")).toEqual({ ok: false, reason: "not_an_instant" });
    expect(toDatetimeWire("2026-13-01T10:00:00Z")).toEqual({ ok: false, reason: "not_an_instant" });
    expect(toDatetimeWire("2026-01-31T24:00:00Z")).toEqual({ ok: false, reason: "not_an_instant" });
    expect(toDatetimeWire("2026-01-31T10:60:00Z")).toEqual({ ok: false, reason: "not_an_instant" });
    // A leap second would roll into the next minute under Date.UTC, so it is refused rather than
    // silently moved.
    expect(toDatetimeWire("2026-01-31T10:00:60Z")).toEqual({ ok: false, reason: "not_an_instant" });
  });

  it("refuses a number, an invalid Date, a boolean and an object", () => {
    expect(toDatetimeWire(1769853600000)).toEqual({ ok: false, reason: "not_an_instant" });
    expect(toDatetimeWire(new Date("nope"))).toEqual({ ok: false, reason: "not_an_instant" });
    expect(toDatetimeWire(true)).toEqual({ ok: false, reason: "not_an_instant" });
    expect(toDatetimeWire({})).toEqual({ ok: false, reason: "not_an_instant" });
  });

  it("accepts a leap day in a leap year and refuses it otherwise", () => {
    expect(toDatetimeWire("2024-02-29T00:00:00Z").ok).toBe(true);
    expect(toDatetimeWire("2026-02-29T00:00:00Z").ok).toBe(false);
  });
});

describe("parseInstant", () => {
  it("reports the fraction digits a literal carried", () => {
    expect(parseInstant("2026-01-31T10:00:00Z")?.fractionDigits).toBe(0);
    expect(parseInstant("2026-01-31T10:00:00.5Z")?.fractionDigits).toBe(1);
    expect(parseInstant("2026-01-31T10:00:00.123456Z")?.fractionDigits).toBe(6);
  });

  it("treats trailing zeros past the millisecond as no extra precision", () => {
    expect(parseInstant("2026-01-31T10:00:00.123000Z")?.submillisecond).toBe(false);
    expect(parseInstant("2026-01-31T10:00:00.123456Z")?.submillisecond).toBe(true);
  });

  it("applies the offset in the right direction", () => {
    const east = parseInstant("2026-01-31T19:00:00+09:00");
    const west = parseInstant("2026-01-31T05:00:00-05:00");
    expect(east?.epochMs).toBe(Date.UTC(2026, 0, 31, 10));
    expect(west?.epochMs).toBe(Date.UTC(2026, 0, 31, 10));
  });

  it("refuses an out-of-range offset", () => {
    expect(parseInstant("2026-01-31T10:00:00+24:00")).toBeNull();
    expect(parseInstant("2026-01-31T10:00:00+09:60")).toBeNull();
  });
});

describe("datetimeSubmillisecondExceeded", () => {
  it("is true only for a literal the canonical form cannot hold", () => {
    expect(datetimeSubmillisecondExceeded("2026-01-31T10:00:00.123Z")).toBe(false);
    expect(datetimeSubmillisecondExceeded("2026-01-31T10:00:00.1230Z")).toBe(false);
    expect(datetimeSubmillisecondExceeded("2026-01-31T10:00:00.123456Z")).toBe(true);
  });

  it("is false for a value that is not an instant, because that is a type error", () => {
    expect(datetimeSubmillisecondExceeded("yesterday")).toBe(false);
  });
});

describe("DATETIME_SQL_PATTERN", () => {
  it("is one pattern with two consumers", () => {
    expect(DATETIME_WIRE_RE.source).toBe(DATETIME_SQL_PATTERN);
    expect(DATETIME_SQL_PATTERN.startsWith("^")).toBe(true);
    expect(DATETIME_SQL_PATTERN.endsWith("$")).toBe(true);
  });

  it("uses only syntax a POSIX ERE and a JS RegExp read identically", () => {
    // No `\d`, no `\.`, no non-greedy or lookaround — those are where the two dialects part.
    expect(DATETIME_SQL_PATTERN).not.toMatch(/\\[dwsb]/);
    expect(DATETIME_SQL_PATTERN).not.toMatch(/\(\?/);
  });

  it("admits every spelling the decorator serves as an instant", () => {
    for (const s of SPELLINGS) expect(isDatetimeSqlSafe(s)).toBe(true);
    expect(isDatetimeSqlSafe("2026-01-31 10:00:00+00")).toBe(true);
    expect(isDatetimeSqlSafe("2026-01-31T10:00:00.123456Z")).toBe(true);
  });

  it("excludes the values that cast but are not instants", () => {
    for (const v of ["infinity", "-infinity", "now", "today", "epoch", "2026", "2026-01-31"]) {
      expect(isDatetimeSqlSafe(v)).toBe(false);
    }
  });

  it("excludes an instant with no offset, so a cast cannot order by a session-dependent guess", () => {
    expect(isDatetimeSqlSafe("2026-01-31T10:00:00")).toBe(false);
  });

  it("is a superset of the canonical form, which is the rule a guard must satisfy", () => {
    const canonical = toDatetimeWire("2026-01-31T10:00:00.250Z");
    expect(canonical.ok && isDatetimeSqlSafe(canonical.wire)).toBe(true);
  });
});

describe("toDateWire", () => {
  it("accepts and echoes the one unambiguous spelling", () => {
    expect(toDateWire("2026-01-31")).toEqual({ ok: true, wire: "2026-01-31" });
    expect(toDateWire("  2026-01-31  ")).toEqual({ ok: true, wire: "2026-01-31" });
  });

  it("reads a Date through its LOCAL calendar parts", () => {
    // node-postgres parses a `DATE` into local midnight; the UTC parts give the previous day
    // anywhere east of UTC (ADR-0331). Construct a local midnight and assert the local date.
    const local = new Date(2026, 0, 31, 0, 0, 0);
    expect(toDateWire(local)).toEqual({ ok: true, wire: "2026-01-31" });
  });

  it("refuses every ambiguous or non-standard spelling rather than guessing", () => {
    for (const v of ["2026-1-5", "01/31/2026", "31/01/2026", "Jan 31 2026", "20260131"]) {
      expect(toDateWire(v)).toEqual({ ok: false, reason: "not_a_calendar_date" });
    }
  });

  it("refuses a full instant, because reading a calendar date out of one needs a time zone", () => {
    expect(toDateWire("2026-01-31T23:00:00.000Z")).toEqual({
      ok: false,
      reason: "not_a_calendar_date",
    });
  });

  it("refuses an impossible date and a non-string", () => {
    expect(toDateWire("2026-02-30")).toEqual({ ok: false, reason: "not_a_calendar_date" });
    expect(toDateWire("2026-00-10")).toEqual({ ok: false, reason: "not_a_calendar_date" });
    expect(toDateWire(20260131)).toEqual({ ok: false, reason: "not_a_calendar_date" });
    expect(toDateWire(new Date("nope"))).toEqual({ ok: false, reason: "not_a_calendar_date" });
  });

  it("is fixed-width, so byte order is chronological", () => {
    const wires = ["2026-01-31", "2026-02-01", "2025-12-31", "2026-10-05"].map((d) => {
      const r = toDateWire(d);
      if (!r.ok) throw new Error("unreachable");
      return r.wire;
    });
    expect([...wires].sort()).toEqual(["2025-12-31", "2026-01-31", "2026-02-01", "2026-10-05"]);
    expect(new Set(wires.map((w) => w.length))).toEqual(new Set([10]));
  });
});

describe("toTimeWire", () => {
  it("normalises the unambiguous shorter spellings", () => {
    expect(toTimeWire("9:05")).toEqual({ ok: true, wire: "09:05:00" });
    expect(toTimeWire("09:05")).toEqual({ ok: true, wire: "09:05:00" });
    expect(toTimeWire("09:05:07")).toEqual({ ok: true, wire: "09:05:07" });
  });

  it("keeps a fraction and strips its trailing zeros, which is Postgres's own TIME spelling", () => {
    expect(toTimeWire("10:00:00.500")).toEqual({ ok: true, wire: "10:00:00.5" });
    expect(toTimeWire("10:00:00.123456")).toEqual({ ok: true, wire: "10:00:00.123456" });
    expect(toTimeWire("10:00:00.000")).toEqual({ ok: true, wire: "10:00:00" });
  });

  it("orders chronologically byte-wise despite the variable-width fraction", () => {
    // The HH:MM:SS head is fixed-width, and two trailing-zero-free fractions compare
    // lexicographically in the order of their values.
    const wires = ["10:00:00", "10:00:00.25", "10:00:00.5", "10:00:01", "09:59:59"].map((t) => {
      const r = toTimeWire(t);
      if (!r.ok) throw new Error("unreachable");
      return r.wire;
    });
    expect([...wires].sort()).toEqual([
      "09:59:59",
      "10:00:00",
      "10:00:00.25",
      "10:00:00.5",
      "10:00:01",
    ]);
  });

  it("refuses 24:00:00, which Postgres accepts and nothing here writes", () => {
    expect(toTimeWire("24:00:00")).toEqual({ ok: false, reason: "not_a_time_of_day" });
  });

  it("refuses a 12-hour clock, an out-of-range field and a non-string", () => {
    for (const v of ["10:00 AM", "10:60", "10:00:60", "10", "10:0", ":00"]) {
      expect(toTimeWire(v)).toEqual({ ok: false, reason: "not_a_time_of_day" });
    }
    expect(toTimeWire(1000)).toEqual({ ok: false, reason: "not_a_time_of_day" });
    expect(toTimeWire(new Date())).toEqual({ ok: false, reason: "not_a_time_of_day" });
  });

  it("is idempotent, which is what keeps a cursor agreeing with the stored text", () => {
    for (const v of ["09:05:00", "10:00:00.5", "23:59:59"]) {
      const once = toTimeWire(v);
      expect(once.ok && toTimeWire(once.wire)).toEqual(once);
    }
  });
});

describe("compareInstantText", () => {
  it("orders two spellings of different instants by instant, not by bytes", () => {
    // The pair the text order got wrong: 11:00 sorted before 19:00+09:00 (= 10:00).
    expect(compareInstantText("2026-01-31T11:00:00.000Z", "2026-01-31T19:00:00+09:00")).toBe(1);
    expect("2026-01-31T11:00:00.000Z" < "2026-01-31T19:00:00+09:00").toBe(true);
  });

  it("calls two spellings of one instant equal", () => {
    expect(compareInstantText("2026-01-31T10:00:00Z", "2026-01-31T05:00:00-05:00")).toBe(0);
  });

  it("answers null when either side is not an instant, so a text field is unaffected", () => {
    expect(compareInstantText("alpha", "beta")).toBeNull();
    expect(compareInstantText("2026-01-31T10:00:00Z", "beta")).toBeNull();
  });
});
