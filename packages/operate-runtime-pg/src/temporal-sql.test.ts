import { MIN_POSTGRES_MAJOR } from "@crossengin/kernel-pg";
import { DATETIME_SQL_PATTERN, isDatetimeSqlSafe, parseInstant } from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import {
  DATETIME_SQL_OFFSET_PATTERN,
  DATETIME_SQL_RANGE_PATTERN,
  TIMESTAMPTZ_OFFSET_HOURS_SQL,
  guardedTimestamptzCast,
  isDatetimeComparable,
} from "./temporal-sql.js";

/**
 * The spellings a legacy JSONB document can hold, with what each one is. `casts` is what Postgres
 * 16.13 does with `$1::timestamptz`, measured live — the column it exists for is the second one,
 * where a text that *casts* is still not a row's instant.
 */
const CORPUS: readonly {
  readonly text: string;
  readonly comparable: boolean;
  readonly why: string;
}[] = [
  { text: "2026-01-31T11:00:00.000Z", comparable: true, why: "the canonical wire form" },
  { text: "2026-01-31T11:00:00Z", comparable: true, why: "no fraction — the usual client spelling" },
  { text: "2026-01-31T11:00:00z", comparable: true, why: "a lowercase zone designator" },
  // Asymmetric, and both sides agree about it: `DATETIME_SQL_PATTERN` and `DATETIME_PARTS_RE` both
  // spell the separator `[T ]` while both spell the zone `(Z|z)`, so a lowercase `t` is refused and
  // a lowercase `z` is accepted. ISO 8601 permits either; this is pinned as the behaviour rather
  // than as the intent, because what matters here is that the two sides answer the same.
  { text: "2026-01-31t11:00:00z", comparable: false, why: "a lowercase separator is not admitted" },
  { text: "2026-01-31 11:00:00Z", comparable: true, why: "space separator" },
  { text: "2026-01-31T19:00:00+09:00", comparable: true, why: "the offset form the cast exists for" },
  { text: "2026-01-31T19:00:00+0900", comparable: true, why: "colonless offset" },
  { text: "2026-01-31T19:00:00+09", comparable: true, why: "hour-only offset" },
  { text: "2026-01-31T11:00:00.123456Z", comparable: true, why: "microsecond literal" },
  { text: "2024-02-29T00:00:00Z", comparable: true, why: "a real leap day" },
  { text: "2000-02-29T00:00:00Z", comparable: true, why: "century leap year" },
  { text: "0100-01-01T00:00:00Z", comparable: true, why: "the earliest year both sides accept" },
  { text: "9999-12-31T23:59:59Z", comparable: true, why: "the latest four-digit year" },
  { text: "2026-01-31T11:00:00+15:59", comparable: true, why: "the widest offset Postgres accepts" },

  // Matches DATETIME_SQL_PATTERN and RAISES on `::timestamptz` — the reason the guard is not one
  // regex. Every one of these was measured.
  { text: "2026-02-30T00:00:00Z", comparable: false, why: "no 30th of February" },
  { text: "2026-02-31T00:00:00Z", comparable: false, why: "no 31st of February" },
  { text: "2026-02-29T00:00:00Z", comparable: false, why: "2026 is not a leap year" },
  { text: "1900-02-29T00:00:00Z", comparable: false, why: "1900 is not a leap year either" },
  { text: "2026-04-31T00:00:00Z", comparable: false, why: "April has 30 days" },
  { text: "2026-06-31T00:00:00Z", comparable: false, why: "June has 30 days" },
  { text: "2026-09-31T00:00:00Z", comparable: false, why: "September has 30 days" },
  { text: "2026-11-31T00:00:00Z", comparable: false, why: "November has 30 days" },
  { text: "2026-13-01T00:00:00Z", comparable: false, why: "month 13" },
  { text: "2026-00-01T00:00:00Z", comparable: false, why: "month 0" },
  { text: "2026-01-00T00:00:00Z", comparable: false, why: "day 0" },
  { text: "2026-01-32T00:00:00Z", comparable: false, why: "day 32" },
  { text: "0000-01-01T00:00:00Z", comparable: false, why: "year 0 does not exist" },
  { text: "0001-01-01T00:00:00Z", comparable: false, why: "Date.UTC maps years 0-99 to the 1900s" },
  { text: "2026-01-31T24:00:00Z", comparable: false, why: "hour 24 rolls into the next day" },
  { text: "2026-01-31T23:59:60Z", comparable: false, why: "a leap second rolls into the next minute" },
  { text: "2026-01-31T11:60:00Z", comparable: false, why: "minute 60" },
  { text: "2026-01-31T11:00:00+16:00", comparable: false, why: "beyond Postgres's ±15:59" },
  { text: "2026-01-31T11:00:00+99:00", comparable: false, why: "offset 99" },

  // Casts successfully and is not an instant a row holds.
  { text: "infinity", comparable: false, why: "casts, and orders at an extreme of every page" },
  { text: "-infinity", comparable: false, why: "likewise" },
  { text: "now", comparable: false, why: "casts, and its value changes between evaluations" },
  { text: "today", comparable: false, why: "likewise" },
  { text: "yesterday", comparable: false, why: "likewise" },
  { text: "epoch", comparable: false, why: "likewise" },
  { text: "2026-01-31", comparable: false, why: "a date is not an instant" },
  { text: "Jan 31 2026", comparable: false, why: "casts, and is not a form this platform issues" },
  { text: "2026-01-31 11:00:00 Asia/Tokyo", comparable: false, why: "a zone name, not an offset" },

  // Does not name an instant at all.
  { text: "2026-01-31T11:00:00", comparable: false, why: "no offset — the instant depends on TimeZone" },
  { text: "not-a-date", comparable: false, why: "the raise this guard exists for" },
  { text: "", comparable: false, why: "''::timestamptz raises" },
  { text: "  ", comparable: false, why: "likewise" },
  { text: " 2026-01-31T11:00:00Z", comparable: false, why: "padded: parseInstant trims, the SQL does not" },
  { text: "2026-01-31T11:00:00Z ", comparable: false, why: "likewise, trailing" },
  { text: "31/01/2026", comparable: false, why: "DateStyle-dependent" },
  { text: "2026", comparable: false, why: "a bare year" },
  { text: "10.5", comparable: false, why: "a number" },
];

