import { describe, expect, it } from "vitest";
import {
  buildCertificationReport,
  CountingIdGenerator,
  FixedClock,
  evidenceFromEncryptionCoverage,
  type CertificationReport,
  type ControlEvidence,
} from "@crossengin/certification-runtime";
import {
  CertificationReportRecordSchema,
  certificationReportRecordFrom,
} from "./records.js";
import { FIXTURE_TIME, compliantEvidence } from "./test-fakes.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function buildReport(
  framework = "soc2_type2" as "soc2_type2",
  tenantId: string | null = TENANT,
  evidence: ControlEvidence[] = compliantEvidence(),
): CertificationReport {
  return buildCertificationReport({
    framework,
    evidence,
    tenantId,
    clock: new FixedClock(new Date(FIXTURE_TIME)),
    ids: new CountingIdGenerator(),
  });
}

describe("certificationReportRecordFrom", () => {
  it("projects report fields into a schema-valid record", () => {
    const record = certificationReportRecordFrom(buildReport());
    expect(() => CertificationReportRecordSchema.parse(record)).not.toThrow();
    expect(record.reportId).toBe("cert_00000001");
    expect(record.framework).toBe("soc2_type2");
    expect(record.tenantId).toBe(TENANT);
    expect(record.certifiable).toBe(true);
    expect(record.controlsTotal).toBe(4);
    expect(record.controlsSatisfied).toBe(4);
    expect(record.controlsDeficient).toBe(0);
    expect(record.controlsNotAssessed).toBe(0);
    expect(record.sealedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.generatedAt).toBe(FIXTURE_TIME);
  });

  it("carries the full report as the JSONB payload", () => {
    const report = buildReport();
    const record = certificationReportRecordFrom(report);
    expect(record.report).toEqual(report);
  });

  it("defaults tenantId to the report's tenant, overridable", () => {
    expect(
      certificationReportRecordFrom(buildReport("soc2_type2", null)).tenantId,
    ).toBeNull();
    const overridden = certificationReportRecordFrom(buildReport(), {
      tenantId: null,
    });
    expect(overridden.tenantId).toBeNull();
  });

  it("counts deficiencies from a non-certifiable report", () => {
    const evidence = compliantEvidence();
    evidence[1] = evidenceFromEncryptionCoverage(
      "data.encryption_at_rest",
      {
        schema: "meta",
        pgcryptoInstalled: true,
        total: 1,
        plaintext: 1,
        issues: [{ kind: "plaintext_at_rest", detail: "x plaintext" }],
      },
      FIXTURE_TIME,
    );
    const record = certificationReportRecordFrom(
      buildReport("soc2_type2", TENANT, evidence),
    );
    expect(record.certifiable).toBe(false);
    expect(record.controlsDeficient).toBe(1);
  });
});
