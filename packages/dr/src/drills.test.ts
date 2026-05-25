import { describe, expect, it } from "vitest";
import { DEFAULT_DR_TIERS } from "./tiers.js";
import {
  DRILL_KINDS,
  DRILL_OUTCOMES,
  DrillRecordSchema,
  drillCadenceMet,
  exceededRpoInDrill,
  exceededRtoInDrill,
  isDrillPassing,
  isOverdue,
  lastSuccessfulDrill,
  overdueDrills,
  type DrillRecord,
} from "./drills.js";

describe("constants", () => {
  it("DRILL_KINDS has 5 entries", () => {
    expect(DRILL_KINDS).toContain("tabletop");
    expect(DRILL_KINDS).toContain("full_regional");
    expect(DRILL_KINDS).toContain("chaos_injection");
  });

  it("DRILL_OUTCOMES has 5 entries", () => {
    expect(DRILL_OUTCOMES).toContain("passed_with_findings");
    expect(DRILL_OUTCOMES).toContain("not_executed");
  });
});

describe("DrillRecordSchema", () => {
  const base: DrillRecord = {
    id: "d-1",
    kind: "failover_test",
    tier: "tier_1_business_critical",
    scheduledFor: "2026-05-14T10:00:00Z",
    executedAt: "2026-05-14T10:05:00Z",
    executedBy: "drill-runner",
    scopeRegions: ["eu-central", "eu-west"],
    scopeApps: ["web"],
    outcome: "passed",
    measuredRpoSeconds: 30,
    measuredRtoSeconds: 270,
    findings: [],
    nextDrillDueAt: "2026-08-14T10:00:00Z",
  };

  it("accepts a valid passed drill", () => {
    expect(() => DrillRecordSchema.parse(base)).not.toThrow();
  });

  it("rejects executed outcome without executedAt", () => {
    expect(() => DrillRecordSchema.parse({ ...base, executedAt: null })).toThrow(/executedAt/);
  });

  it("rejects executed outcome without executedBy", () => {
    expect(() => DrillRecordSchema.parse({ ...base, executedBy: null })).toThrow(/executedBy/);
  });

  it("rejects failover_test without measuredRpoSeconds", () => {
    expect(() => DrillRecordSchema.parse({ ...base, measuredRpoSeconds: null })).toThrow(
      /measuredRpoSeconds/,
    );
  });

  it("rejects failover_test without measuredRtoSeconds", () => {
    expect(() => DrillRecordSchema.parse({ ...base, measuredRtoSeconds: null })).toThrow(
      /measuredRtoSeconds/,
    );
  });

  it("rejects passed_with_findings without findings", () => {
    expect(() => DrillRecordSchema.parse({ ...base, outcome: "passed_with_findings" })).toThrow(
      /at least one finding/,
    );
  });

  it("rejects failed without findings", () => {
    expect(() =>
      DrillRecordSchema.parse({
        ...base,
        outcome: "failed",
        measuredRpoSeconds: null,
        measuredRtoSeconds: null,
      }),
    ).toThrow(/at least one finding/);
  });

  it("rejects nextDrillDueAt before scheduledFor", () => {
    expect(() =>
      DrillRecordSchema.parse({
        ...base,
        nextDrillDueAt: "2026-04-14T10:00:00Z",
      }),
    ).toThrow(/nextDrillDueAt must be after/);
  });

  it("rejects duplicate finding ids", () => {
    expect(() =>
      DrillRecordSchema.parse({
        ...base,
        outcome: "passed_with_findings",
        findings: [
          { id: "f-1", severity: "minor", description: "x" },
          { id: "f-1", severity: "major", description: "y" },
        ],
      }),
    ).toThrow(/duplicate finding id/);
  });

  it("accepts a tabletop drill without RPO/RTO measurements", () => {
    expect(() =>
      DrillRecordSchema.parse({
        ...base,
        kind: "tabletop",
        measuredRpoSeconds: null,
        measuredRtoSeconds: null,
      }),
    ).not.toThrow();
  });
});

