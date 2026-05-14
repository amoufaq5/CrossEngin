import { describe, expect, it } from "vitest";
import {
  computeFlakeStats,
  FlakeQuarantineTicketSchema,
  FLAKE_QUARANTINE_THRESHOLD,
  flakesToQuarantine,
  isTicketOverdue,
  TestRunRecordSchema,
} from "./flake.js";

const now = "2026-05-13T10:00:00.000Z";

function record(
  testId: string,
  outcome: "passed" | "failed" | "timed_out" | "skipped",
): import("./flake.js").TestRunRecord {
  return TestRunRecordSchema.parse({
    testId,
    ranAt: now,
    outcome,
    durationMs: 100,
    commit: "abc",
  });
}

describe("FLAKE_QUARANTINE_THRESHOLD", () => {
  it("matches the ADR's 5% threshold", () => {
    expect(FLAKE_QUARANTINE_THRESHOLD).toBe(0.05);
  });
});

describe("computeFlakeStats", () => {
  it("returns 0 flake-rate for an all-passing test", () => {
    const records = Array.from({ length: 50 }, () => record("a", "passed"));
    const stats = computeFlakeStats(records);
    expect(stats[0]?.flakeRate).toBe(0);
    expect(stats[0]?.recommended).toBe("active");
  });

  it("flags a test with 10% failures over 50 runs", () => {
    const records = [
      ...Array.from({ length: 45 }, () => record("flaky", "passed")),
      ...Array.from({ length: 5 }, () => record("flaky", "failed")),
    ];
    const stats = computeFlakeStats(records);
    const flaky = stats.find((s) => s.testId === "flaky");
    expect(flaky?.flakeRate).toBeCloseTo(0.1, 5);
    expect(flaky?.recommended).toBe("quarantine");
  });

  it("does not quarantine a test that always fails (it's broken, not flaky)", () => {
    const records = Array.from({ length: 10 }, () => record("broken", "failed"));
    const stats = computeFlakeStats(records);
    expect(stats[0]?.recommended).toBe("active");
  });

  it("ignores skipped runs in the rate calculation", () => {
    const records = [
      ...Array.from({ length: 10 }, () => record("x", "passed")),
      ...Array.from({ length: 20 }, () => record("x", "skipped")),
    ];
    const stats = computeFlakeStats(records);
    expect(stats[0]?.totalRuns).toBe(10);
  });

  it("rejects out-of-range thresholds", () => {
    expect(() => computeFlakeStats([], 1.5)).toThrow();
    expect(() => computeFlakeStats([], -0.1)).toThrow();
  });
});

describe("flakesToQuarantine", () => {
  it("returns ids that breach the threshold", () => {
    const records = [
      ...Array.from({ length: 90 }, () => record("flaky", "passed")),
      ...Array.from({ length: 10 }, () => record("flaky", "failed")),
      ...Array.from({ length: 100 }, () => record("stable", "passed")),
    ];
    expect(flakesToQuarantine(records)).toEqual(["flaky"]);
  });
});

describe("FlakeQuarantineTicketSchema + isTicketOverdue", () => {
  const ticket = FlakeQuarantineTicketSchema.parse({
    testId: "flaky",
    quarantinedAt: now,
    quarantineSlaDays: 7,
    flakeRate: 0.12,
    runsAnalyzed: 50,
  });

  it("rejects tickets below the quarantine threshold", () => {
    expect(() =>
      FlakeQuarantineTicketSchema.parse({
        testId: "x",
        quarantinedAt: now,
        flakeRate: 0.02,
        runsAnalyzed: 10,
      }),
    ).toThrow(/no quarantine needed/);
  });

  it("isTicketOverdue returns true past SLA", () => {
    const later = new Date(new Date(now).getTime() + 8 * 86_400_000);
    expect(isTicketOverdue(ticket, later)).toBe(true);
  });

  it("isTicketOverdue returns false inside SLA", () => {
    const within = new Date(new Date(now).getTime() + 3 * 86_400_000);
    expect(isTicketOverdue(ticket, within)).toBe(false);
  });
});
