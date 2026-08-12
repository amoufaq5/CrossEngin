import { describe, expect, it } from "vitest";
import {
  FixedClock,
  buildCertificationReport,
} from "@crossengin/certification-runtime";
import { PostgresCertificationReportStore } from "./report-store.js";
import { certificationReportRecordFrom } from "./records.js";
import { compliantEvidence, fakeCertificationPg } from "./test-fakes.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

/** Random ids (default generator) so distinct reports never collide. */
function reportAt(iso: string, framework: "soc2_type2" | "hipaa_security_rule") {
  return buildCertificationReport({
    framework,
    evidence: compliantEvidence(),
    tenantId: TENANT,
    clock: new FixedClock(new Date(iso)),
  });
}

describe("PostgresCertificationReportStore", () => {
  it("records then fetches a report by id", async () => {
    const store = new PostgresCertificationReportStore(fakeCertificationPg());
    const report = reportAt("2026-06-01T00:00:00.000Z", "soc2_type2");
    await store.record(certificationReportRecordFrom(report));
    const fetched = await store.getByReportId(report.reportId);
    expect(fetched).not.toBeNull();
    expect(fetched?.framework).toBe("soc2_type2");
    expect(fetched?.report).toEqual(report);
  });

  it("returns null for an unknown id", async () => {
    const store = new PostgresCertificationReportStore(fakeCertificationPg());
    expect(await store.getByReportId("cert_deadbeef")).toBeNull();
  });

  it("INSERT is idempotent on report_id", async () => {
    const store = new PostgresCertificationReportStore(fakeCertificationPg());
    const rec = certificationReportRecordFrom(
      reportAt("2026-06-01T00:00:00.000Z", "soc2_type2"),
    );
    await store.record(rec);
    await store.record(rec);
    expect(await store.listRecent()).toHaveLength(1);
  });

  it("lists recent newest-first and filters by framework", async () => {
    const store = new PostgresCertificationReportStore(fakeCertificationPg());
    await store.record(
      certificationReportRecordFrom(reportAt("2026-06-01T00:00:00.000Z", "soc2_type2")),
    );
    await store.record(
      certificationReportRecordFrom(
        reportAt("2026-07-01T00:00:00.000Z", "hipaa_security_rule"),
      ),
    );
    await store.record(
      certificationReportRecordFrom(reportAt("2026-08-01T00:00:00.000Z", "soc2_type2")),
    );

    const recent = await store.listRecent();
    expect(recent).toHaveLength(3);
    expect(recent[0]?.generatedAt).toBe("2026-08-01T00:00:00.000Z");

    const soc2 = await store.listByFramework("soc2_type2");
    expect(soc2).toHaveLength(2);
    expect(soc2.every((r) => r.framework === "soc2_type2")).toBe(true);

    const latestHipaa = await store.latestForFramework("hipaa_security_rule");
    expect(latestHipaa?.generatedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(await store.latestForFramework("pci_dss_v4")).toBeNull();
  });

  it("rejects a non-positive limit", async () => {
    const store = new PostgresCertificationReportStore(fakeCertificationPg());
    await expect(store.listRecent(0)).rejects.toThrow(/positive/);
    await expect(store.listByFramework("soc2_type2", -1)).rejects.toThrow(/positive/);
  });
});
