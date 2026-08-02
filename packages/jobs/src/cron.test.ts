import { describe, expect, it } from "vitest";

import {
  cronMatches,
  cronNextAfter,
  cronPrevOnOrBefore,
  parseCron,
  scheduledJobsDue,
} from "./cron.js";
import { JobDeclarationSchema, type JobDeclaration } from "./types.js";

function at(iso: string): Date {
  return new Date(iso);
}

describe("parseCron", () => {
  it("expands *, steps, ranges and lists", () => {
    const p = parseCron("*/15 9-17 * * 1-5");
    expect([...p.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect([...p.hour].sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(p.domRestricted).toBe(false);
    expect(p.dowRestricted).toBe(true);
    expect([...p.dow].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(p.hasSeconds).toBe(false);
  });

  it("parses a 6-field expression with seconds", () => {
    const p = parseCron("30 0 12 * * *");
    expect(p.hasSeconds).toBe(true);
    expect([...p.second!]).toEqual([30]);
    expect([...p.minute]).toEqual([0]);
    expect([...p.hour]).toEqual([12]);
  });

  it("normalizes day-of-week 7 to Sunday (0)", () => {
    expect([...parseCron("0 0 * * 7").dow]).toEqual([0]);
  });

  it("rejects out-of-range and malformed fields", () => {
    expect(() => parseCron("99 0 * * *")).toThrow(/invalid cron field/);
    expect(() => parseCron("60 0 * * *")).toThrow(/invalid cron field/);
  });
});

describe("cronMatches", () => {
  it("matches an exact minute/hour", () => {
    const p = parseCron("30 9 * * *");
    expect(cronMatches(p, at("2026-05-17T09:30:00Z"))).toBe(true);
    expect(cronMatches(p, at("2026-05-17T09:31:00Z"))).toBe(false);
  });

  it("ORs dom and dow when both are restricted (standard cron)", () => {
    const p = parseCron("0 0 13 * 5"); // the 13th OR any Friday
    expect(cronMatches(p, at("2026-02-13T00:00:00Z"))).toBe(true); // Friday the 13th (both)
    expect(cronMatches(p, at("2026-05-13T00:00:00Z"))).toBe(true); // 13th (a Wednesday) → dom
    expect(cronMatches(p, at("2026-05-15T00:00:00Z"))).toBe(true); // a Friday → dow
    expect(cronMatches(p, at("2026-05-14T00:00:00Z"))).toBe(false); // neither
  });

  it("ANDs dom and dow when only one is restricted", () => {
    const p = parseCron("0 0 15 * *"); // the 15th, any weekday
    expect(cronMatches(p, at("2026-05-15T00:00:00Z"))).toBe(true);
    expect(cronMatches(p, at("2026-05-16T00:00:00Z"))).toBe(false);
  });
});

describe("cronPrevOnOrBefore", () => {
  it("returns the current tick at or before now", () => {
    // daily 09:00; now is 14:23 → current tick is today 09:00
    expect(cronPrevOnOrBefore("0 9 * * *", at("2026-05-17T14:23:00Z"))?.toISOString()).toBe(
      "2026-05-17T09:00:00.000Z",
    );
  });

  it("is deterministic and stable across a tick window (idempotent basis)", () => {
    const a = cronPrevOnOrBefore("*/30 * * * *", at("2026-05-17T14:05:00Z"));
    const b = cronPrevOnOrBefore("*/30 * * * *", at("2026-05-17T14:29:59Z"));
    expect(a?.toISOString()).toBe("2026-05-17T14:00:00.000Z");
    expect(b?.toISOString()).toBe("2026-05-17T14:00:00.000Z"); // same tick until :30
  });

  it("returns exactly now when now is on a tick boundary", () => {
    expect(cronPrevOnOrBefore("0 * * * *", at("2026-05-17T14:00:00Z"))?.toISOString()).toBe(
      "2026-05-17T14:00:00.000Z",
    );
  });

  it("crosses into the previous month/year for a yearly cron", () => {
    // Jan 1 00:00; now is mid-May → last tick was Jan 1 of the same year
    expect(cronPrevOnOrBefore("0 0 1 1 *", at("2026-05-17T00:00:00Z"))?.toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });
});

describe("cronNextAfter", () => {
  it("returns the next tick strictly after the given instant", () => {
    expect(cronNextAfter("0 9 * * *", at("2026-05-17T09:00:00Z"))?.toISOString()).toBe(
      "2026-05-18T09:00:00.000Z",
    );
  });
});

describe("cron timezone handling", () => {
  it("matches the wall-clock time in an IANA zone, not UTC", () => {
    const p = parseCron("0 9 * * *"); // 09:00 local
    // 2026-05-17 is EDT (UTC-4): 09:00 New York == 13:00 UTC.
    expect(cronMatches(p, at("2026-05-17T13:00:00Z"), "America/New_York")).toBe(true);
    expect(cronMatches(p, at("2026-05-17T09:00:00Z"), "America/New_York")).toBe(false);
    // Without a zone the same 09:00Z still matches (UTC-evaluated).
    expect(cronMatches(p, at("2026-05-17T09:00:00Z"))).toBe(true);
  });

  it("cronPrevOnOrBefore returns a UTC instant offset by the zone's offset", () => {
    const zoned = cronPrevOnOrBefore("0 9 * * *", at("2026-05-17T14:23:00Z"), "America/New_York");
    expect(zoned?.toISOString()).toBe("2026-05-17T13:00:00.000Z");
    const utc = cronPrevOnOrBefore("0 9 * * *", at("2026-05-17T14:23:00Z"));
    expect(utc?.toISOString()).toBe("2026-05-17T09:00:00.000Z");
    expect(zoned?.toISOString()).not.toBe(utc?.toISOString());
  });

  it("cronNextAfter honors the zone", () => {
    expect(
      cronNextAfter("0 9 * * *", at("2026-05-17T13:00:00Z"), "America/New_York")?.toISOString(),
    ).toBe("2026-05-18T13:00:00.000Z");
  });

  it("omitting the timezone is byte-identical to UTC evaluation", () => {
    const withUndefined = cronPrevOnOrBefore("0 9 * * *", at("2026-05-17T14:23:00Z"), undefined);
    const withoutArg = cronPrevOnOrBefore("0 9 * * *", at("2026-05-17T14:23:00Z"));
    expect(withUndefined?.toISOString()).toBe(withoutArg?.toISOString());
  });

  it("falls back to UTC for an invalid IANA zone", () => {
    const p = parseCron("0 9 * * *");
    expect(cronMatches(p, at("2026-05-17T09:00:00Z"), "Not/AZone")).toBe(true);
    expect(cronMatches(p, at("2026-05-17T13:00:00Z"), "Not/AZone")).toBe(false);
  });
});

describe("scheduledJobsDue timezone", () => {
  it("passes each scheduled job's timezone through to the tick", () => {
    const jobs = [
      JobDeclarationSchema.parse({
        id: "ny-morning",
        name: "ny-morning",
        trigger: { kind: "scheduled", cron: "0 9 * * *", timezone: "America/New_York" },
        onFailure: { strategy: "dead-letter" },
      }),
    ];
    const due = scheduledJobsDue(jobs, { now: "2026-05-17T14:23:00Z" });
    expect(due).toEqual([{ jobId: "ny-morning", fireAt: "2026-05-17T13:00:00.000Z" }]);
  });
});

function scheduledJob(id: string, cron: string, extra: Partial<JobDeclaration> = {}): JobDeclaration {
  return JobDeclarationSchema.parse({
    id,
    name: id,
    trigger: { kind: "scheduled", cron },
    onFailure: { strategy: "dead-letter" },
    ...extra,
  });
}

describe("scheduledJobsDue", () => {
  it("returns the current tick for each scheduled job, skipping non-scheduled + deprecated", () => {
    const jobs = [
      scheduledJob("overdue-reminder", "0 9 * * *"),
      scheduledJob("legacy", "0 9 * * *", { deprecated: true }),
      JobDeclarationSchema.parse({
        id: "on-order",
        name: "on-order",
        trigger: { kind: "event", eventName: "retail.order_placed" },
        onFailure: { strategy: "dead-letter" },
      }),
    ];
    const due = scheduledJobsDue(jobs, { now: "2026-05-17T14:23:00Z" });
    expect(due).toEqual([{ jobId: "overdue-reminder", fireAt: "2026-05-17T09:00:00.000Z" }]);
  });

  it("holds the same fireAt across a scheduler window, then advances", () => {
    const jobs = [scheduledJob("hourly", "0 * * * *")];
    const a = scheduledJobsDue(jobs, { now: "2026-05-17T14:10:00Z" })[0]!;
    const b = scheduledJobsDue(jobs, { now: "2026-05-17T14:59:00Z" })[0]!;
    const c = scheduledJobsDue(jobs, { now: "2026-05-17T15:00:00Z" })[0]!;
    expect(a.fireAt).toBe("2026-05-17T14:00:00.000Z");
    expect(b.fireAt).toBe("2026-05-17T14:00:00.000Z");
    expect(c.fireAt).toBe("2026-05-17T15:00:00.000Z");
  });
});
