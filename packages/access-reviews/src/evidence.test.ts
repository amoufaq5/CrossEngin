import { describe, expect, it } from "vitest";
import {
  AccessReviewEvidenceSchema,
  CONTROL_MAPPINGS,
  EVIDENCE_STATUSES,
  EVIDENCE_TRANSITIONS,
  canTransitionEvidence,
  computeCampaignEvidenceMetrics,
  isEvidenceComplete,
  sealEvidence,
  type AccessReviewEvidence,
} from "./evidence.js";

const baseEvidence: AccessReviewEvidence = {
  id: "arv_q22026soc2",
  tenantId: "11111111-1111-1111-1111-111111111111",
  framework: "soc2_type2",
  periodStartAt: "2026-04-01T00:00:00.000Z",
  periodEndAt: "2026-06-30T23:59:59.000Z",
  campaignIds: ["arc_q22026adm"],
  controlMappings: ["CC6.1", "CC6.2"],
  totalItemsAcrossCampaigns: 50,
  completionRate: 0.96,
  keepRate: 0.83,
  revokeRate: 0.13,
  autoRevokeRate: 0.04,
  exceptionRate: 0,
  strongAttestationRate: 0.5,
  overdueRate: 0,
  status: "draft",
  compiledAt: null,
  sealedAt: null,
  sealedSha256: null,
  submittedAt: null,
  submittedToAuditorId: null,
  acceptedAt: null,
  rejectedAt: null,
  rejectedReason: null,
  storageUri: null,
  createdBy: "33333333-3333-3333-3333-333333333333",
  createdAt: "2026-07-01T10:00:00.000Z",
};

describe("constants", () => {
  it("has 6 evidence statuses", () => {
    expect(EVIDENCE_STATUSES).toHaveLength(6);
  });
  it("accepted_by_auditor is terminal", () => {
    expect(EVIDENCE_TRANSITIONS.accepted_by_auditor).toEqual([]);
  });
  it("rejected_by_auditor can be re-drafted", () => {
    expect(EVIDENCE_TRANSITIONS.rejected_by_auditor).toEqual(["draft"]);
  });
});

describe("CONTROL_MAPPINGS", () => {
  it("SOC 2 maps to CC6.1, CC6.2, CC6.3, CC6.7", () => {
    expect(CONTROL_MAPPINGS.soc2_type2).toEqual([
      "CC6.1",
      "CC6.2",
      "CC6.3",
      "CC6.7",
    ]);
  });
  it("ISO 27001 includes A.9.2.5", () => {
    expect(CONTROL_MAPPINGS.iso27001).toContain("A.9.2.5");
  });
  it("HIPAA includes 164.308(a)(4)(ii)(C)", () => {
    expect(CONTROL_MAPPINGS.hipaa_security_rule).toContain(
      "164.308(a)(4)(ii)(C)",
    );
  });
  it("21 CFR Part 11 includes 11.10(d)", () => {
    expect(CONTROL_MAPPINGS.cfr_21_part_11).toContain("11.10(d)");
  });
});

describe("canTransitionEvidence", () => {
  it("allows draft → compiled", () => {
    expect(canTransitionEvidence("draft", "compiled")).toBe(true);
  });
  it("blocks compiled → submitted (must seal first)", () => {
    expect(canTransitionEvidence("compiled", "submitted_to_auditor")).toBe(false);
  });
});

describe("computeCampaignEvidenceMetrics", () => {
  it("returns 1.0 completion when totalItems is 0", () => {
    const m = computeCampaignEvidenceMetrics({
      totalItems: 0,
      decidedItems: 0,
      keepDecisions: 0,
      revokeDecisions: 0,
      extendDecisions: 0,
      modifyDecisions: 0,
      deferDecisions: 0,
      autoRevokedItems: 0,
      exceptionItems: 0,
      approvedExceptionItems: 0,
      strongAttestationCount: 0,
      overdueAtCompletion: 0,
    });
    expect(m.completionRate).toBe(1);
  });

  it("computes rates from item counts", () => {
    const m = computeCampaignEvidenceMetrics({
      totalItems: 100,
      decidedItems: 80,
      keepDecisions: 60,
      revokeDecisions: 15,
      extendDecisions: 3,
      modifyDecisions: 2,
      deferDecisions: 0,
      autoRevokedItems: 15,
      exceptionItems: 5,
      approvedExceptionItems: 4,
      strongAttestationCount: 40,
      overdueAtCompletion: 2,
    });
    expect(m.completionRate).toBe(1);
    expect(m.keepRate).toBe(60 / 80);
    expect(m.revokeRate).toBe(15 / 80);
    expect(m.autoRevokeRate).toBe(15 / 100);
    expect(m.exceptionRate).toBe(5 / 100);
    expect(m.strongAttestationRate).toBe(40 / 80);
    expect(m.overdueRate).toBe(2 / 100);
  });
});

