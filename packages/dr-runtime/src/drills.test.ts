import { describe, expect, it } from "vitest";
import { DEFAULT_DR_TIERS, DrillRecordSchema, type DrillFinding } from "@crossengin/dr";
import { CountingIdGenerator, FixedClock } from "./clock.js";
import { DRILL_ID_PREFIX, DrillExecutor, type PlanDrillInput } from "./drills.js";

const TIER1 = DEFAULT_DR_TIERS.tier_1_business_critical;

function makeExecutor(): DrillExecutor {
  return new DrillExecutor({
    clock: new FixedClock(new Date("2026-01-01T00:00:00.000Z")),
    ids: new CountingIdGenerator(),
  });
}

const BASE_INPUT: PlanDrillInput = {
  kind: "failover_test",
  tier: "tier_1_business_critical",
  scopeRegions: ["us-east", "us-west"],
  scopeApps: ["billing"],
  spec: TIER1,
};

const FINDING: DrillFinding = {
  id: "slow-dns-cutover",
  severity: "minor",
  description: "DNS cutover took longer than expected",
  resolvedAt: null,
};

describe("planDrill", () => {
  it("produces a validated not_executed drill with a drl_ id", () => {
    const record = makeExecutor().planDrill(BASE_INPUT);
    expect(record.outcome).toBe("not_executed");
    expect(record.id).toBe(`${DRILL_ID_PREFIX}_00000001`);
    expect(record.executedAt).toBeNull();
    expect(record.executedBy).toBeNull();
    expect(DrillRecordSchema.parse(record)).toEqual(record);
  });

  it("derives nextDrillDueAt from the tier cadence", () => {
    const record = makeExecutor().planDrill(BASE_INPUT);
    // tier_1 cadence is 90 days from 2026-01-01
    expect(record.nextDrillDueAt).toBe("2026-04-01T00:00:00.000Z");
  });

  it("derives nextDrillDueAt from an explicit cadenceDays", () => {
    const record = makeExecutor().planDrill({
      kind: "tabletop",
      tier: "tier_2_important",
      scopeRegions: ["eu-west"],
      scopeApps: ["portal"],
      cadenceDays: 30,
    });
    expect(record.nextDrillDueAt).toBe("2026-01-31T00:00:00.000Z");
  });

  it("accepts an explicit nextDrillDueAt", () => {
    const record = makeExecutor().planDrill({
      kind: "tabletop",
      tier: "tier_3_recoverable",
      scopeRegions: ["us-east"],
      scopeApps: ["internal"],
      nextDrillDueAt: "2026-12-01T00:00:00.000Z",
    });
    expect(record.nextDrillDueAt).toBe("2026-12-01T00:00:00.000Z");
  });

  it("throws when no due date can be derived", () => {
    expect(() =>
      makeExecutor().planDrill({
        kind: "tabletop",
        tier: "tier_3_recoverable",
        scopeRegions: ["us-east"],
        scopeApps: ["internal"],
      }),
    ).toThrow(/nextDrillDueAt/);
  });
});

describe("recordDrillResult", () => {
  it("records a passing failover_test with measured RPO/RTO", () => {
    const exec = makeExecutor();
    const planned = exec.planDrill(BASE_INPUT);
    const record = exec.recordDrillResult(planned, {
      outcome: "passed",
      executedBy: "sre-lead",
      measuredRpoSeconds: 40,
      measuredRtoSeconds: 400,
    });
    expect(record.outcome).toBe("passed");
    expect(record.executedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(record.executedBy).toBe("sre-lead");
    expect(record.measuredRpoSeconds).toBe(40);
  });

  it("records passed_with_findings when a finding is attached", () => {
    const exec = makeExecutor();
    const record = exec.recordDrillResult(exec.planDrill(BASE_INPUT), {
      outcome: "passed_with_findings",
      executedBy: "sre-lead",
      measuredRpoSeconds: 40,
      measuredRtoSeconds: 400,
      findings: [FINDING],
    });
    expect(record.findings).toHaveLength(1);
  });

  it("rejects a passing failover_test without measured RPO/RTO", () => {
    const exec = makeExecutor();
    expect(() =>
      exec.recordDrillResult(exec.planDrill(BASE_INPUT), {
        outcome: "passed",
        executedBy: "sre-lead",
      }),
    ).toThrow();
  });

  it("rejects passed_with_findings with no findings", () => {
    const exec = makeExecutor();
    expect(() =>
      exec.recordDrillResult(exec.planDrill(BASE_INPUT), {
        outcome: "passed_with_findings",
        executedBy: "sre-lead",
        measuredRpoSeconds: 40,
        measuredRtoSeconds: 400,
      }),
    ).toThrow();
  });

  it("rejects a failed drill with no findings", () => {
    const exec = makeExecutor();
    expect(() =>
      exec.recordDrillResult(exec.planDrill(BASE_INPUT), {
        outcome: "failed",
        executedBy: "sre-lead",
      }),
    ).toThrow();
  });
});

describe("drillTierVerdict", () => {
  it("passes within budget", () => {
    const exec = makeExecutor();
    const record = exec.recordDrillResult(exec.planDrill(BASE_INPUT), {
      outcome: "passed",
      executedBy: "sre-lead",
      measuredRpoSeconds: 40,
      measuredRtoSeconds: 400,
    });
    expect(exec.drillTierVerdict(record, TIER1)).toEqual({
      rpoBreached: false,
      rtoBreached: false,
      passing: true,
    });
  });

  it("flags an RPO breach", () => {
    const exec = makeExecutor();
    const record = exec.recordDrillResult(exec.planDrill(BASE_INPUT), {
      outcome: "passed",
      executedBy: "sre-lead",
      measuredRpoSeconds: 120,
      measuredRtoSeconds: 400,
    });
    const verdict = exec.drillTierVerdict(record, TIER1);
    expect(verdict.rpoBreached).toBe(true);
    expect(verdict.passing).toBe(true);
  });

  it("reports passing=false for a failed drill", () => {
    const exec = makeExecutor();
    const record = exec.recordDrillResult(exec.planDrill(BASE_INPUT), {
      outcome: "failed",
      executedBy: "sre-lead",
      measuredRpoSeconds: 40,
      measuredRtoSeconds: 400,
      findings: [{ ...FINDING, severity: "critical" }],
    });
    expect(exec.drillTierVerdict(record, TIER1).passing).toBe(false);
  });
});
