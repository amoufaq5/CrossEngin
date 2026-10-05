import { describe, expect, it } from "vitest";
import type { PgConnection } from "@crossengin/kernel-pg";
import {
  FixedClock,
  buildCertificationReport,
} from "@crossengin/certification-runtime";
import { PostgresCertificationReportStore } from "./report-store.js";
import {
  SET_PLATFORM_RECORD_WRITE_SQL,
  SET_TENANT_CONTEXT_SQL,
  certificationReportRecordFrom,
  scopedWrite,
} from "./records.js";
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

describe("the platform write arm", () => {
  /** A fake that records `{sql, params}` and answers nothing, for asserting the statement order. */
  function recordingPg(
    capture: Array<{ sql: string; params: readonly unknown[] | undefined }>,
  ): PgConnection {
    const client: PgConnection = {
      query: (async (sql: string, params?: readonly unknown[]) => {
        capture.push({ sql, params });
        return { rows: [], rowCount: 0 };
      }) as PgConnection["query"],
      transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) =>
        fn(client)) as PgConnection["transaction"],
      withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
        fn()) as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    };
    return client;
  }

  it("claims app.platform_record_write before a platform-scope write", async () => {
    // This store set nothing at all before the split, which worked only because the deployment
    // connects as the table's owner and an owner bypasses its policies. As a non-owner the single
    // `ALL`-scope policy admitted a platform row unconditionally — the defect — so the write arm is
    // now an `INSERT`-scoped policy on this setting.
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresCertificationReportStore(recordingPg(capture));
    const report = reportAt("2026-06-01T00:00:00.000Z", "soc2_type2");
    await store.record({ ...certificationReportRecordFrom(report), tenantId: null });
    expect(capture[0]?.sql).toBe(SET_PLATFORM_RECORD_WRITE_SQL);
    expect(capture[1]?.sql).toContain("INSERT INTO meta.certification_reports");
  });

  it("claims the tenant context instead for a tenant-scope write, never both", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresCertificationReportStore(recordingPg(capture));
    await store.record(
      certificationReportRecordFrom(reportAt("2026-06-01T00:00:00.000Z", "soc2_type2")),
    );
    const settings = capture.filter((c) => c.sql.includes("set_config"));
    expect(settings).toHaveLength(1);
    expect(settings[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    expect(settings[0]?.params).toEqual([TENANT]);
  });

  it("claims nothing at all on a read, which the split left unchanged", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresCertificationReportStore(recordingPg(capture));
    await store.getByReportId("cert_missing");
    expect(capture.some((c) => c.sql.includes("set_config"))).toBe(false);
  });

  it("claims the elevation transaction-locally, and not the config or key grant", () => {
    // A sealed report is `record` and not `config`: it says what the deployment assessed, never
    // what it will do. It is the loudest member of that group — a forged platform report is a
    // compliance claim — and a deployment wanting it on a grant of its own is a named follow-up.
    expect(SET_PLATFORM_RECORD_WRITE_SQL).toBe(
      "SELECT set_config('app.platform_record_write', 'on', true)",
    );
    expect(SET_PLATFORM_RECORD_WRITE_SQL).not.toContain("app.platform_config_write");
    expect(SET_PLATFORM_RECORD_WRITE_SQL).not.toContain("app.platform_key_write");
  });

  it("rejects a tenantId that is not a plausible RLS context, having issued nothing", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await expect(
      scopedWrite(recordingPg(capture), "'; DROP TABLE meta.tenants --", async () => undefined),
    ).rejects.toThrow(/invalid tenantId/);
    expect(capture).toEqual([]);
  });
});
