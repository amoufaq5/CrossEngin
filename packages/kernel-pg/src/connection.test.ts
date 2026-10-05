import { describe, expect, it } from "vitest";

import { rowsResult } from "./node-pg.js";

import {
  isoCalendarDate,
  isoInstant,
  looksLikeProductionDatabase,
  parsePgEnvConfig,
  requireIsoInstant,
} from "./connection.js";

describe("parsePgEnvConfig", () => {
  const baseEnv: NodeJS.ProcessEnv = {
    PGHOST: "db.example.com",
    PGUSER: "postgres",
    PGDATABASE: "crossengin_dev",
  };

  it("returns a config with defaults filled in", () => {
    const cfg = parsePgEnvConfig(baseEnv);
    expect(cfg.host).toBe("db.example.com");
    expect(cfg.user).toBe("postgres");
    expect(cfg.database).toBe("crossengin_dev");
    expect(cfg.port).toBe(5432);
    expect(cfg.password).toBe("");
    expect(cfg.ssl).toBe("prefer");
    expect(cfg.applicationName).toBe("crossengin-pg");
  });

  it("threads PGPASSWORD through", () => {
    const cfg = parsePgEnvConfig({ ...baseEnv, PGPASSWORD: "secret" });
    expect(cfg.password).toBe("secret");
  });

  it("parses PGPORT as an integer", () => {
    const cfg = parsePgEnvConfig({ ...baseEnv, PGPORT: "6543" });
    expect(cfg.port).toBe(6543);
  });

  it("threads PGSSLMODE through when valid", () => {
    const cfg = parsePgEnvConfig({ ...baseEnv, PGSSLMODE: "require" });
    expect(cfg.ssl).toBe("require");
  });

  it("threads PGAPPNAME through", () => {
    const cfg = parsePgEnvConfig({ ...baseEnv, PGAPPNAME: "crossengin-ci" });
    expect(cfg.applicationName).toBe("crossengin-ci");
  });

  it("throws when PGHOST is missing", () => {
    expect(() =>
      parsePgEnvConfig({ ...baseEnv, PGHOST: undefined } as NodeJS.ProcessEnv),
    ).toThrow(/PGHOST/);
  });

  it("throws when PGUSER is missing", () => {
    expect(() =>
      parsePgEnvConfig({ ...baseEnv, PGUSER: undefined } as NodeJS.ProcessEnv),
    ).toThrow(/PGUSER/);
  });

  it("throws when PGDATABASE is missing", () => {
    expect(() =>
      parsePgEnvConfig({ ...baseEnv, PGDATABASE: undefined } as NodeJS.ProcessEnv),
    ).toThrow(/PGDATABASE/);
  });

  it("throws when PGPORT is not a valid TCP port", () => {
    expect(() => parsePgEnvConfig({ ...baseEnv, PGPORT: "abc" })).toThrow(/PGPORT/);
    expect(() => parsePgEnvConfig({ ...baseEnv, PGPORT: "0" })).toThrow(/PGPORT/);
    expect(() => parsePgEnvConfig({ ...baseEnv, PGPORT: "70000" })).toThrow(/PGPORT/);
  });

  it("throws when PGSSLMODE is not recognized", () => {
    expect(() => parsePgEnvConfig({ ...baseEnv, PGSSLMODE: "bogus" })).toThrow(/PGSSLMODE/);
  });
});

describe("looksLikeProductionDatabase", () => {
  it("flags names containing prod", () => {
    expect(looksLikeProductionDatabase("crossengin_prod")).toBe(true);
    expect(looksLikeProductionDatabase("PROD-cluster")).toBe(true);
  });

  it("flags names containing production", () => {
    expect(looksLikeProductionDatabase("production-db")).toBe(true);
  });

  it("flags names ending _live", () => {
    expect(looksLikeProductionDatabase("crossengin_live")).toBe(true);
  });

  it("flags the bare name live", () => {
    expect(looksLikeProductionDatabase("live")).toBe(true);
  });

  it("does not flag dev/test/staging names", () => {
    expect(looksLikeProductionDatabase("crossengin_dev")).toBe(false);
    expect(looksLikeProductionDatabase("staging_db")).toBe(false);
    expect(looksLikeProductionDatabase("test")).toBe(false);
  });
});

