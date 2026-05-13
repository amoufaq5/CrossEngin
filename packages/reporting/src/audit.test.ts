import { describe, expect, it } from "vitest";
import {
  REPORT_RUN_STATUSES,
  REPORT_RUN_TRIGGERS,
  ReportRunRecordSchema,
  ScheduledExportSchema,
} from "./audit.js";

const now = "2026-05-13T10:00:00.000Z";

describe("ReportRunRecordSchema", () => {
  it("parses a completed run", () => {
    const r = ReportRunRecordSchema.parse({
      id: "rr_1",
      tenantId: "t_1",
      reportId: "weeklyDispensingSummary",
      runId: "run_1",
      startedAt: now,
      completedAt: now,
      durationMillis: 432,
      status: "completed",
      trigger: "user_invoked",
      invokedBy: "u_1",
      engine: "postgres",
      rowCount: 100,
      cacheHit: false,
      error: null,
    });
    expect(r.cacheHit).toBe(false);
  });

  it("parses a failed run", () => {
    expect(() =>
      ReportRunRecordSchema.parse({
        id: "rr_2",
        tenantId: "t_1",
        reportId: "x",
        runId: "run_2",
        startedAt: now,
        completedAt: now,
        durationMillis: 100,
        status: "failed",
        trigger: "scheduled",
        engine: "clickhouse",
        error: { kind: "timeout", message: "exceeded 30s" },
      }),
    ).not.toThrow();
  });

  it("rejects negative duration", () => {
    expect(() =>
      ReportRunRecordSchema.parse({
        id: "rr",
        tenantId: "t",
        reportId: "x",
        runId: "run",
        startedAt: now,
        completedAt: now,
        durationMillis: -1,
        status: "completed",
        trigger: "api",
        engine: "postgres",
        error: null,
      }),
    ).toThrow();
  });

  it("REPORT_RUN_STATUSES includes throttled", () => {
    expect(REPORT_RUN_STATUSES).toContain("throttled");
  });

  it("REPORT_RUN_TRIGGERS includes ai_architect", () => {
    expect(REPORT_RUN_TRIGGERS).toContain("ai_architect");
  });
});

describe("ScheduledExportSchema", () => {
  it("parses a scheduled export with defaults", () => {
    const s = ScheduledExportSchema.parse({
      id: "se_1",
      tenantId: "t_1",
      reportId: "monthlyRecap",
      cron: "0 8 1 * *",
      timezone: "Asia/Dubai",
      enabled: true,
      nextRunAt: now,
    });
    expect(s.consecutiveFailures).toBe(0);
    expect(s.lastStatus).toBeNull();
  });

  it("rejects negative consecutiveFailures", () => {
    expect(() =>
      ScheduledExportSchema.parse({
        id: "se",
        tenantId: "t",
        reportId: "x",
        cron: "* * * * *",
        timezone: "UTC",
        enabled: false,
        nextRunAt: now,
        consecutiveFailures: -1,
      }),
    ).toThrow();
  });
});
