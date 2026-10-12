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

/**
 * The detector for the failure mode the upsert introduces.
 *
 * While these rows could only be inserted, both halves of a row — the projection columns and the
 * `record` JSONB they are copied from — always came from one write and could not diverge. A partial
 * `SET` list makes that reachable: a projection column outside `FAILOVER_MUTABLE_COLUMNS`, or a
 * record whose field moved while its column did not, leaves a row that answers one way to
 * `WHERE status = …` and another to `assessDrReadiness`, which reads `record`. That is the shape the
 * dropped-transition defect had — one stale half, believed by one reader.
 */
describe("projection_disagrees_with_record", () => {
  it("is silent when the two halves agree, which they do on every write the stores issue", () => {
    expect(verifyFailoverExecutionShape(failoverExec())).toHaveLength(0);
    expect(verifyDrillExecutionShape(drillExec())).toHaveLength(0);
  });

  it("catches a failover status column that moved while its record did not", () => {
    // Exactly what a `SET` list missing `record` would leave behind.
    const issues = verifyFailoverExecutionShape(
      failoverExec({
        status: "aborted",
        record: embeddedFailover({ status: "queued" }),
      }),
    );
    expect(issues.map((i) => i.kind)).toContain("projection_disagrees_with_record");
    expect(issues.find((i) => i.kind === "projection_disagrees_with_record")?.detail).toContain(
      "'status'",
    );
  });

  it("catches a record that advanced while its projection did not", () => {
    // And the reverse: a `SET` list carrying `record` and missing `completed_at`.
    const issues = verifyFailoverExecutionShape(
      failoverExec({
        status: "succeeded",
        completedAt: null,
        actualRpoSeconds: 30,
        actualRtoSeconds: 300,
        record: embeddedFailover({
          status: "succeeded",
          completedAt: LATER,
          actualRpoSeconds: 30,
          actualRtoSeconds: 300,
        }),
      }),
    );
    expect(issues.map((i) => i.kind)).toContain("projection_disagrees_with_record");
  });

  it("does not report an undefined incidentTicketId against a null column", () => {
    // The record leaves it `undefined` where the row holds `null`; that is a representation, not a
    // disagreement, and reporting it would fire on every healthy row — the false alarm ADR-0332
    // named as the thing that teaches an operator to ignore a detector.
    expect(failoverExec().record.incidentTicketId).toBeUndefined();
    expect(verifyFailoverExecutionShape(failoverExec())).toHaveLength(0);
  });

  it("catches a drill outcome and a scheduled_for that disagree with the record", () => {
    const issues = verifyDrillExecutionShape(
      drillExec({
        outcome: "passed",
        executedAt: LATER,
        scheduledFor: NOW,
        record: embeddedDrill({
          outcome: "passed",
          executedAt: LATER,
          executedBy: "operator-1",
          measuredRpoSeconds: 10,
          measuredRtoSeconds: 100,
          scheduledFor: "2026-05-02T12:00:00.000Z",
        }),
      }),
    );
    const divergent = issues.filter((i) => i.kind === "projection_disagrees_with_record");
    expect(divergent).toHaveLength(1);
    expect(divergent[0]?.detail).toContain("'scheduled_for'");
  });

  it("names every disagreeing column rather than stopping at the first", () => {
    const issues = verifyFailoverExecutionShape(
      failoverExec({
        status: "aborted",
        tier: "tier_3_recoverable",
        record: embeddedFailover({ status: "queued", tier: "tier_1_business_critical" }),
      }),
    );
    expect(issues.filter((i) => i.kind === "projection_disagrees_with_record")).toHaveLength(2);
  });

  /**
   * The timestamp halves are one moment in two media, and comparing them as text reported drift on
   * every healthy row whose writer did not spell it `toISOString()`'s way.
   *
   * These five fixtures are the forms `z.string().datetime({ offset: true })` accepts and
   * `FailoverExecutorInput.triggeredAt` / `DrillExecutorInput.scheduledFor` therefore let a caller
   * supply. Each names exactly the instant the `TIMESTAMPTZ` column round-trips as, so the only
   * difference is spelling — and each one false-positived before `divergesAt`.
   */
  describe("a timestamp is compared as an instant, not as text", () => {
    const COLUMN_FORM = "2026-06-02T12:00:00.000Z";
    const SAME_INSTANT = [
      ["no fractional seconds", "2026-06-02T12:00:00Z"],
      ["a positive offset", "2026-06-02T15:00:00+03:00"],
      ["a negative offset", "2026-06-02T07:00:00-05:00"],
      ["a zero offset spelled out", "2026-06-02T12:00:00+00:00"],
      ["microsecond precision", "2026-06-02T12:00:00.000000Z"],
    ] as const;

    for (const [label, spelling] of SAME_INSTANT) {
      it(`accepts a failover whose record writes triggeredAt with ${label}`, () => {
        const issues = verifyFailoverExecutionShape(
          failoverExec({
            triggeredAt: COLUMN_FORM,
            record: embeddedFailover({ triggeredAt: spelling }),
          }),
        );
        expect(issues.filter((i) => i.kind === "projection_disagrees_with_record")).toEqual([]);
      });

      it(`accepts a drill whose record writes scheduledFor with ${label}`, () => {
        const issues = verifyDrillExecutionShape(
          drillExec({
            scheduledFor: COLUMN_FORM,
            record: embeddedDrill({ scheduledFor: spelling }),
          }),
        );
        expect(issues.filter((i) => i.kind === "projection_disagrees_with_record")).toEqual([]);
      });
    }

    it("still catches a completedAt that is a genuinely different moment", () => {
      const issues = verifyFailoverExecutionShape(
        failoverExec({
          status: "succeeded",
          completedAt: LATER,
          actualRpoSeconds: 30,
          actualRtoSeconds: 300,
          record: embeddedFailover({
            status: "succeeded",
            // One hour out: the same spelling family as the column, a different instant.
            completedAt: "2026-06-02T13:30:00.000Z",
            actualRpoSeconds: 30,
            actualRtoSeconds: 300,
          }),
        }),
      );
      const divergent = issues.filter((i) => i.kind === "projection_disagrees_with_record");
      expect(divergent).toHaveLength(1);
      expect(divergent[0]?.detail).toContain("'completed_at'");
    });

    it("still catches a null column against a record that carries a moment", () => {
      const issues = verifyFailoverExecutionShape(
        failoverExec({
          status: "succeeded",
          completedAt: null,
          actualRpoSeconds: 30,
          actualRtoSeconds: 300,
          record: embeddedFailover({
            status: "succeeded",
            completedAt: "2026-06-02T12:30:00+00:00",
            actualRpoSeconds: 30,
            actualRtoSeconds: 300,
          }),
        }),
      );
      expect(
        issues.some(
          (i) => i.kind === "projection_disagrees_with_record" && i.detail.includes("'completed_at'"),
        ),
      ).toBe(true);
    });

    it("reports the raw pair rather than the normalised one, so the row is recognisable", () => {
      const issues = verifyDrillExecutionShape(
        drillExec({
          scheduledFor: COLUMN_FORM,
          record: embeddedDrill({ scheduledFor: "2026-05-02T12:00:00+00:00" }),
        }),
      );
      const divergent = issues.find((i) => i.kind === "projection_disagrees_with_record");
      expect(divergent?.detail).toContain("2026-05-02T12:00:00+00:00");
    });

    it("leaves a non-timestamp column compared exactly", () => {
      // Only the four timestamp pairs are normalised. Every other column is an enum or an
      // identifier, where two values are two values and normalising would be the opposite mistake.
      const issues = verifyFailoverExecutionShape(
        failoverExec({
          trigger: "planned_drill",
          record: embeddedFailover({ trigger: "maintenance_window" }),
        }),
      );
      expect(
        issues.some(
          (i) => i.kind === "projection_disagrees_with_record" && i.detail.includes("'trigger'"),
        ),
      ).toBe(true);
    });
  });

  it("could not have caught the dropped transition it was added alongside", () => {
    // A row left behind by `DO NOTHING` is a perfectly consistent *plan* row: both halves come from
    // the plan write and agree with each other. The replayer was not silently right about that bug;
    // every one of its checks is intra-row, so it was structurally unable to see it.
    const planRowLeftBehind = failoverExec({
      status: "queued",
      completedAt: null,
      actualRpoSeconds: null,
      actualRtoSeconds: null,
      record: embeddedFailover({ status: "queued" }),
    });
    expect(verifyFailoverExecutionShape(planRowLeftBehind)).toHaveLength(0);
  });
});

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
    const issues = await replayer.bulkVerify(null);
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
    const summary = await replayer.summarize(null);
    expect(summary).toEqual({ failovers: 0, drills: 0, issues: 0 });
  });
});
