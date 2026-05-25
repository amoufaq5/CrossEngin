import { describe, expect, it } from "vitest";
import {
  IMPACT_ORDER,
  LIKELIHOOD_ORDER,
  riskScore,
  sortByRisk,
  ThreatEntrySchema,
  ThreatModelSchema,
} from "./threat-model.js";

const baseEntry = (overrides: Record<string, unknown>) => ({
  id: "x",
  threat: "x",
  likelihood: "low" as const,
  impact: "minor" as const,
  primaryMitigation: "x",
  ...overrides,
});

describe("ThreatEntrySchema", () => {
  it("parses a typical entry", () => {
    const e = ThreatEntrySchema.parse(
      baseEntry({
        id: "t1",
        threat: "Cross-tenant data leak",
        likelihood: "low",
        impact: "catastrophic",
        primaryMitigation: "ADR-0002 RLS",
        secondaryMitigations: ["ADR-0008 audit", "RLS defense-in-depth"],
      }),
    );
    expect(e.secondaryMitigations).toHaveLength(2);
  });

  it("rejects unknown likelihood or impact", () => {
    expect(() => ThreatEntrySchema.parse(baseEntry({ likelihood: "extreme" }))).toThrow();
    expect(() => ThreatEntrySchema.parse(baseEntry({ impact: "huge" }))).toThrow();
  });
});

describe("ThreatModelSchema", () => {
  it("rejects duplicate threat ids", () => {
    expect(() =>
      ThreatModelSchema.parse([baseEntry({ id: "dup" }), baseEntry({ id: "dup" })]),
    ).toThrow(/duplicate threat id/);
  });
});

describe("riskScore", () => {
  it("scores low likelihood × catastrophic impact correctly", () => {
    const e = ThreatEntrySchema.parse(baseEntry({ likelihood: "low", impact: "catastrophic" }));
    expect(riskScore(e)).toBe(LIKELIHOOD_ORDER.low * IMPACT_ORDER.catastrophic);
  });

  it("scores zero on negligible impact regardless of likelihood", () => {
    const e = ThreatEntrySchema.parse(baseEntry({ likelihood: "very_high", impact: "negligible" }));
    expect(riskScore(e)).toBe(0);
  });
});

describe("sortByRisk", () => {
  it("returns entries highest-risk-first", () => {
    const model = ThreatModelSchema.parse([
      baseEntry({ id: "lowRisk", likelihood: "low", impact: "minor" }),
      baseEntry({
        id: "highRisk",
        likelihood: "high",
        impact: "catastrophic",
      }),
      baseEntry({
        id: "midRisk",
        likelihood: "medium",
        impact: "moderate",
      }),
    ]);
    const sorted = sortByRisk(model);
    expect(sorted.map((e) => e.id)).toEqual(["highRisk", "midRisk", "lowRisk"]);
  });
});