describe("helpers", () => {
  const base: DrillRecord = {
    id: "d-1",
    kind: "failover_test",
    tier: "tier_1_business_critical",
    scheduledFor: "2026-05-14T10:00:00Z",
    executedAt: "2026-05-14T10:05:00Z",
    executedBy: "drill-runner",
    scopeRegions: ["eu-central", "eu-west"],
    scopeApps: ["web"],
    outcome: "passed",
    measuredRpoSeconds: 30,
    measuredRtoSeconds: 270,
    findings: [],
    nextDrillDueAt: "2026-08-14T10:00:00Z",
  };

  it("isDrillPassing returns true for 'passed'", () => {
    expect(isDrillPassing(base)).toBe(true);
  });

  it("isDrillPassing returns true for 'passed_with_findings'", () => {
    expect(
      isDrillPassing({
        ...base,
        outcome: "passed_with_findings",
        findings: [{ id: "f-1", severity: "minor", description: "x", resolvedAt: null }],
      }),
    ).toBe(true);
  });

  it("isDrillPassing returns false for 'failed'", () => {
    expect(
      isDrillPassing({
        ...base,
        outcome: "failed",
        measuredRpoSeconds: null,
        measuredRtoSeconds: null,
        findings: [{ id: "f-1", severity: "critical", description: "x", resolvedAt: null }],
      }),
    ).toBe(false);
  });

  it("isOverdue returns true when now >= nextDrillDueAt", () => {
    expect(isOverdue(base, new Date("2026-09-01T00:00:00Z"))).toBe(true);
  });

  it("isOverdue returns false when now < nextDrillDueAt", () => {
    expect(isOverdue(base, new Date("2026-07-01T00:00:00Z"))).toBe(false);
  });

  it("lastSuccessfulDrill returns null for empty input", () => {
    expect(lastSuccessfulDrill([], "failover_test")).toBeNull();
  });

  it("lastSuccessfulDrill returns the most recent passing drill of the given kind", () => {
    const older = { ...base, id: "d-0", executedAt: "2026-01-01T10:00:00Z" };
    const newer = { ...base, id: "d-1", executedAt: "2026-05-01T10:00:00Z" };
    expect(lastSuccessfulDrill([older, newer], "failover_test")?.id).toBe("d-1");
  });

  it("overdueDrills filters overdue drills", () => {
    const overdue = { ...base, id: "d-o", nextDrillDueAt: "2026-01-01T00:00:00Z" };
    expect(
      overdueDrills([base, overdue], new Date("2026-03-01T00:00:00Z")).map((r) => r.id),
    ).toEqual(["d-o"]);
  });

  it("exceededRpoInDrill catches RPO exceedance", () => {
    expect(
      exceededRpoInDrill(
        { ...base, measuredRpoSeconds: 120 },
        DEFAULT_DR_TIERS.tier_1_business_critical,
      ),
    ).toBe(true);
  });

  it("exceededRtoInDrill catches RTO exceedance", () => {
    expect(
      exceededRtoInDrill(
        { ...base, measuredRtoSeconds: 1800 },
        DEFAULT_DR_TIERS.tier_1_business_critical,
      ),
    ).toBe(true);
  });

  it("drillCadenceMet returns true when nextDrillDueAt is within tier cadence", () => {
    expect(
      drillCadenceMet(
        { ...base, nextDrillDueAt: "2026-07-14T10:00:00Z" },
        DEFAULT_DR_TIERS.tier_1_business_critical,
      ),
    ).toBe(true);
  });

  it("drillCadenceMet returns false when nextDrillDueAt is too far out", () => {
    expect(
      drillCadenceMet(
        { ...base, nextDrillDueAt: "2027-08-14T10:00:00Z" },
        DEFAULT_DR_TIERS.tier_1_business_critical,
      ),
    ).toBe(false);
  });
});
