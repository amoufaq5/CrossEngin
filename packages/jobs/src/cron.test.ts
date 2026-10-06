import { describe, expect, it } from "vitest";

import {
  cronExpressionCanEverMatch,
  cronMatches,
  cronNextAfter,
  cronPrevOnOrBefore,
  isResolvableTimeZone,
  parseCron,
  scheduledTriggerDefects,
  UTC_EQUIVALENT_ZONES,
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

/**
 * The day-skip's correctness argument is that `cronMatches` is `dateMatches && timeMatches` and the
 * date fields are constant across a local day — so these compare it against the naive
 * one-step-at-a-time search it replaced, over expressions chosen to exercise every branch. This is
 * the test that makes the optimisation trustworthy; the measurements only make it worth having.
 */
function naiveNextAfter(expr: string, after: Date, timezone?: string, maxSteps = 600_000): Date | null {
  const parsed = parseCron(expr);
  const stepMs = parsed.hasSeconds ? 1_000 : 60_000;
  const start = new Date(after.getTime());
  start.setUTCMilliseconds(0);
  if (!parsed.hasSeconds) start.setUTCSeconds(0);
  let cursor = new Date(start.getTime() + stepMs);
  for (let i = 0; i < maxSteps; i += 1) {
    if (cronMatches(parsed, cursor, timezone)) return cursor;
    cursor = new Date(cursor.getTime() + stepMs);
  }
  return null;
}

function naivePrevOnOrBefore(expr: string, now: Date, timezone?: string, maxSteps = 600_000): Date | null {
  const parsed = parseCron(expr);
  const stepMs = parsed.hasSeconds ? 1_000 : 60_000;
  const cursor0 = new Date(now.getTime());
  cursor0.setUTCMilliseconds(0);
  if (!parsed.hasSeconds) cursor0.setUTCSeconds(0);
  let cursor = cursor0;
  for (let i = 0; i < maxSteps; i += 1) {
    if (cronMatches(parsed, cursor, timezone)) return cursor;
    cursor = new Date(cursor.getTime() - stepMs);
  }
  return null;
}

describe("the day-skip is equivalent to a one-step-at-a-time search", () => {
  // Split by density, because the *naive* side is what costs: it is the implementation being
  // replaced, so a sparse expression under a real zone walks tens of thousands of `Intl` reads.
  // Dense expressions get every zone; sparse ones get three, one of which has DST.
  const DENSE = [
    "0 * * * *", // every skip is the matching-day branch
    "*/15 * * * *",
    "0 0 * * *", // one instant per day
    "30 1 * * *", // the DST fall-back hour, which happens twice
    "0 2 * * *", // the DST spring-forward hour, which does not exist
    "0 9 * * 1-5", // dow-restricted, dom unrestricted
    "0 9 1 * 1", // BOTH restricted: the dom/dow OR rule
  ] as const;
  const SPARSE = [
    "0 0 1 * *", // monthly: most days are date-mismatched and skipped
    "0 0 31 * *", // skips whole months that have no 31st
    "0 0 1,15 * *",
    "15 3 29 * *", // the 29th, which February only has in a leap year
  ] as const;
  const ALL_ZONES = [undefined, "UTC", "America/New_York", "Asia/Tokyo", "Asia/Kolkata", "Europe/London"] as const;
  const SPARSE_ZONES = [undefined, "UTC", "America/New_York"] as const;
  // Starts chosen to straddle both DST transitions, a leap day, and a year end.
  const STARTS = [
    "2026-01-31T12:00:00Z",
    "2026-03-08T06:30:00Z",
    "2026-11-01T05:30:00Z",
    "2028-02-28T23:59:00Z",
    "2026-12-31T23:59:00Z",
  ] as const;

  const cases: { expr: string; zone: string | undefined; start: string }[] = [];
  for (const expr of DENSE) for (const zone of ALL_ZONES) for (const start of STARTS) cases.push({ expr, zone, start });
  for (const expr of SPARSE) for (const zone of SPARSE_ZONES) for (const start of STARTS) cases.push({ expr, zone, start });

  it("agrees with the naive forward search on every expression x zone x start", () => {
    for (const { expr, zone, start } of cases) {
      const after = new Date(start);
      const fast = cronNextAfter(expr, after, zone);
      const slow = naiveNextAfter(expr, after, zone);
      expect(fast?.toISOString() ?? null, `next ${expr} @${start} tz=${zone ?? "-"}`).toBe(
        slow?.toISOString() ?? null,
      );
    }
    // Guards against the suite passing vacuously if a loop bound were mistyped.
    expect(cases.length).toBe(DENSE.length * ALL_ZONES.length * STARTS.length + SPARSE.length * SPARSE_ZONES.length * STARTS.length);
    expect(cases.length).toBe(270);
  });

  it("agrees with the naive backward search on every expression x zone x start", () => {
    for (const { expr, zone, start } of cases) {
      const now = new Date(start);
      const fast = cronPrevOnOrBefore(expr, now, zone);
      const slow = naivePrevOnOrBefore(expr, now, zone);
      expect(fast?.toISOString() ?? null, `prev ${expr} @${start} tz=${zone ?? "-"}`).toBe(
        slow?.toISOString() ?? null,
      );
    }
  });

  it("visits every match in a dense window, so nothing is skipped over", () => {
    // Walking forward one match at a time must enumerate exactly the matching minutes; a skip that
    // overshot by even one step would drop one.
    const parsed = parseCron("*/10 * * * *");
    const from = new Date("2026-03-08T04:00:00Z"); // across the US spring-forward
    const until = new Date("2026-03-08T10:00:00Z");
    const visited: string[] = [];
    let cursor: Date | null = from;
    while (cursor !== null) {
      cursor = cronNextAfter("*/10 * * * *", cursor, "America/New_York");
      if (cursor === null || cursor.getTime() > until.getTime()) break;
      visited.push(cursor.toISOString());
    }
    const expected: string[] = [];
    for (let t = from.getTime() + 60_000; t <= until.getTime(); t += 60_000) {
      const d = new Date(t);
      if (cronMatches(parsed, d, "America/New_York")) expected.push(d.toISOString());
    }
    expect(visited).toEqual(expected);
    expect(visited.length).toBe(36);
  });

  it("finds a leap-day cron in both directions, which the old horizon could not reach", () => {
    // The defect this exists for: 550,000 minutes is 382 days, so a 29 February search exhausted
    // the whole budget and answered `null` — 68 seconds of blocked CPU for "no tick", which
    // `scheduledJobsDue` skipped in silence. Too expensive to compare against the naive search,
    // which is the point: the naive search cannot answer these at all.
    const from = new Date("2026-01-31T12:00:00Z");
    expect(cronNextAfter("0 0 29 2 *", from, "UTC")?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
    expect(cronPrevOnOrBefore("0 0 29 2 *", from, "UTC")?.toISOString()).toBe("2024-02-29T00:00:00.000Z");
    // Local midnight in Tokyo on the leap day is 15:00Z the day before.
    expect(cronNextAfter("0 0 29 2 *", from, "Asia/Tokyo")?.toISOString()).toBe("2028-02-28T15:00:00.000Z");
    // An annual cron, also beyond the old reach once a zone forced the slow path.
    expect(cronNextAfter("0 0 1 1 *", from, "America/New_York")?.toISOString()).toBe("2027-01-01T05:00:00.000Z");
  });

  it("still answers null for a date that cannot exist", () => {
    const from = new Date("2026-01-31T12:00:00Z");
    expect(cronNextAfter("0 0 30 2 *", from, "UTC")).toBeNull();
    expect(cronPrevOnOrBefore("0 0 31 2 *", from)).toBeNull();
  });
});

describe("cronCanEverMatch", () => {
  const can = (expr: string): boolean => cronExpressionCanEverMatch(expr);

  it("accepts every reachable shape", () => {
    for (const expr of ["0 * * * *", "0 0 1 * *", "0 0 31 * *", "0 0 29 2 *", "0 9 * * 1-5", "0 0 1 1 *"]) {
      expect(can(expr), expr).toBe(true);
    }
  });

  it("refuses a date that does not exist", () => {
    // 30 and 31 February, 31 April/June/September/November.
    expect(can("0 0 30 2 *")).toBe(false);
    expect(can("0 0 31 2 *")).toBe(false);
    expect(can("0 0 31 4 *")).toBe(false);
    expect(can("0 0 31 4,6,9,11 *")).toBe(false);
  });

  it("accepts 29 February, which is reachable in a leap year", () => {
    // The distinction the old `null` could not make: this fires, 30 February never does.
    expect(can("0 0 29 2 *")).toBe(true);
  });

  it("accepts an impossible dom when one month in the set does have that day", () => {
    expect(can("0 0 31 2,3 *")).toBe(true); // 31 March
    expect(can("0 0 30,31 2 *")).toBe(false); // neither exists in February
  });

  it("is true whenever the dom/dow OR rule applies, because the dow arm matches weekly", () => {
    // `31 2` is impossible by date, but with dow restricted the rule is OR, so every Monday in
    // February matches. Reading this as unreachable would refuse a declaration that does fire.
    expect(can("0 0 31 2 1")).toBe(true);
    expect(can("0 0 30 2 0")).toBe(true);
  });

  it("is true whenever dom is unrestricted, since every month has a first", () => {
    expect(can("0 0 * 2 *")).toBe(true);
    expect(can("0 0 * * *")).toBe(true);
  });

  it("agrees with a search for every case it calls reachable", () => {
    // The two must not disagree: a declaration this admits and the search cannot find would be a
    // job that never runs, which is the defect in a new place.
    const from = new Date("2026-01-31T12:00:00Z");
    for (const expr of ["0 0 29 2 *", "0 0 31 2,3 *", "0 0 31 2 1", "0 0 1 1 *", "0 0 31 * *"]) {
      expect(can(expr), expr).toBe(true);
      expect(cronNextAfter(expr, from), `search ${expr}`).not.toBeNull();
    }
    for (const expr of ["0 0 30 2 *", "0 0 31 4 *"]) {
      expect(can(expr), expr).toBe(false);
      expect(cronNextAfter(expr, from), `search ${expr}`).toBeNull();
    }
  });
});

describe("isResolvableTimeZone", () => {
  it("resolves real IANA zones", () => {
    for (const z of ["UTC", "America/New_York", "Asia/Tokyo", "Europe/London", "Asia/Kolkata", "Etc/GMT+5"]) {
      expect(isResolvableTimeZone(z), z).toBe(true);
    }
  });

  it("refuses a typo, which used to fall through to UTC in silence", () => {
    for (const z of ["Erope/London", "America/Nowhere", "", "Not A Zone", "UTC+1"]) {
      expect(isResolvableTimeZone(z), z).toBe(false);
    }
  });

  it("answers the same on a repeat, so the cached refusal is not a one-shot", () => {
    expect(isResolvableTimeZone("Erope/London")).toBe(false);
    expect(isResolvableTimeZone("Erope/London")).toBe(false);
    expect(isResolvableTimeZone("Asia/Tokyo")).toBe(true);
    expect(isResolvableTimeZone("Asia/Tokyo")).toBe(true);
  });

  it("reads a UTC-equivalent zone identically to no zone at all", () => {
    // The optimisation's only promise: it cannot change the answer, just the cost.
    const from = new Date("2026-01-31T12:00:00Z");
    const bare = cronNextAfter("0 0 31 * *", from)?.toISOString();
    for (const z of ["UTC", "Etc/UTC", "GMT", "Etc/GMT", "Etc/GMT+0", "Etc/GMT-0", "Universal", "Zulu"]) {
      expect(cronNextAfter("0 0 31 * *", from, z)?.toISOString(), z).toBe(bare);
    }
  });
});

describe("scheduledTriggerDefects", () => {
  it("finds nothing wrong with what the shipped packs declare", () => {
    for (const cron of ["0 * * * *", "0 5 * * *", "0 6 * * *", "0 7 * * *"]) {
      expect(scheduledTriggerDefects({ cron, timezone: "UTC" })).toEqual([]);
    }
  });

  it("names an unresolvable zone", () => {
    expect(scheduledTriggerDefects({ cron: "0 0 * * *", timezone: "Erope/London" })).toEqual([
      "timezone_unresolvable",
    ]);
  });

  it("names a cron that can never match", () => {
    expect(scheduledTriggerDefects({ cron: "0 0 30 2 *" })).toEqual(["cron_never_matches"]);
  });

  it("names both at once rather than stopping at the first", () => {
    expect(scheduledTriggerDefects({ cron: "0 0 30 2 *", timezone: "Erope/London" })).toEqual([
      "timezone_unresolvable",
      "cron_never_matches",
    ]);
  });

  it("leaves a malformed expression to the expression schema", () => {
    // Not this function's refusal: reporting it here too would give one defect two names.
    expect(scheduledTriggerDefects({ cron: "not a cron" })).toEqual([]);
  });

  it("says nothing about an absent timezone, which legitimately means UTC", () => {
    expect(scheduledTriggerDefects({ cron: "0 0 * * *" })).toEqual([]);
  });
});

describe("scheduledJobsDue reporting", () => {
  const job = (over: Record<string, unknown> = {}): never =>
    ({
      id: "close-books",
      kind: "scheduled",
      description: "x",
      trigger: { kind: "scheduled", cron: "0 0 * * *", timezone: "UTC" },
      ...over,
    }) as never;

  it("reports a job whose cron can never match instead of skipping it in silence", () => {
    const seen: unknown[] = [];
    const due = scheduledJobsDue(
      [job({ trigger: { kind: "scheduled", cron: "0 0 30 2 *" } })],
      { now: "2026-01-31T12:00:00Z", onUnschedulable: (u) => seen.push(u) },
    );
    expect(due).toEqual([]);
    expect(seen).toEqual([
      { jobId: "close-books", cron: "0 0 30 2 *", reason: "cron_never_matches" },
    ]);
  });

  it("reports nothing for a job that ticks", () => {
    const seen: unknown[] = [];
    const due = scheduledJobsDue([job()], {
      now: "2026-01-31T12:00:00Z",
      onUnschedulable: (u) => seen.push(u),
    });
    expect(due).toEqual([{ jobId: "close-books", fireAt: "2026-01-31T00:00:00.000Z" }]);
    expect(seen).toEqual([]);
  });

  it("does not throw when no reporter is supplied, since it runs per tenant per tick", () => {
    expect(() =>
      scheduledJobsDue([job({ trigger: { kind: "scheduled", cron: "0 0 30 2 *" } })], {
        now: "2026-01-31T12:00:00Z",
      }),
    ).not.toThrow();
  });

  it("ticks a leap-day job in a leap year, which used to be unreachable", () => {
    const due = scheduledJobsDue([job({ trigger: { kind: "scheduled", cron: "0 0 29 2 *" } })], {
      now: "2028-02-29T06:00:00Z",
    });
    expect(due).toEqual([{ jobId: "close-books", fireAt: "2028-02-29T00:00:00.000Z" }]);
  });
});

describe("UTC_EQUIVALENT_ZONES", () => {
  it("contains only zones this runtime can actually resolve", () => {
    // The invariant that keeps the optimisation safe. A member `Intl` rejects would be routed to
    // the UTC reader and so silently accepted, while `isResolvableTimeZone` refused it — the two
    // would disagree, and the refusal is the one that exists to catch a typo. `"Z"` is exactly that
    // trap: a legal ISO designator that is not a zone. It was in the first draft of the set.
    for (const zone of UTC_EQUIVALENT_ZONES) {
      expect(isResolvableTimeZone(zone), zone).toBe(true);
    }
    expect(UTC_EQUIVALENT_ZONES.has("Z")).toBe(false);
    expect(isResolvableTimeZone("Z")).toBe(false);
  });

  it("excludes a zero-offset-today zone that is not zero-offset always", () => {
    // Europe/London is UTC in January and UTC+1 in July.
    expect(UTC_EQUIVALENT_ZONES.has("Europe/London")).toBe(false);
    // 01:00 British Summer Time is midnight UTC, so the two zones answer an hour apart in July —
    // which is why a prefix match on "GMT"-ish names, or treating London as UTC, would be wrong.
    const summer = new Date("2026-06-30T23:30:00Z");
    expect(cronNextAfter("0 1 * * *", summer, "Europe/London")?.toISOString()).toBe(
      "2026-07-01T00:00:00.000Z",
    );
    expect(cronNextAfter("0 1 * * *", summer, "UTC")?.toISOString()).toBe(
      "2026-07-01T01:00:00.000Z",
    );
  });
});
