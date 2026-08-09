import { z } from "zod";
import {
  DEFAULT_DR_TIERS,
  exceededRpo,
  exceededRto,
  exceededRpoInDrill,
  exceededRtoInDrill,
  expiredBackups,
  isBackupVerified,
  isDrillPassing,
  overdueDrills,
  staleRunbooks,
  violatesTier,
  type BackupRecord,
  type DrillRecord,
  type DrTier,
  type DrTierSpec,
  type FailoverRecord,
  type ReplicationLagRecord,
  type RunbookSpec,
} from "@crossengin/dr";

export interface ReplicationLagInput {
  readonly record: ReplicationLagRecord;
  readonly tier: DrTier;
}

export interface DrReadinessInput {
  readonly drills?: readonly DrillRecord[];
  readonly runbooks?: readonly RunbookSpec[];
  readonly backups?: readonly BackupRecord[];
  readonly replication?: readonly ReplicationLagInput[];
  readonly failovers?: readonly FailoverRecord[];
  readonly tierSpecs?: Readonly<Record<DrTier, DrTierSpec>>;
  readonly maxRunbookDaysSinceReview?: number;
  readonly maxRunbookDaysSinceTest?: number;
  readonly now?: Date;
}

export const DEFAULT_MAX_RUNBOOK_DAYS_SINCE_REVIEW = 180;
export const DEFAULT_MAX_RUNBOOK_DAYS_SINCE_TEST = 365;

export const FailoverBreachSchema = z.object({
  failoverId: z.string(),
  tier: z.string(),
  rpoBreached: z.boolean(),
  rtoBreached: z.boolean(),
});
export type FailoverBreach = z.infer<typeof FailoverBreachSchema>;

export const DrillBreachSchema = z.object({
  drillId: z.string(),
  tier: z.string(),
  rpoBreached: z.boolean(),
  rtoBreached: z.boolean(),
  passing: z.boolean(),
});
export type DrillBreach = z.infer<typeof DrillBreachSchema>;

export const DrReadinessReportSchema = z.object({
  ready: z.boolean(),
  overdueDrillIds: z.array(z.string()),
  staleRunbookIds: z.array(z.string()),
  expiredBackupIds: z.array(z.string()),
  unverifiedBackupIds: z.array(z.string()),
  replicationViolations: z.array(z.string()),
  failoverBreaches: z.array(FailoverBreachSchema),
  drillBreaches: z.array(DrillBreachSchema),
  counts: z.object({
    overdueDrills: z.number().int().nonnegative(),
    staleRunbooks: z.number().int().nonnegative(),
    expiredBackups: z.number().int().nonnegative(),
    unverifiedBackups: z.number().int().nonnegative(),
    replicationViolations: z.number().int().nonnegative(),
    failoverBreaches: z.number().int().nonnegative(),
    drillBreaches: z.number().int().nonnegative(),
    totalIssues: z.number().int().nonnegative(),
  }),
});
export type DrReadinessReport = z.infer<typeof DrReadinessReportSchema>;

export function assessDrReadiness(input: DrReadinessInput): DrReadinessReport {
  const now = input.now ?? new Date();
  const specs = input.tierSpecs ?? DEFAULT_DR_TIERS;
  const drills = input.drills ?? [];
  const runbooks = input.runbooks ?? [];
  const backups = input.backups ?? [];
  const replication = input.replication ?? [];
  const failovers = input.failovers ?? [];
  const maxReview = input.maxRunbookDaysSinceReview ?? DEFAULT_MAX_RUNBOOK_DAYS_SINCE_REVIEW;
  const maxTest = input.maxRunbookDaysSinceTest ?? DEFAULT_MAX_RUNBOOK_DAYS_SINCE_TEST;

  const overdueDrillIds = overdueDrills(drills, now).map((d) => d.id);
  const staleRunbookIds = staleRunbooks(runbooks, maxReview, maxTest, now).map((r) => r.id);
  const expiredBackupIds = expiredBackups(backups, now).map((b) => b.id);
  const unverifiedBackupIds = backups
    .filter((b) => b.status === "succeeded" && !isBackupVerified(b))
    .map((b) => b.id);

  const replicationViolations = replication
    .filter(({ record, tier }) => violatesTier(record, specs[tier]))
    .map(({ record }) => `${record.source}->${record.target}`);

  const failoverBreaches: FailoverBreach[] = [];
  for (const record of failovers) {
    const spec = specs[record.tier];
    const rpoBreached = exceededRpo(record, spec);
    const rtoBreached = exceededRto(record, spec);
    if (rpoBreached || rtoBreached) {
      failoverBreaches.push({ failoverId: record.id, tier: record.tier, rpoBreached, rtoBreached });
    }
  }

  const drillBreaches: DrillBreach[] = [];
  for (const record of drills) {
    const spec = specs[record.tier];
    const rpoBreached = exceededRpoInDrill(record, spec);
    const rtoBreached = exceededRtoInDrill(record, spec);
    const passing = isDrillPassing(record);
    const executedAndFailed = record.executedAt !== null && !passing;
    if (rpoBreached || rtoBreached || executedAndFailed) {
      drillBreaches.push({ drillId: record.id, tier: record.tier, rpoBreached, rtoBreached, passing });
    }
  }

  const counts = {
    overdueDrills: overdueDrillIds.length,
    staleRunbooks: staleRunbookIds.length,
    expiredBackups: expiredBackupIds.length,
    unverifiedBackups: unverifiedBackupIds.length,
    replicationViolations: replicationViolations.length,
    failoverBreaches: failoverBreaches.length,
    drillBreaches: drillBreaches.length,
    totalIssues: 0,
  };
  counts.totalIssues =
    counts.overdueDrills +
    counts.staleRunbooks +
    counts.expiredBackups +
    counts.unverifiedBackups +
    counts.replicationViolations +
    counts.failoverBreaches +
    counts.drillBreaches;

  return DrReadinessReportSchema.parse({
    ready: counts.totalIssues === 0,
    overdueDrillIds,
    staleRunbookIds,
    expiredBackupIds,
    unverifiedBackupIds,
    replicationViolations,
    failoverBreaches,
    drillBreaches,
    counts,
  });
}

export function formatDrReadiness(report: DrReadinessReport): string {
  const lines: string[] = [];
  lines.push(`DR readiness: ${report.ready ? "READY" : "NOT READY"} (${report.counts.totalIssues} issue(s))`);
  lines.push(`  overdue drills:         ${report.counts.overdueDrills}`);
  lines.push(`  stale runbooks:         ${report.counts.staleRunbooks}`);
  lines.push(`  expired backups:        ${report.counts.expiredBackups}`);
  lines.push(`  unverified backups:     ${report.counts.unverifiedBackups}`);
  lines.push(`  replication violations: ${report.counts.replicationViolations}`);
  lines.push(`  failover RPO/RTO breaches: ${report.counts.failoverBreaches}`);
  lines.push(`  drill RPO/RTO breaches:    ${report.counts.drillBreaches}`);
  return lines.join("\n");
}
