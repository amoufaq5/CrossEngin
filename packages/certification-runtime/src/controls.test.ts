import { describe, expect, it } from "vitest";
import {
  COMPLIANCE_FRAMEWORKS,
  CONTROL_DOMAINS,
  ControlDefinitionSchema,
  DEFAULT_CONTROL_CATALOG,
  EVIDENCE_SOURCE_KINDS,
  controlsForFramework,
  frameworkRefsFor,
  frameworksCoveredBy,
} from "./controls.js";

describe("control catalog", () => {
  it("every default control validates", () => {
    for (const c of DEFAULT_CONTROL_CATALOG) {
      expect(() => ControlDefinitionSchema.parse(c)).not.toThrow();
    }
  });

  it("control ids are unique", () => {
    const ids = DEFAULT_CONTROL_CATALOG.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every control declares a known evidence source and domain", () => {
    for (const c of DEFAULT_CONTROL_CATALOG) {
      expect(EVIDENCE_SOURCE_KINDS).toContain(c.requiredEvidence);
      expect(CONTROL_DOMAINS).toContain(c.domain);
    }
  });

  it("every framework ref uses a known framework key with non-empty refs", () => {
    for (const c of DEFAULT_CONTROL_CATALOG) {
      for (const [fw, refs] of Object.entries(c.frameworkRefs)) {
        expect(COMPLIANCE_FRAMEWORKS).toContain(fw);
        expect(refs.length).toBeGreaterThan(0);
      }
    }
  });

  it("SOC 2 and HIPAA are covered by all four control domains", () => {
    for (const fw of ["soc2_type2", "hipaa_security_rule"] as const) {
      const controls = controlsForFramework(fw);
      expect(controls).toHaveLength(4);
      const domains = new Set(controls.map((c) => c.domain));
      expect(domains).toEqual(new Set(CONTROL_DOMAINS));
    }
  });

  it("controlsForFramework filters to mapped controls only", () => {
    // dr_readiness control is not mapped to cfr_21_part_11
    const cfr = controlsForFramework("cfr_21_part_11");
    expect(cfr.map((c) => c.id)).not.toContain("resilience.dr_readiness");
  });

  it("custom framework maps to no controls", () => {
    expect(controlsForFramework("custom")).toHaveLength(0);
  });

  it("frameworkRefsFor + frameworksCoveredBy agree", () => {
    const enc = DEFAULT_CONTROL_CATALOG.find(
      (c) => c.id === "data.encryption_at_rest",
    );
    expect(enc).toBeDefined();
    if (enc === undefined) return;
    expect(frameworkRefsFor(enc, "soc2_type2")).toContain("CC6.7");
    expect(frameworkRefsFor(enc, "custom")).toEqual([]);
    expect(frameworksCoveredBy(enc)).toContain("hipaa_security_rule");
    expect(frameworksCoveredBy(enc)).not.toContain("custom");
  });
});
