import { describe, expect, it } from "vitest";
import {
  CertificationRoadmapSchema,
  CertificationTargetSchema,
  CERTIFICATION_STANDARDS,
  CERTIFICATION_STATUSES,
} from "./certifications.js";

describe("CertificationTargetSchema", () => {
  it("parses a not_started entry", () => {
    const t = CertificationTargetSchema.parse({
      standard: "soc2_type_ii",
      status: "not_started",
    });
    expect(t.standard).toBe("soc2_type_ii");
  });

  it("rejects an unknown standard", () => {
    expect(() =>
      CertificationTargetSchema.parse({ standard: "foo_cert", status: "not_started" }),
    ).toThrow();
  });

  it("CERTIFICATION_STANDARDS includes SOC2, ISO 27001, HITRUST", () => {
    expect(CERTIFICATION_STANDARDS).toContain("soc2_type_ii");
    expect(CERTIFICATION_STANDARDS).toContain("iso_27001");
    expect(CERTIFICATION_STANDARDS).toContain("hitrust_csf_v11");
  });
});

describe("CertificationRoadmapSchema", () => {
  it("parses a multi-entry roadmap", () => {
    const r = CertificationRoadmapSchema.parse([
      { standard: "soc2_type_ii", status: "evidence_collection" },
      { standard: "iso_27001", status: "not_started" },
    ]);
    expect(r).toHaveLength(2);
  });

  it("rejects duplicate standards", () => {
    expect(() =>
      CertificationRoadmapSchema.parse([
        { standard: "soc2_type_ii", status: "evidence_collection" },
        { standard: "soc2_type_ii", status: "audit_in_progress" },
      ]),
    ).toThrow(/duplicate roadmap entry/);
  });

  it("requires certifiedAt when status is certified", () => {
    expect(() =>
      CertificationRoadmapSchema.parse([
        { standard: "soc2_type_ii", status: "certified" },
      ]),
    ).toThrow(/must declare certifiedAt/);
  });

  it("accepts a certified entry with certifiedAt", () => {
    expect(() =>
      CertificationRoadmapSchema.parse([
        {
          standard: "soc2_type_ii",
          status: "certified",
          certifiedAt: "2026-05-01T00:00:00.000Z",
          auditor: "AuditCo Inc.",
        },
      ]),
    ).not.toThrow();
  });

  it("CERTIFICATION_STATUSES includes maintenance + lapsed", () => {
    expect(CERTIFICATION_STATUSES).toContain("maintenance");
    expect(CERTIFICATION_STATUSES).toContain("lapsed");
  });
});
