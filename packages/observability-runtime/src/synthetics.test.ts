import { describe, expect, it } from "vitest";
import type { SyntheticCheckDeclaration } from "@crossengin/observability";
import {
  SyntheticResultSchema,
  SyntheticTracker,
  consecutiveFailures,
  evaluateSynthetic,
  evaluateSyntheticByRegion,
  type SyntheticResult,
} from "./synthetics.js";

const decl: SyntheticCheckDeclaration = {
  id: "orders-http",
  name: "Orders endpoint probe",
  schedule: "*/5 * * * *",
  region: "us-east",
  check: { kind: "http", url: "https://api.example.com/health", method: "GET", expectStatus: [200], timeoutMs: 5_000 },
  alertAfterConsecutiveFailures: 2,
};

const result = (
  outcome: "pass" | "fail",
  offsetMin: number,
  checkId = "orders-http",
): SyntheticResult => ({
  checkId,
  region: "us-east",
  outcome,
  at: new Date(Date.parse("2026-06-02T12:00:00.000Z") + offsetMin * 60_000).toISOString(),
});

describe("SyntheticResultSchema", () => {
  it("accepts a valid result", () => {
    expect(SyntheticResultSchema.safeParse(result("pass", 0)).success).toBe(true);
  });
  it("rejects an unknown outcome", () => {
    const res = SyntheticResultSchema.safeParse({ ...result("pass", 0), outcome: "maybe" });
    expect(res.success).toBe(false);
  });
  it("rejects unknown keys", () => {
    const res = SyntheticResultSchema.safeParse({ ...result("pass", 0), foo: 1 });
    expect(res.success).toBe(false);
  });
});

describe("consecutiveFailures", () => {
  it("counts trailing failures", () => {
    expect(
      consecutiveFailures([result("pass", 0), result("fail", 1), result("fail", 2)]),
    ).toBe(2);
  });
  it("resets when the latest is a pass", () => {
    expect(consecutiveFailures([result("fail", 0), result("pass", 1)])).toBe(0);
  });
  it("is 0 for an empty history", () => {
    expect(consecutiveFailures([])).toBe(0);
  });
});

describe("evaluateSynthetic", () => {
  it("does not alert below the threshold", () => {
    const ev = evaluateSynthetic(decl, [result("fail", 0)]);
    expect(ev.alerting).toBe(false);
    expect(ev.consecutiveFailures).toBe(1);
  });

  it("alerts once consecutive failures meet the threshold", () => {
    const ev = evaluateSynthetic(decl, [result("fail", 0), result("fail", 1)]);
    expect(ev.alerting).toBe(true);
    expect(ev.lastOutcome).toBe("fail");
  });

  it("ignores results for other checks", () => {
    const ev = evaluateSynthetic(decl, [
      result("fail", 0, "other"),
      result("fail", 1, "other"),
      result("pass", 2),
    ]);
    expect(ev.consecutiveFailures).toBe(0);
    expect(ev.lastOutcome).toBe("pass");
  });
});

describe("evaluateSynthetic region scoping", () => {
  const inRegion = (
    outcome: "pass" | "fail",
    offsetMin: number,
    region: string,
  ): SyntheticResult => ({ ...result(outcome, offsetMin), region });

  it("alerts on a region that is permanently down even while a sibling passes", () => {
    // Interleaved, which is what one check id probed from two regions produces. Folded across
    // regions this reads pass/fail/pass/fail and never reaches the threshold of 2.
    const results = [
      inRegion("fail", 0, "us-east"),
      inRegion("pass", 0, "eu-west"),
      inRegion("fail", 5, "us-east"),
      inRegion("pass", 5, "eu-west"),
    ];
    expect(evaluateSynthetic(decl, results).alerting).toBe(true);
    expect(evaluateSynthetic(decl, results).consecutiveFailures).toBe(2);
  });

  it("does not alert when three regions each fail once", () => {
    // Folded across regions this reads as three consecutive failures and pages for nothing.
    const results = [
      inRegion("pass", 0, "us-east"),
      inRegion("fail", 1, "eu-west"),
      inRegion("fail", 2, "ap-south"),
      inRegion("fail", 3, "sa-east"),
    ];
    expect(evaluateSynthetic(decl, results).alerting).toBe(false);
    expect(evaluateSynthetic(decl, results).consecutiveFailures).toBe(0);
  });

  it("names the region it is a verdict about", () => {
    expect(evaluateSynthetic(decl, []).region).toBe("us-east");
  });

  it("orders by `at` rather than by arrival", () => {
    // A retry or a batch flush delivers the older result last; a trailing fold over arrival order
    // then reads the recovery as the failure and the failure as current.
    const ev = evaluateSynthetic(decl, [result("fail", 5), result("fail", 4), result("pass", 6)]);
    expect(ev.lastOutcome).toBe("pass");
    expect(ev.consecutiveFailures).toBe(0);
  });

  it("evaluates each observed region separately", () => {
    const evs = evaluateSyntheticByRegion(decl, [
      inRegion("fail", 0, "us-east"),
      inRegion("fail", 1, "us-east"),
      inRegion("pass", 1, "eu-west"),
    ]);
    expect(evs.map((e) => e.region)).toEqual(["eu-west", "us-east"]);
    expect(evs.find((e) => e.region === "us-east")?.alerting).toBe(true);
    expect(evs.find((e) => e.region === "eu-west")?.alerting).toBe(false);
  });
});

describe("SyntheticTracker", () => {
  it("records and evaluates against a declaration", () => {
    const tracker = new SyntheticTracker();
    tracker.record(result("fail", 0));
    tracker.record(result("fail", 1));
    expect(tracker.evaluate(decl).alerting).toBe(true);
    expect(tracker.resultsFor("orders-http")).toHaveLength(2);
  });

  it("caps stored results per check", () => {
    const tracker = new SyntheticTracker(3);
    for (let i = 0; i < 10; i += 1) tracker.record(result("pass", i));
    expect(tracker.resultsFor("orders-http").length).toBeLessThanOrEqual(3);
  });

  it("caps how many check ids it tracks", () => {
    const tracker = new SyntheticTracker(10, 2);
    for (let i = 0; i < 5; i += 1) tracker.record(result("pass", i, `check-${i.toString()}`));
    expect(tracker.stats().checks).toBe(2);
    expect(tracker.stats().evictedChecks).toBe(3);
    expect(tracker.resultsFor("check-0")).toHaveLength(0);
    expect(tracker.resultsFor("check-4")).toHaveLength(1);
  });

  it("refuses a non-positive check bound", () => {
    expect(() => new SyntheticTracker(10, 0)).toThrow(/maxChecks/);
  });
});
