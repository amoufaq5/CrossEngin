import { describe, expect, it } from "vitest";
import {
  DrillRecordSchema,
  FailoverRecordSchema,
  type DrillRecord,
  type FailoverRecord,
} from "@crossengin/dr";
import { assessDrReadiness } from "@crossengin/dr-runtime";
import {
  DrDrillExecutionRecordSchema,
  DrFailoverExecutionRecordSchema,
  DrReadinessSnapshotRecordSchema,
  drillExecutionRecordFrom,
  failoverExecutionRecordFrom,
  generateReadinessSnapshotId,
  readinessSnapshotRecordFrom,
} from "./records.js";

const NOW = "2026-06-02T12:00:00.000Z";
const LATER = "2026-06-02T12:30:00.000Z";
const TENANT = "00000000-0000-4000-8000-000000000001";

function succeededFailover(overrides: Partial<FailoverRecord> = {}): FailoverRecord {
  return FailoverRecordSchema.parse({
    id: "fov_00000001",
    tier: "tier_1_business_critical",
    trigger: "planned_drill",
    triggeredBy: "operator-1",
    triggeredAt: NOW,
    fromRegion: "eu-central",
    toRegion: "us-east",
    affectedApps: ["billing"],
    status: "succeeded",
    startedAt: NOW,
    completedAt: LATER,
    durationSeconds: 1800,
    actualRpoSeconds: 30,
    actualRtoSeconds: 300,
    ...overrides,
  });
}

function passedDrill(overrides: Partial<DrillRecord> = {}): DrillRecord {
  return DrillRecordSchema.parse({
    id: "drl_00000001",
    kind: "restore_test",
    tier: "tier_1_business_critical",
    scheduledFor: NOW,
    executedAt: LATER,
    executedBy: "operator-1",
    scopeRegions: ["eu-central"],
    scopeApps: ["billing"],
    outcome: "passed",
    measuredRpoSeconds: 20,
    measuredRtoSeconds: 200,
    nextDrillDueAt: "2026-09-02T12:00:00.000Z",
    ...overrides,
  });
}

describe("generateReadinessSnapshotId", () => {
  it("produces an id matching the table pattern", () => {
    expect(generateReadinessSnapshotId()).toMatch(/^drr_[a-z0-9]{4,40}$/);
  });
  it("produces distinct ids", () => {
    expect(generateReadinessSnapshotId()).not.toBe(generateReadinessSnapshotId());
  });
});

describe("failoverExecutionRecordFrom", () => {
  it("maps a failover record onto the execution record", () => {
    const rec = failoverExecutionRecordFrom(succeededFailover(), {
      tenantId: TENANT,
      recordedAt: LATER,
    });
    expect(DrFailoverExecutionRecordSchema.safeParse(rec).success).toBe(true);
    expect(rec.executionId).toBe("fov_00000001");
    expect(rec.tenantId).toBe(TENANT);
    expect(rec.status).toBe("succeeded");
    expect(rec.fromRegion).toBe("eu-central");
    expect(rec.toRegion).toBe("us-east");
    expect(rec.actualRpoSeconds).toBe(30);
    expect(rec.completedAt).toBe(LATER);
    expect(rec.recordedAt).toBe(LATER);
  });

  it("defaults verdict breach flags to null when no verdict given", () => {
    const rec = failoverExecutionRecordFrom(succeededFailover(), {
      tenantId: null,
      recordedAt: LATER,
    });
    expect(rec.rpoBreached).toBeNull();
    expect(rec.rtoBreached).toBeNull();
    expect(rec.tenantId).toBeNull();
  });

  it("threads a supplied verdict into the breach columns", () => {
    const rec = failoverExecutionRecordFrom(succeededFailover(), {
      tenantId: TENANT,
      recordedAt: LATER,
      verdict: { rpoBreached: true, rtoBreached: false },
    });
    expect(rec.rpoBreached).toBe(true);
    expect(rec.rtoBreached).toBe(false);
  });

  it("maps incidentTicketId to null when absent", () => {
    const rec = failoverExecutionRecordFrom(succeededFailover(), {
      tenantId: null,
      recordedAt: LATER,
    });
    expect(rec.incidentTicketId).toBeNull();
  });

  it("carries an incidentTicketId when present", () => {
    const rec = failoverExecutionRecordFrom(
      succeededFailover({
        trigger: "primary_outage",
        incidentTicketId: "INC-2026-0007",
      }),
      { tenantId: null, recordedAt: LATER },
    );
    expect(rec.incidentTicketId).toBe("INC-2026-0007");
    expect(rec.trigger).toBe("primary_outage");
  });

  it("rejects a non-uuid tenant id", () => {
    expect(() =>
      failoverExecutionRecordFrom(succeededFailover(), {
        tenantId: "not-a-uuid",
        recordedAt: LATER,
      }),
    ).toThrow();
  });
});

