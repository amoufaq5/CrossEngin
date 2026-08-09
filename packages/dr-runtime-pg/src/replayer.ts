import type {
  DrDrillExecutionRecord,
  DrFailoverExecutionRecord,
} from "./records.js";
import { PostgresDrFailoverStore } from "./failover-store.js";
import { PostgresDrDrillStore } from "./drill-store.js";

export const DR_DRIFT_ISSUE_KINDS = [
  "succeeded_without_completion",
  "succeeded_without_rpo",
  "succeeded_without_rto",
  "rpo_breach_without_measurement",
  "rto_breach_without_measurement",
  "outage_without_incident_ticket",
  "executed_without_timestamp",
  "drill_breach_without_measurement",
] as const;
export type DrDriftIssueKind = (typeof DR_DRIFT_ISSUE_KINDS)[number];

export interface DrDriftIssue {
  readonly kind: DrDriftIssueKind;
  readonly executionId: string;
  readonly detail: string;
}

const INCIDENT_TRIGGERS = new Set(["primary_outage", "regional_failure"]);

export function verifyFailoverExecutionShape(
  record: DrFailoverExecutionRecord,
): readonly DrDriftIssue[] {
  const issues: DrDriftIssue[] = [];
  const at = (kind: DrDriftIssueKind, detail: string): void => {
    issues.push({ kind, executionId: record.executionId, detail });
  };

  if (record.status === "succeeded") {
    if (record.completedAt === null) {
      at("succeeded_without_completion", "succeeded failover has no completedAt");
    }
    if (record.actualRpoSeconds === null) {
      at("succeeded_without_rpo", "succeeded failover has no actualRpoSeconds");
    }
    if (record.actualRtoSeconds === null) {
      at("succeeded_without_rto", "succeeded failover has no actualRtoSeconds");
    }
  }
  if (record.rpoBreached === true && record.actualRpoSeconds === null) {
    at(
      "rpo_breach_without_measurement",
      "rpoBreached is true but actualRpoSeconds is null",
    );
  }
  if (record.rtoBreached === true && record.actualRtoSeconds === null) {
    at(
      "rto_breach_without_measurement",
      "rtoBreached is true but actualRtoSeconds is null",
    );
  }
  if (INCIDENT_TRIGGERS.has(record.trigger) && record.incidentTicketId === null) {
    at(
      "outage_without_incident_ticket",
      `trigger '${record.trigger}' requires an incidentTicketId`,
    );
  }
  return issues;
}

export function verifyDrillExecutionShape(
  record: DrDrillExecutionRecord,
): readonly DrDriftIssue[] {
  const issues: DrDriftIssue[] = [];
  const at = (kind: DrDriftIssueKind, detail: string): void => {
    issues.push({ kind, executionId: record.executionId, detail });
  };

  if (record.outcome !== null && record.outcome !== "not_executed") {
    if (record.executedAt === null) {
      at(
        "executed_without_timestamp",
        `outcome '${record.outcome}' has no executedAt`,
      );
    }
  }
  if (
    record.rpoBreached === true &&
    record.record.measuredRpoSeconds === null
  ) {
    at(
      "drill_breach_without_measurement",
      "rpoBreached is true but the drill records no measuredRpoSeconds",
    );
  }
  return issues;
}

export interface DrReplaySummary {
  readonly failovers: number;
  readonly drills: number;
  readonly issues: number;
}

export class DrReplayer {
  private readonly failoverStore: PostgresDrFailoverStore;
  private readonly drillStore: PostgresDrDrillStore;

  constructor(
    failoverStore: PostgresDrFailoverStore,
    drillStore: PostgresDrDrillStore,
  ) {
    this.failoverStore = failoverStore;
    this.drillStore = drillStore;
  }

  async verifyRecentFailovers(limit = 100): Promise<readonly DrDriftIssue[]> {
    const rows = await this.failoverStore.listRecent(limit);
    return rows.flatMap((row) => verifyFailoverExecutionShape(row));
  }

  async verifyRecentDrills(limit = 100): Promise<readonly DrDriftIssue[]> {
    const rows = await this.drillStore.listRecent(limit);
    return rows.flatMap((row) => verifyDrillExecutionShape(row));
  }

  async bulkVerify(limit = 100): Promise<readonly DrDriftIssue[]> {
    const [failovers, drills] = await Promise.all([
      this.verifyRecentFailovers(limit),
      this.verifyRecentDrills(limit),
    ]);
    return [...failovers, ...drills];
  }

  async summarize(limit = 100): Promise<DrReplaySummary> {
    const [failovers, drills] = await Promise.all([
      this.failoverStore.listRecent(limit),
      this.drillStore.listRecent(limit),
    ]);
    const issues =
      failovers.flatMap((row) => verifyFailoverExecutionShape(row)).length +
      drills.flatMap((row) => verifyDrillExecutionShape(row)).length;
    return { failovers: failovers.length, drills: drills.length, issues };
  }
}
