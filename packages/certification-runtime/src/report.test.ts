import { describe, expect, it } from "vitest";
import {
  CertificationEngine,
  CertificationReportSchema,
  buildCertificationReport,
  certificationReportSealSha256,
  formatCertificationReport,
  verifyCertificationReportSeal,
} from "./report.js";
import { CountingIdGenerator, FixedClock } from "./clock.js";
import {
  evidenceFromAccessReviewEvidence,
  evidenceFromDrReadiness,
  evidenceFromEncryptionCoverage,
  evidenceFromForensicChain,
  type ControlEvidence,
} from "./evidence.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const AT = "2026-06-01T00:00:00.000Z";

function compliantEvidence(framework = "soc2_type2"): ControlEvidence[] {
  return [
    evidenceFromAccessReviewEvidence(
      "access.periodic_review",
      {
        framework: framework as "soc2_type2",
        status: "sealed",
        sealedSha256: "b".repeat(64),
        completionRate: 1,
        strongAttestationRate: 1,
        controlMappings: ["CC6.1"],
      },
      AT,
    ),
    evidenceFromEncryptionCoverage(
      "data.encryption_at_rest",
      { schema: "meta", pgcryptoInstalled: true, total: 2, plaintext: 0, issues: [] },
      AT,
    ),
    evidenceFromForensicChain(
      "audit.tamper_evident_log",
      { valid: true, brokenAt: null },
      AT,
    ),
    evidenceFromDrReadiness(
      "resilience.dr_readiness",
      { ready: true, counts: { totalIssues: 0 } },
      AT,
    ),
  ];
}

function fixtures() {
  return {
    clock: new FixedClock(new Date(AT)),
    ids: new CountingIdGenerator(),
  };
}

describe("buildCertificationReport", () => {
  it("builds a sealed, schema-valid, certifiable SOC 2 report", () => {
    const { clock, ids } = fixtures();
    const report = buildCertificationReport({
      framework: "soc2_type2",
      evidence: compliantEvidence(),
      tenantId: TENANT,
      clock,
      ids,
    });
    expect(() => CertificationReportSchema.parse(report)).not.toThrow();
    expect(report.reportId).toBe("cert_00000001");
    expect(report.framework).toBe("soc2_type2");
    expect(report.generatedAt).toBe(AT);
    expect(report.certifiable).toBe(true);
    expect(report.sealedSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a HIPAA report with missing evidence is not certifiable", () => {
    const { clock, ids } = fixtures();
    const report = buildCertificationReport({
      framework: "hipaa_security_rule",
      evidence: [],
      tenantId: TENANT,
      clock,
      ids,
    });
    expect(report.certifiable).toBe(false);
    expect(report.assessment.counts.notAssessed).toBe(4);
  });

  it("tenantId defaults to null", () => {
    const { clock, ids } = fixtures();
    const report = buildCertificationReport({
      framework: "soc2_type2",
      evidence: compliantEvidence(),
      clock,
      ids,
    });
    expect(report.tenantId).toBeNull();
  });
});

describe("seal", () => {
  it("verifyCertificationReportSeal accepts an untampered report", () => {
    const { clock, ids } = fixtures();
    const report = buildCertificationReport({
      framework: "soc2_type2",
      evidence: compliantEvidence(),
      tenantId: TENANT,
      clock,
      ids,
    });
    expect(verifyCertificationReportSeal(report)).toBe(true);
  });

  it("detects tampering with the assessment", () => {
    const { clock, ids } = fixtures();
    const report = buildCertificationReport({
      framework: "soc2_type2",
      evidence: compliantEvidence(),
      tenantId: TENANT,
      clock,
      ids,
    });
    const tampered = {
      ...report,
      assessment: {
        ...report.assessment,
        certifiable: false,
        counts: { ...report.assessment.counts, deficient: 99 },
      },
    };
    expect(verifyCertificationReportSeal(tampered)).toBe(false);
  });

  it("seal is deterministic for identical inputs", () => {
    const a = certificationReportSealSha256({
      framework: "soc2_type2",
      tenantId: TENANT,
      generatedAt: AT,
      assessment: buildCertificationReport({
        framework: "soc2_type2",
        evidence: compliantEvidence(),
        ...fixtures(),
      }).assessment,
    });
    const b = certificationReportSealSha256({
      framework: "soc2_type2",
      tenantId: TENANT,
      generatedAt: AT,
      assessment: buildCertificationReport({
        framework: "soc2_type2",
        evidence: compliantEvidence(),
        ...fixtures(),
      }).assessment,
    });
    expect(a).toBe(b);
  });
});

describe("formatCertificationReport", () => {
  it("renders PASS/FAIL/MISS lines and the seal", () => {
    const { clock, ids } = fixtures();
    const evidence = compliantEvidence();
    evidence.pop(); // drop DR readiness → one MISS
    evidence[1] = evidenceFromEncryptionCoverage(
      "data.encryption_at_rest",
      {
        schema: "meta",
        pgcryptoInstalled: true,
        total: 1,
        plaintext: 1,
        issues: [{ kind: "plaintext_at_rest", detail: "mrn plaintext" }],
      },
      AT,
    );
    const report = buildCertificationReport({
      framework: "soc2_type2",
      evidence,
      clock,
      ids,
    });
    const text = formatCertificationReport(report);
    expect(text).toContain("NOT CERTIFIABLE");
    expect(text).toContain("[PASS]");
    expect(text).toContain("[FAIL]");
    expect(text).toContain("[MISS]");
    expect(text).toContain(report.sealedSha256);
  });
});

describe("CertificationEngine", () => {
  it("certify + certifyAll produce distinct sealed reports", () => {
    const engine = new CertificationEngine({ ...fixtures(), tenantId: TENANT });
    const [soc2, hipaa] = engine.certifyAll(
      ["soc2_type2", "hipaa_security_rule"],
      compliantEvidence(),
    );
    expect(soc2.reportId).not.toBe(hipaa.reportId);
    expect(soc2.framework).toBe("soc2_type2");
    expect(hipaa.framework).toBe("hipaa_security_rule");
    expect(soc2.tenantId).toBe(TENANT);
    expect(verifyCertificationReportSeal(soc2)).toBe(true);
  });
});