describe("isDatetimeComparable — the set the SQL guard reproduces", () => {
  for (const { text, comparable, why } of CORPUS) {
    it(`${comparable ? "admits" : "refuses"} ${JSON.stringify(text)} — ${why}`, () => {
      expect(isDatetimeComparable(text)).toBe(comparable);
    });
  }

  it("is NOT isDatetimeSqlSafe, and the gap is the whole reason this module exists", () => {
    // `isDatetimeSqlSafe` is `DATETIME_SQL_PATTERN` alone — a *syntax* filter. Using it as the SQL
    // guard would admit every one of these, and `::timestamptz` raises on all of them, which makes
    // one legacy row a 500 on **every** page of that entity (the sort evaluates the cast on every
    // candidate before LIMIT applies). ADR-0332's `FEATURE_FLAG_COLUMN_NAMES` shape: two spellings
    // of one set that do not agree, with the SQL consumer using the wrong one.
    const raisesButMatchesSyntax = [
      "2026-02-30T00:00:00Z",
      "2026-02-29T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "0000-01-01T00:00:00Z",
      "2026-01-31T11:60:00Z",
      "2026-01-31T11:00:00+99:00",
    ];
    for (const text of raisesButMatchesSyntax) {
      expect(isDatetimeSqlSafe(text)).toBe(true);
      expect(isDatetimeComparable(text)).toBe(false);
    }
  });

  it("states the offset ceiling once, as a number and as a regex bound that agree", () => {
    // Two spellings of one set is ADR-0332's defect, so the only safe version of it is one a test
    // checks. Walked hour by hour: the regex and the number must admit and refuse the same hours.
    const re = new RegExp(DATETIME_SQL_OFFSET_PATTERN);
    for (let hour = 0; hour <= 23; hour += 1) {
      const text = `2026-01-31T11:00:00+${hour.toString().padStart(2, "0")}:00`;
      expect(re.test(text)).toBe(hour <= TIMESTAMPTZ_OFFSET_HOURS_SQL);
      expect(isDatetimeComparable(text)).toBe(hour <= TIMESTAMPTZ_OFFSET_HOURS_SQL);
    }
    // And the ceiling is Postgres's, measured: `+15:59` casts and `+16:00` raises.
    expect(TIMESTAMPTZ_OFFSET_HOURS_SQL).toBe(15);
  });

  it("agrees with parseInstant except where Postgres is stricter about the offset", () => {
    // One rule, stated once: the two sides must admit the same set, and where they cannot, the
    // resolution is in favour of Postgres — because the alternative is a cast that raises.
    for (const { text } of CORPUS) {
      const js = parseInstant(text) !== null && text === text.trim();
      const offset = /[+-](\d{2}):?(\d{2})?$/.exec(text);
      const postgresAccepts = offset === null || Number(offset[1]) <= TIMESTAMPTZ_OFFSET_HOURS_SQL;
      expect(isDatetimeComparable(text)).toBe(js && postgresAccepts);
    }
  });
});

