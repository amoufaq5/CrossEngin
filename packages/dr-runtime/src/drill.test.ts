import { DEFAULT_DR_TIERS, DrillRecordSchema, type DrillRecord } from "@crossengin/dr";
import { describe, expect, it } from "vitest";

import { assessDrill, drillReadiness } from "./drill.js";

const TIER1 = DEFAULT_DR_TIERS["tier_1_business_critical"]; // maxRpo 60, maxRto 900, cadence 30d

const FAILED_FINDING = { id: "f1", severity: "major" as const, description: "promotion stalled" };

function drill(over: Partial<DrillRecord> = {}): DrillRecord {
  const outcome = over.outcome ?? "passed";
  // a 'failed' / 'passed_with_findings' outcome requires at least one finding
  const needsFinding = outcome === "failed" || outcome === "passed_with_findings";
  return DrillRecordSchema.parse({
    id: "dr-1",
    kind: "failover_test",
    tier: "tier_1_business_critical",
    scheduledFor: "2026-06-01T00:00:00.000Z",
    executedAt: "2026-06-01T00:30:00.000Z",
    executedBy: "ops",
    scopeRegions: ["us-east", "us-west"],
    scopeApps: ["operate-server"],
    outcome: "passed",
    measuredRpoSeconds: 30,
    measuredRtoSeconds: 300,
    findings: needsFinding ? [FAILED_FINDING] : [],
    nextDrillDueAt: "2026-07-01T00:00:00.000Z",
    ...over,
  });
}

describe("assessDrill", () => {
  it("meets the target for a passing drill within RPO/RTO", () => {
    expect(assessDrill(drill(), TIER1)).toMatchObject({ passing: true, rpoMet: true, rtoMet: true, met: true });
  });

  it("does not meet on a failed outcome", () => {
    expect(assessDrill(drill({ outcome: "failed" }), TIER1)).toMatchObject({ passing: false, met: false });
  });

  it("does not meet when measured RPO exceeds the tier", () => {
    expect(assessDrill(drill({ measuredRpoSeconds: 120 }), TIER1)).toMatchObject({ rpoMet: false, met: false });
  });
});

describe("drillReadiness", () => {
  it("reports the last successful drill + currentlyMet", () => {
    const r = drillReadiness([drill({ id: "old", outcome: "failed" }), drill({ id: "good" })], "failover_test", TIER1, new Date("2026-06-15T00:00:00.000Z"));
    expect(r.lastSuccessful?.id).toBe("good");
    expect(r.currentlyMet).toBe(true);
    expect(r.overdue).toEqual([]); // nextDrillDueAt 2026-07-01 is in the future
  });

  it("flags overdue drills (past nextDrillDueAt)", () => {
    const r = drillReadiness([drill({ nextDrillDueAt: "2026-06-10T00:00:00.000Z" })], "failover_test", TIER1, new Date("2026-06-15T00:00:00.000Z"));
    expect(r.overdue).toHaveLength(1);
  });

  it("currentlyMet is false when there is no successful drill", () => {
    const r = drillReadiness([drill({ outcome: "failed" })], "failover_test", TIER1, new Date("2026-06-15T00:00:00.000Z"));
    expect(r.lastSuccessful).toBeNull();
    expect(r.currentlyMet).toBe(false);
  });
});