describe("drillExecutionRecordFrom", () => {
  it("maps a drill record onto the execution record", () => {
    const rec = drillExecutionRecordFrom(passedDrill(), {
      tenantId: TENANT,
      recordedAt: LATER,
    });
    expect(DrDrillExecutionRecordSchema.safeParse(rec).success).toBe(true);
    expect(rec.executionId).toBe("drl_00000001");
    expect(rec.kind).toBe("restore_test");
    expect(rec.outcome).toBe("passed");
    expect(rec.scheduledFor).toBe(NOW);
    expect(rec.executedAt).toBe(LATER);
  });

  it("defaults the verdict flags to null", () => {
    const rec = drillExecutionRecordFrom(passedDrill(), {
      tenantId: null,
      recordedAt: LATER,
    });
    expect(rec.passing).toBeNull();
    expect(rec.rpoBreached).toBeNull();
    expect(rec.rtoBreached).toBeNull();
  });

  it("threads a supplied verdict into the columns", () => {
    const rec = drillExecutionRecordFrom(passedDrill(), {
      tenantId: null,
      recordedAt: LATER,
      verdict: { rpoBreached: false, rtoBreached: true, passing: true },
    });
    expect(rec.rpoBreached).toBe(false);
    expect(rec.rtoBreached).toBe(true);
    expect(rec.passing).toBe(true);
  });

  it("preserves a not_executed drill's null executedAt", () => {
    const drill = passedDrill({
      outcome: "not_executed",
      executedAt: null,
      executedBy: null,
      measuredRpoSeconds: null,
      measuredRtoSeconds: null,
    });
    const rec = drillExecutionRecordFrom(drill, {
      tenantId: null,
      recordedAt: LATER,
    });
    expect(rec.outcome).toBe("not_executed");
    expect(rec.executedAt).toBeNull();
  });
});

describe("readinessSnapshotRecordFrom", () => {
  it("maps counts onto flat columns", () => {
    const report = assessDrReadiness({});
    const rec = readinessSnapshotRecordFrom(report, {
      tenantId: TENANT,
      generatedAt: NOW,
    });
    expect(DrReadinessSnapshotRecordSchema.safeParse(rec).success).toBe(true);
    expect(rec.snapshotId).toMatch(/^drr_[a-z0-9]{4,40}$/);
    expect(rec.ready).toBe(true);
    expect(rec.totalIssues).toBe(0);
    expect(rec.overdueDrills).toBe(0);
    expect(rec.failoverBreaches).toBe(0);
    expect(rec.generatedAt).toBe(NOW);
  });

  it("reflects a not-ready report with a breach count", () => {
    const failover = succeededFailover({ actualRpoSeconds: 5000 });
    const report = assessDrReadiness({ failovers: [failover] });
    const rec = readinessSnapshotRecordFrom(report, {
      tenantId: null,
      generatedAt: NOW,
    });
    expect(rec.ready).toBe(false);
    expect(rec.failoverBreaches).toBe(1);
    expect(rec.totalIssues).toBe(1);
  });

  it("honors an explicit snapshotId", () => {
    const report = assessDrReadiness({});
    const rec = readinessSnapshotRecordFrom(report, {
      tenantId: null,
      generatedAt: NOW,
      snapshotId: "drr_fixed001",
    });
    expect(rec.snapshotId).toBe("drr_fixed001");
  });

  it("rejects a malformed explicit snapshotId", () => {
    const report = assessDrReadiness({});
    expect(() =>
      readinessSnapshotRecordFrom(report, {
        tenantId: null,
        generatedAt: NOW,
        snapshotId: "bad-id",
      }),
    ).toThrow();
  });
});