describe("guardedTimestamptzCast", () => {
  const expr = "document ->> 'occurred'";

  it("conjoins the syntax, range and offset patterns before casting anything", () => {
    const sql = guardedTimestamptzCast(expr);
    expect(sql).toContain(`${expr} ~ '${DATETIME_SQL_PATTERN}'`);
    expect(sql).toContain(`${expr} ~ '${DATETIME_SQL_RANGE_PATTERN}'`);
    expect(sql).toContain(`${expr} ~ '${DATETIME_SQL_OFFSET_PATTERN}'`);
    expect(sql).toContain(`(${expr})::timestamptz`);
  });

  it("uses one pattern string per set, with a RegExp and a SQL literal as its two consumers", () => {
    // ADR-0332's rule. The literal inside the SQL and the `RegExp` the component guard uses are the
    // same string, so the ordering expression and the cursor test cannot drift apart.
    const sql = guardedTimestamptzCast(expr);
    for (const pattern of [DATETIME_SQL_RANGE_PATTERN, DATETIME_SQL_OFFSET_PATTERN]) {
      expect(sql.split(`'${pattern}'`)).toHaveLength(2);
      expect(() => new RegExp(pattern)).not.toThrow();
    }
  });

  it("nests the calendar check inside its own CASE, so no arithmetic runs on an unmatched row", () => {
    // `substring(expr, 1, 4)::int` raises on a text that is not four digits there, and Postgres
    // does not guarantee the evaluation order of `AND` operands — so a flat conjunction could
    // evaluate the arithmetic against a row the regexes were meant to have excluded. `CASE` *is*
    // guaranteed to not evaluate its THEN unless its WHEN is true.
    const sql = guardedTimestamptzCast(expr);
    const firstWhen = sql.indexOf("WHEN");
    const firstThen = sql.indexOf("THEN");
    const substringAt = sql.indexOf("substring");
    expect(firstWhen).toBeLessThan(firstThen);
    expect(substringAt).toBeGreaterThan(firstThen);
    expect(sql.match(/CASE WHEN/g)).toHaveLength(2);
  });

  it("asks Postgres's own calendar for day-beyond-month-length rather than writing a leap regex", () => {
    // ADR-0330's rule, ADR-0292's refusal. `make_date(y, m, 1) + (d - 1)` is total for every
    // (y >= 100, m in 1..12, d in 1..31) the regexes guarantee, and lands in the *following* month
    // exactly when d overflows — so comparing its month back to m is the calendar answering.
    const sql = guardedTimestamptzCast(expr);
    expect(sql).toContain("make_date(");
    expect(sql).toContain("EXTRACT(MONTH FROM");
    expect(sql).not.toContain("[13579][26]");
  });

  it("does not reach for pg_input_is_valid, which is newer than the supported floor", () => {
    // It would be this question asked in one call rather than reproduced. It arrived in PostgreSQL
    // 16. This assertion is the tripwire: when the floor rises to 16, it fails, and that is the
    // moment to replace the whole guard with one call.
    expect(MIN_POSTGRES_MAJOR).toBeLessThan(16);
    expect(guardedTimestamptzCast(expr)).not.toContain("pg_input_is_valid");
  });

  it("evaluates the guarded expression once per occurrence of the field, not once per row read", () => {
    // Shape, not performance: every reference is to the same `expr`, so a caller can parenthesise
    // it and bind nothing. No parameter placeholders appear — the guard interpolates patterns, and
    // a pattern is this module's own constant, never caller input.
    expect(guardedTimestamptzCast(expr)).not.toMatch(/\$\d/);
  });
});
