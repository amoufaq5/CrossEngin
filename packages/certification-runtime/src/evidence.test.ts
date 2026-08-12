import { describe, expect, it } from "vitest";
import {
  ControlEvidenceSchema,
  evidenceFromAccessReviewEvidence,
  evidenceFromDrReadiness,
  evidenceFromEncryptionCoverage,
  evidenceFromForensicChain,
  type AccessReviewEvidenceLike,
} from "./evidence.js";

const AT = "2026-06-01T00:00:00.000Z";

describe("evidenceFromEncryptionCoverage", () => {
  it("satisfied when there are no issues", () => {
    const e = evidenceFromEncryptionCoverage(
      "data.encryption_at_rest",
      { schema: "meta", pgcryptoInstalled: true, total: 3, plaintext: 0, issues: [] },
      AT,
    );
    expect(e.satisfied).toBe(true);
    expect(e.findings).toEqual([]);
    expect(e.detailRef).toBe("meta");
    expect(() => ControlEvidenceSchema.parse(e)).not.toThrow();
  });

  it("deficient with findings when a plaintext column drifts", () => {
    const e = evidenceFromEncryptionCoverage(
      "data.encryption_at_rest",
      {
        schema: "meta",
        pgcryptoInstalled: true,
        total: 3,
        plaintext: 1,
        issues: [{ kind: "plaintext_at_rest", detail: "patients.mrn is plaintext" }],
      },
      AT,
    );
    expect(e.satisfied).toBe(false);
    expect(e.findings[0]).toContain("plaintext_at_rest");
  });
});

describe("evidenceFromDrReadiness", () => {
  it("satisfied when ready", () => {
    const e = evidenceFromDrReadiness(
      "resilience.dr_readiness",
      { ready: true, counts: { totalIssues: 0 } },
      AT,
    );
    expect(e.satisfied).toBe(true);
  });

  it("deficient with itemized findings", () => {
    const e = evidenceFromDrReadiness(
      "resilience.dr_readiness",
      {
        ready: false,
        counts: { totalIssues: 2, expiredBackups: 1, failoverBreaches: 1 },
      },
      AT,
    );
    expect(e.satisfied).toBe(false);
    expect(e.findings.some((f) => f.includes("expired backups"))).toBe(true);
    expect(e.findings.some((f) => f.includes("failover"))).toBe(true);
  });
});

describe("evidenceFromForensicChain", () => {
  it("satisfied when the chain verifies", () => {
    const e = evidenceFromForensicChain(
      "audit.tamper_evident_log",
      { valid: true, brokenAt: null },
      AT,
    );
    expect(e.satisfied).toBe(true);
  });

  it("deficient records the break point", () => {
    const e = evidenceFromForensicChain(
      "audit.tamper_evident_log",
      { valid: false, brokenAt: 42, reason: "hash mismatch" },
      AT,
    );
    expect(e.satisfied).toBe(false);
    expect(e.findings[0]).toContain("42");
    expect(e.findings[0]).toContain("hash mismatch");
  });
});

describe("evidenceFromAccessReviewEvidence", () => {
  const base: AccessReviewEvidenceLike = {
    framework: "soc2_type2",
    status: "sealed",
    sealedSha256: "a".repeat(64),
    completionRate: 1,
    strongAttestationRate: 1,
    controlMappings: ["CC6.1"],
  };

  it("satisfied when sealed and above completion threshold", () => {
    const e = evidenceFromAccessReviewEvidence("access.periodic_review", base, AT);
    expect(e.satisfied).toBe(true);
    expect(e.detailRef).toBe("a".repeat(64));
  });

  it("deficient when not sealed", () => {
    const e = evidenceFromAccessReviewEvidence(
      "access.periodic_review",
      { ...base, status: "compiled", sealedSha256: null },
      AT,
    );
    expect(e.satisfied).toBe(false);
    expect(e.findings.some((f) => f.includes("not sealed"))).toBe(true);
  });

  it("deficient when completion below threshold", () => {
    const e = evidenceFromAccessReviewEvidence(
      "access.periodic_review",
      { ...base, completionRate: 0.5 },
      AT,
    );
    expect(e.satisfied).toBe(false);
    expect(e.findings.some((f) => f.includes("completion rate"))).toBe(true);
  });

  it("requireSeal:false accepts an unsealed but complete campaign", () => {
    const e = evidenceFromAccessReviewEvidence(
      "access.periodic_review",
      { ...base, status: "compiled", sealedSha256: null },
      AT,
      { requireSeal: false },
    );
    expect(e.satisfied).toBe(true);
  });
});
