import type {
  DrDrillExecutionRecord,
  DrFailoverExecutionRecord,
} from "./records.js";
import { PostgresDrFailoverStore } from "./failover-store.js";
import { PostgresDrDrillStore } from "./drill-store.js";
import type { DrReadScope } from "./tenant-context.js";

/**
 * `projection_disagrees_with_record` is the detector for the failure mode the upsert introduces.
 *
 * Until these rows could be updated, both halves of every row — the indexed projection columns and
 * the `record` JSONB they are derived from — always came from one write, so they could not diverge
 * and nothing needed to check. A partial `SET` list makes divergence reachable: a column added to
 * the projection and forgotten in `FAILOVER_MUTABLE_COLUMNS`, or the reverse, leaves a row that
 * reports one status to a `WHERE status = …` query and another to `assessDrReadiness`, which reads
 * `record`. That is the shape the dropped-transition defect itself had — a stale half believed by
 * one reader — and it is worth a named finding rather than a comment.
 *
 * Note what the eight pre-existing kinds could *not* see: every one is an intra-row consistency
 * check, and a row left behind by `DO NOTHING` is a perfectly consistent *plan* row. The replayer
 * was not silently right about this bug; it was structurally unable to see it.
 */
export const DR_DRIFT_ISSUE_KINDS = [
  "succeeded_without_completion",
  "succeeded_without_rpo",
  "succeeded_without_rto",
  "rpo_breach_without_measurement",
  "rto_breach_without_measurement",
  "outage_without_incident_ticket",
  "executed_without_timestamp",
  "drill_breach_without_measurement",
  "projection_disagrees_with_record",
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
  for (const field of divergentFailoverFields(record)) {
    at(
      "projection_disagrees_with_record",
      `column '${field.column}' is ${JSON.stringify(field.projected)} and the record says ${JSON.stringify(field.inRecord)}`,
    );
  }
  return issues;
}

interface DivergentField {
  readonly column: string;
  readonly projected: unknown;
  readonly inRecord: unknown;
}

/**
 * Every projected column that is a copy of a `FailoverRecord` field, compared against it.
 *
 * `incident_ticket_id` is `null` in the row where the record leaves it `undefined`, so the
 * comparison normalises that one direction rather than reporting a difference that is only a
 * representation.
 */
function divergentFailoverFields(
  record: DrFailoverExecutionRecord,
): readonly DivergentField[] {
  const pairs: readonly DivergentField[] = [
    { column: "execution_id", projected: record.executionId, inRecord: record.record.id },
    { column: "tier", projected: record.tier, inRecord: record.record.tier },
    { column: "trigger", projected: record.trigger, inRecord: record.record.trigger },
    { column: "status", projected: record.status, inRecord: record.record.status },
    { column: "from_region", projected: record.fromRegion, inRecord: record.record.fromRegion },
    { column: "to_region", projected: record.toRegion, inRecord: record.record.toRegion },
    { column: "triggered_at", projected: record.triggeredAt, inRecord: record.record.triggeredAt },
    { column: "completed_at", projected: record.completedAt, inRecord: record.record.completedAt },
    {
      column: "actual_rpo_seconds",
      projected: record.actualRpoSeconds,
      inRecord: record.record.actualRpoSeconds,
    },
    {
      column: "actual_rto_seconds",
      projected: record.actualRtoSeconds,
      inRecord: record.record.actualRtoSeconds,
    },
    {
      column: "incident_ticket_id",
      projected: record.incidentTicketId,
      inRecord: record.record.incidentTicketId ?? null,
    },
  ];
  return pairs.filter((p) => p.projected !== p.inRecord);
}

function divergentDrillFields(
  record: DrDrillExecutionRecord,
): readonly DivergentField[] {
  const pairs: readonly DivergentField[] = [
    { column: "execution_id", projected: record.executionId, inRecord: record.record.id },
    { column: "kind", projected: record.kind, inRecord: record.record.kind },
    { column: "tier", projected: record.tier, inRecord: record.record.tier },
    { column: "outcome", projected: record.outcome, inRecord: record.record.outcome },
    {
      column: "scheduled_for",
      projected: record.scheduledFor,
      inRecord: record.record.scheduledFor,
    },
    { column: "executed_at", projected: record.executedAt, inRecord: record.record.executedAt },
  ];
  return pairs.filter((p) => p.projected !== p.inRecord);
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
  for (const field of divergentDrillFields(record)) {
    at(
      "projection_disagrees_with_record",
      `column '${field.column}' is ${JSON.stringify(field.projected)} and the record says ${JSON.stringify(field.inRecord)}`,
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

  async verifyRecentFailovers(
    scope: DrReadScope,
    limit = 100,
  ): Promise<readonly DrDriftIssue[]> {
    const rows = await this.failoverStore.listRecent(scope, limit);
    return rows.flatMap((row) => verifyFailoverExecutionShape(row));
  }

  async verifyRecentDrills(
    scope: DrReadScope,
    limit = 100,
  ): Promise<readonly DrDriftIssue[]> {
    const rows = await this.drillStore.listRecent(scope, limit);
    return rows.flatMap((row) => verifyDrillExecutionShape(row));
  }

  async bulkVerify(scope: DrReadScope, limit = 100): Promise<readonly DrDriftIssue[]> {
    const [failovers, drills] = await Promise.all([
      this.verifyRecentFailovers(scope, limit),
      this.verifyRecentDrills(scope, limit),
    ]);
    return [...failovers, ...drills];
  }

  /**
   * `scope` is required here for the same reason as on the stores, and the consequence is the one
   * ADR-0330 found for the workflow replayer inverted: an unscoped summary counted every tenant's
   * rows into one drift figure, so a clean scope could be reported as drifted by a row it does not
   * own — and a drifted one hidden among rows it does.
   */
  async summarize(scope: DrReadScope, limit = 100): Promise<DrReplaySummary> {
    const [failovers, drills] = await Promise.all([
      this.failoverStore.listRecent(scope, limit),
      this.drillStore.listRecent(scope, limit),
    ]);
    const issues =
      failovers.flatMap((row) => verifyFailoverExecutionShape(row)).length +
      drills.flatMap((row) => verifyDrillExecutionShape(row)).length;
    return { failovers: failovers.length, drills: drills.length, issues };
  }
}
