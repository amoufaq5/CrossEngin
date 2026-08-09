import { describe, expect, it } from "vitest";
import {
  DrillRecordSchema,
  FailoverRecordSchema,
  type DrillRecord,
  type FailoverRecord,
} from "@crossengin/dr";
import { PostgresDrDrillStore } from "./drill-store.js";
import { PostgresDrFailoverStore } from "./failover-store.js";
import {
  DrDrillExecutionRecordSchema,
  DrFailoverExecutionRecordSchema,
  type DrDrillExecutionRecord,
  type DrFailoverExecutionRecord,
} from "./records.js";
import {
  DrReplayer,
  verifyDrillExecutionShape,
  verifyFailoverExecutionShape,
} from "./replayer.js";
import { mockConnection } from "./test-fakes.js";

const NOW = "2026-06-02T12:00:00.000Z";
const LATER = "2026-06-02T12:30:00.000Z";
const DUE = "2026-09-02T12:00:00.000Z";

function embeddedFailover(overrides: Partial<FailoverRecord> = {}): FailoverRecord {
  return FailoverRecordSchema.parse({
    id: "fov_00000001",
    tier: "tier_1_business_critical",
    trigger: "planned_drill",
    triggeredBy: "operator-1",
    triggeredAt: NOW,
    fromRegion: "eu-central",
    toRegion: "us-east",
    affectedApps: ["billing"],
    status: "queued",
    ...overrides,
  });
}

function embeddedDrill(overrides: Partial<DrillRecord> = {}): DrillRecord {
  return DrillRecordSchema.parse({
    id: "drl_00000001",
    kind: "restore_test",
    tier: "tier_1_business_critical",
    scheduledFor: NOW,
    scopeRegions: ["eu-central"],
    scopeApps: ["billing"],
    outcome: "not_executed",
    nextDrillDueAt: DUE,
    ...overrides,
  });
}

function failoverExec(
  overrides: Partial<DrFailoverExecutionRecord> = {},
): DrFailoverExecutionRecord {
  return DrFailoverExecutionRecordSchema.parse({
    executionId: "fov_00000001",
    tenantId: null,
    tier: "tier_1_business_critical",
    trigger: "planned_drill",
    status: "queued",
    fromRegion: "eu-central",
    toRegion: "us-east",
    triggeredAt: NOW,
    completedAt: null,
    actualRpoSeconds: null,
    actualRtoSeconds: null,
    rpoBreached: null,
    rtoBreached: null,
    incidentTicketId: null,
    record: embeddedFailover(),
    recordedAt: LATER,
    ...overrides,
  });
}

function drillExec(
  overrides: Partial<DrDrillExecutionRecord> = {},
): DrDrillExecutionRecord {
  return DrDrillExecutionRecordSchema.parse({
    executionId: "drl_00000001",
    tenantId: null,
    kind: "restore_test",
    tier: "tier_1_business_critical",
    outcome: "not_executed",
    passing: null,
    rpoBreached: null,
    rtoBreached: null,
    scheduledFor: NOW,
    executedAt: null,
    record: embeddedDrill(),
    recordedAt: LATER,
    ...overrides,
  });
}

describe("verifyFailoverExecutionShape", () => {
  it("passes a clean queued record", () => {
    expect(verifyFailoverExecutionShape(failoverExec())).toHaveLength(0);
  });

  it("flags a succeeded record missing completion + rpo/rto", () => {
    const issues = verifyFailoverExecutionShape(
      failoverExec({ status: "succeeded" }),
    );
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain("succeeded_without_completion");
    expect(kinds).toContain("succeeded_without_rpo");
    expect(kinds).toContain("succeeded_without_rto");
  });

  it("flags a breach flagged without a measurement", () => {
    const issues = verifyFailoverExecutionShape(
      failoverExec({ rpoBreached: true, rtoBreached: true }),
    );
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain("rpo_breach_without_measurement");
    expect(kinds).toContain("rto_breach_without_measurement");
  });

  it("flags an outage trigger without an incident ticket", () => {
    const issues = verifyFailoverExecutionShape(
      failoverExec({ trigger: "regional_failure", incidentTicketId: null }),
    );
    expect(issues.map((i) => i.kind)).toContain("outage_without_incident_ticket");
  });

  it("accepts an outage trigger carrying an incident ticket", () => {
    const issues = verifyFailoverExecutionShape(
      failoverExec({
        trigger: "regional_failure",
        incidentTicketId: "INC-2026-0009",
      }),
    );
    expect(issues.map((i) => i.kind)).not.toContain(
      "outage_without_incident_ticket",
    );
  });
});

describe("verifyDrillExecutionShape", () => {
  it("passes a clean not_executed record", () => {
    expect(verifyDrillExecutionShape(drillExec())).toHaveLength(0);
  });

  it("flags an executed outcome without a timestamp", () => {
    const issues = verifyDrillExecutionShape(
      drillExec({ outcome: "passed", executedAt: null }),
    );
    expect(issues.map((i) => i.kind)).toContain("executed_without_timestamp");
  });

  it("flags a breach flagged without a measurement in the embedded record", () => {
    const issues = verifyDrillExecutionShape(
      drillExec({ rpoBreached: true, record: embeddedDrill() }),
    );
    expect(issues.map((i) => i.kind)).toContain(
      "drill_breach_without_measurement",
    );
  });
});

describe("DrReplayer", () => {
  it("bulkVerify aggregates failover + drill drift", async () => {
    const failoverStore = new PostgresDrFailoverStore(
      mockConnection(undefined, {
        rows: [
          {
            execution_id: "fov_00000001",
            tenant_id: null,
            tier: "tier_1_business_critical",
            trigger: "regional_failure",
            status: "queued",
            from_region: "eu-central",
            to_region: "us-east",
            triggered_at: new Date(NOW),
            completed_at: null,
            actual_rpo_seconds: null,
            actual_rto_seconds: null,
            rpo_breached: null,
            rto_breached: null,
            incident_ticket_id: null,
            record: embeddedFailover({ trigger: "planned_drill" }),
            recorded_at: new Date(LATER),
          },
        ],
        rowCount: 1,
      }),
    );
    const drillStore = new PostgresDrDrillStore(
      mockConnection(undefined, {
        rows: [
          {
            execution_id: "drl_00000001",
            tenant_id: null,
            kind: "restore_test",
            tier: "tier_1_business_critical",
            outcome: "passed",
            passing: true,
            rpo_breached: null,
            rto_breached: null,
            scheduled_for: new Date(NOW),
            executed_at: null,
            record: embeddedDrill(),
            recorded_at: new Date(LATER),
          },
        ],
        rowCount: 1,
      }),
    );
    const replayer = new DrReplayer(failoverStore, drillStore);
    const issues = await replayer.bulkVerify();
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain("outage_without_incident_ticket");
    expect(kinds).toContain("executed_without_timestamp");
  });

  it("summarize counts rows and issues", async () => {
    const failoverStore = new PostgresDrFailoverStore(
      mockConnection(undefined, { rows: [], rowCount: 0 }),
    );
    const drillStore = new PostgresDrDrillStore(
      mockConnection(undefined, { rows: [], rowCount: 0 }),
    );
    const replayer = new DrReplayer(failoverStore, drillStore);
    const summary = await replayer.summarize();
    expect(summary).toEqual({ failovers: 0, drills: 0, issues: 0 });
  });
});
