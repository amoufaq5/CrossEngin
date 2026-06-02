import { describe, expect, it } from "vitest";
import type { SyntheticCheckDeclaration } from "@crossengin/observability";
import {
  SyntheticResultSchema,
  SyntheticTracker,
  consecutiveFailures,
  evaluateSynthetic,
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
});