describe("AccessReviewEvidenceSchema", () => {
  it("accepts a draft evidence record", () => {
    expect(() => AccessReviewEvidenceSchema.parse(baseEvidence)).not.toThrow();
  });

  it("rejects periodEndAt <= periodStartAt", () => {
    expect(() =>
      AccessReviewEvidenceSchema.parse({
        ...baseEvidence,
        periodEndAt: baseEvidence.periodStartAt,
      }),
    ).toThrow(/periodEndAt must be after periodStartAt/);
  });

  it("rejects sealed status without sealedSha256 + storageUri", () => {
    expect(() =>
      AccessReviewEvidenceSchema.parse({
        ...baseEvidence,
        status: "sealed",
      }),
    ).toThrow(/requires sealedAt/);
  });

  it("rejects submitted_to_auditor without submittedAt", () => {
    expect(() =>
      AccessReviewEvidenceSchema.parse({
        ...baseEvidence,
        status: "submitted_to_auditor",
        sealedAt: "2026-07-15T10:00:00.000Z",
        sealedSha256: "a".repeat(64),
        storageUri: "s3://evidence/q2-2026.zip",
      }),
    ).toThrow(/submittedAt/);
  });

  it("rejects rejected_by_auditor without rejectedReason", () => {
    expect(() =>
      AccessReviewEvidenceSchema.parse({
        ...baseEvidence,
        status: "rejected_by_auditor",
        sealedAt: "2026-07-15T10:00:00.000Z",
        sealedSha256: "a".repeat(64),
        storageUri: "s3://evidence/q2-2026.zip",
        submittedAt: "2026-07-16T10:00:00.000Z",
        submittedToAuditorId: "auditor-deloitte-12345",
        rejectedAt: "2026-08-01T10:00:00.000Z",
      }),
    ).toThrow(/rejected_by_auditor status requires/);
  });

  it("rejects controlMappings missing all expected controls for SOC 2", () => {
    expect(() =>
      AccessReviewEvidenceSchema.parse({
        ...baseEvidence,
        controlMappings: ["UNRELATED.X"],
      }),
    ).toThrow(/must include at least one control from CC6/);
  });
});

describe("sealEvidence", () => {
  it("transitions compiled → sealed with sha256 + storageUri", () => {
    const r = sealEvidence(
      { ...baseEvidence, status: "compiled", compiledAt: "2026-07-15T10:00:00.000Z" },
      "a".repeat(64),
      "s3://evidence/q2-2026.zip",
      new Date("2026-07-15T11:00:00Z"),
    );
    expect(r.status).toBe("sealed");
    expect(r.sealedSha256).toBe("a".repeat(64));
  });

  it("throws on invalid transition (draft → sealed)", () => {
    expect(() =>
      sealEvidence(
        baseEvidence,
        "a".repeat(64),
        "s3://evidence/q2-2026.zip",
        new Date("2026-07-15T11:00:00Z"),
      ),
    ).toThrow();
  });
});

describe("isEvidenceComplete", () => {
  it("returns true for submitted_to_auditor", () => {
    expect(
      isEvidenceComplete({
        ...baseEvidence,
        status: "submitted_to_auditor",
      }),
    ).toBe(true);
  });
  it("returns true for accepted_by_auditor", () => {
    expect(
      isEvidenceComplete({
        ...baseEvidence,
        status: "accepted_by_auditor",
      }),
    ).toBe(true);
  });
  it("returns false for draft", () => {
    expect(isEvidenceComplete(baseEvidence)).toBe(false);
  });
});