describe("rowsResult", () => {
  it("passes a single result through", () => {
    expect(rowsResult({ rows: [{ a: 1 }], rowCount: 1 })).toEqual({
      rows: [{ a: 1 }],
      rowCount: 1,
    });
  });

  it("takes the last result when node-postgres returns an array", () => {
    // A simple query holding more than one statement — `DROP INDEX …; CREATE INDEX …;`, which is how
    // an object is replaced without a window where it is missing — returns one result per statement.
    // Reading `.rows` off the array yielded undefined and surfaced as a JS TypeError wearing the
    // costume of a database error.
    expect(
      rowsResult([
        { rows: [], rowCount: null },
        { rows: [{ b: 2 }], rowCount: 1 },
      ]),
    ).toEqual({ rows: [{ b: 2 }], rowCount: 1 });
  });

  it("falls back to the row count when rowCount is null", () => {
    expect(rowsResult({ rows: [{ a: 1 }, { a: 2 }], rowCount: null }).rowCount).toBe(2);
  });

  it("is empty for an empty array of results", () => {
    expect(rowsResult([])).toEqual({ rows: [], rowCount: 0 });
  });

  it("is empty for a result with no rows field", () => {
    expect(rowsResult({ rowCount: 0 })).toEqual({ rows: [], rowCount: 0 });
  });

  it("is empty for null or undefined", () => {
    expect(rowsResult(null)).toEqual({ rows: [], rowCount: 0 });
    expect(rowsResult(undefined)).toEqual({ rows: [], rowCount: 0 });
  });
});

describe("isoInstant", () => {
  // The case the offline fakes could never produce: node-postgres hands a TIMESTAMPTZ, a TIMESTAMP
  // and a DATE back as a `Date`, and this is the whole reason this function exists.
  it("renders a Date as its ISO instant, milliseconds kept", () => {
    expect(isoInstant(new Date("2026-05-16T12:30:00.456Z"))).toBe("2026-05-16T12:30:00.456Z");
  });

  it("answers equal for a Date and the ISO string of the same instant", () => {
    expect(isoInstant(new Date("2026-05-16T12:30:00.456Z"))).toBe(
      isoInstant("2026-05-16T12:30:00.456Z"),
    );
  });

  it("does not answer equal for a Date and that Date's own String() form", () => {
    // `String(date)` drops the milliseconds, so substituting it would silently widen equality.
    const d = new Date("2026-05-16T12:30:00.456Z");
    expect(isoInstant(d)).not.toBe(isoInstant(String(d)));
  });

  it("normalises an offset-bearing string to UTC", () => {
    expect(isoInstant("2026-05-16T14:30:00+02:00")).toBe("2026-05-16T12:30:00.000Z");
  });

  it("is null for null and for undefined", () => {
    expect(isoInstant(null)).toBeNull();
    expect(isoInstant(undefined)).toBeNull();
  });

  it("returns an unparseable value as it stands, never as null", () => {
    // Absent and garbage are different facts; collapsing them would make a tampered column compare
    // equal to an empty one.
    expect(isoInstant("not a date")).toBe("not a date");
    expect(isoInstant(new Date("nope"))).toBe("Invalid Date");
    expect(isoInstant(42)).toBe("42");
  });
});

describe("requireIsoInstant", () => {
  it("renders a Date from a NOT NULL column", () => {
    expect(requireIsoInstant(new Date("2026-05-16T12:30:00.000Z"), "occurred_at")).toBe(
      "2026-05-16T12:30:00.000Z",
    );
  });

  it("throws naming the column when a NOT NULL timestamp is absent", () => {
    expect(() => requireIsoInstant(null, "occurred_at")).toThrow(
      /missing required timestamp: occurred_at/,
    );
  });
});

describe("isoCalendarDate", () => {
  // node-postgres parses a DATE into *local* midnight, so the ISO text of the same
  // `'2026-10-05'::date` names the previous day anywhere east of UTC. The local parts do not.
  it("reads the local calendar parts, not the ISO instant", () => {
    const tokyoMidnight = new Date(2026, 9, 5, 0, 0, 0); // local, whatever TZ the runner has
    expect(isoCalendarDate(tokyoMidnight)).toBe("2026-10-05");
  });

  it("does not agree with slicing the ISO text when that would shift the day", () => {
    // 1970-01-01T00:00:00Z is 1970-01-01 local only at or west of UTC; constructing from local
    // parts is what makes the answer independent of the runner's zone.
    const d = new Date(2026, 0, 1, 0, 0, 0);
    expect(isoCalendarDate(d)).toBe("2026-01-01");
  });

  it("passes a text date through unchanged", () => {
    expect(isoCalendarDate("2026-10-05")).toBe("2026-10-05");
  });

  it("is null for null and undefined, and names an invalid Date", () => {
    expect(isoCalendarDate(null)).toBeNull();
    expect(isoCalendarDate(undefined)).toBeNull();
    expect(isoCalendarDate(new Date("nope"))).toBe("Invalid Date");
  });
});
