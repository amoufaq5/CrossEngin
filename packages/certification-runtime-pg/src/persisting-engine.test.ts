import { describe, expect, it } from "vitest";
import {
  FixedClock,
  RandomIdGenerator,
  verifyCertificationReportSeal,
} from "@crossengin/certification-runtime";
import { buildPersistentCertificationEngine } from "./persisting-engine.js";
import {
  FIXTURE_TIME,
  compliantEvidence,
  fakeCertificationPg,
} from "./test-fakes.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function engineOptions() {
  return {
    clock: new FixedClock(new Date(FIXTURE_TIME)),
    ids: new RandomIdGenerator(),
    tenantId: TENANT,
  };
}

describe("buildPersistentCertificationEngine", () => {
  it("certify persists a sealed, retrievable report", async () => {
    const conn = fakeCertificationPg();
    const pe = buildPersistentCertificationEngine(conn, engineOptions());
    const report = await pe.certify("soc2_type2", compliantEvidence());

    expect(report.certifiable).toBe(true);
    expect(verifyCertificationReportSeal(report)).toBe(true);

    const stored = await pe.store.getByReportId(report.reportId);
    expect(stored).not.toBeNull();
    expect(stored?.tenantId).toBe(TENANT);
    expect(stored?.framework).toBe("soc2_type2");
    expect(stored?.report).toEqual(report);
  });

  it("certifyAll persists one report per framework", async () => {
    const conn = fakeCertificationPg();
    const pe = buildPersistentCertificationEngine(conn, engineOptions());
    const reports = await pe.certifyAll(
      ["soc2_type2", "hipaa_security_rule"],
      compliantEvidence(),
    );
    expect(reports).toHaveLength(2);

    const persisted = await pe.store.listRecent();
    expect(persisted).toHaveLength(2);
    expect(new Set(persisted.map((r) => r.framework))).toEqual(
      new Set(["soc2_type2", "hipaa_security_rule"]),
    );
  });

  it("persists a not-certifiable report (missing evidence) too", async () => {
    const conn = fakeCertificationPg();
    const pe = buildPersistentCertificationEngine(conn, engineOptions());
    const report = await pe.certify("hipaa_security_rule", []);
    expect(report.certifiable).toBe(false);

    const stored = await pe.store.latestForFramework("hipaa_security_rule");
    expect(stored?.certifiable).toBe(false);
    expect(stored?.controlsNotAssessed).toBe(4);
  });
});
