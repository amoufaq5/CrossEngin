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

/**
 * The list-valued members of `DrReadinessInput`: the axes along which a report carries evidence.
 *
 * Derived from the interface rather than listed, so a sixth list input cannot be added without
 * `DR_AXIS_EMPTY_MEANS` failing to satisfy its own shape. `tierSpecs` falls out by construction and
 * that is right rather than incidental: it is the tier *configuration* a report is scored against,
 * not a record of anything that happened, so an empty one is not an absence of evidence — and it
 * has a default, so it is never empty.
 */
export type DrReadinessAxis = {
  [K in keyof DrReadinessInput]-?: NonNullable<DrReadinessInput[K]> extends readonly unknown[]
    ? K
    : never;
}[keyof DrReadinessInput];

export const DR_AXIS_EMPTY_MEANINGS = ["unevidenced", "nothing_happened"] as const;
export type DrAxisEmptyMeaning = (typeof DR_AXIS_EMPTY_MEANINGS)[number];

/**
 * What an **empty** list on each axis means, as one total map over the five.
 *
 * Every count below is derived by *filtering* a supplied list, so an empty list contributes zero
 * issues on every axis and a deployment that recorded nothing scored `ready: true,
 * totalIssues: 0` — certified DR-ready in a SOC 2 evidence pack over no backup, no drill and no
 * runbook. Measured, that was *every* deployment rather than a misconfiguration: of the four
 * evidence axes only `drills` has a durable source (`drillStore.listRecent`), while `runbooks`,
 * `backups` and `replication` are hand-typed fields of the `--dr-readiness-config` JSON, each
 * `.default([])` — and `meta.backup_records` has no store, no reader and no writer anywhere in the
 * workspace. An absence of evidence is not evidence; this map is which absences are which.
 *
 * The asymmetry is the whole content, and reading it backwards inverts the defect rather than
 * weakening it. **`failovers` is `nothing_happened`**: an empty failover list is the *claim* that
 * nothing failed over — a fact about the deployment, and the healthy case. The other four are
 * absences of *evidence*: nobody drilled, nobody recorded a backup, no runbook is on file, lag was
 * never measured. Calling `failovers` unevidenced would make every healthy estate report a finding.
 */
export const DR_AXIS_EMPTY_MEANS = Object.freeze({
  drills: "unevidenced",
  runbooks: "unevidenced",
  backups: "unevidenced",
  replication: "unevidenced",
  failovers: "nothing_happened",
} as const) satisfies Readonly<Record<DrReadinessAxis, DrAxisEmptyMeaning>>;

/** The axes whose empty list is an absence of evidence, read off the map at the type level. */
export type DrEvidenceAxis = {
  [K in DrReadinessAxis]: (typeof DR_AXIS_EMPTY_MEANS)[K] extends "unevidenced" ? K : never;
}[DrReadinessAxis];

/**
 * The evidence axes in report order, fenced against the map in **both** directions.
 *
 * `DR_AXIS_EMPTY_MEANS` stays the single statement of which absence is which: `DrEvidenceAxis` is
 * read off it at the type level, and `satisfies readonly DrEvidenceAxis[]` here refuses any member
 * the map calls `nothing_happened` — so listing `failovers` is a compile error. The other
 * direction, an `unevidenced` axis missing from this tuple, is asserted as exact membership by
 * `the evidence-axis map` tests, which recompute it from the map rather than from this list.
 *
 * A literal and not `Object.keys(...).filter(...)` for two reasons that happen to agree. `z.enum`
 * wants a non-empty tuple and a filtered array is not one, so the derived form needed a cast
 * asserting what it could not show; and `pg-value-set-domains.ts` resolves an exported enum's
 * members by *reading* them, so a derived argument lands in that rule's `unresolved` bucket, which
 * it refuses to carry — measured, it reported exactly this constant.
 */
export const DR_EVIDENCE_AXES = [
  "drills",
  "runbooks",
  "backups",
  "replication",
] as const satisfies readonly DrEvidenceAxis[];

export const DrEvidenceAxisSchema = z.enum(DR_EVIDENCE_AXES);

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
  /**
   * Which evidence axes carried no record at all, with **absent kept apart from empty**.
   *
   * `null` is a report written before this check existed, and so one that cannot say; `[]` is the
   * claim that every axis carried a record; a non-empty list names the axes that did not. The
   * default is `null` and deliberately not `[]`, because `[]` would retro-assert the claim over
   * every stored row — the falsely-true direction (ADR-0331's claim-versus-nobody-looked,
   * ADR-0371's absent anchor provenance). `null` asserts nothing.
   *
   * It is defaulted rather than left bare because a stored `report` JSONB written before this
   * increment carries no such key: measured, a bare `.nullable()` refuses it `invalid_type:
   * Required`, and the only reader is `drReadinessSource`, which propagates the throw and takes the
   * whole certification report down over a row that was correct when written. The output type keeps
   * the field required, so the default is reachable only from a parse of stored data and no
   * producer in this package can forget it.
   */
  unevidencedAxes: z.array(DrEvidenceAxisSchema).nullable().default(null),
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

  // Read off `DR_EVIDENCE_AXES` so the list and the map cannot disagree, and annotated
  // `Record<DrEvidenceAxis, …>` so a fifth evidence axis is a compile error at the one place that
  // has to gather the lists — the map alone cannot force that, because nothing else here indexes it.
  const suppliedOnAxis: Readonly<Record<DrEvidenceAxis, readonly unknown[]>> = {
    drills,
    runbooks,
    backups,
    replication,
  };
  const unevidencedAxes = DR_EVIDENCE_AXES.filter((axis) => suppliedOnAxis[axis].length === 0);

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
  // An unevidenced axis is deliberately **not** an eighth summand here, and that is load-bearing
  // rather than tidy: `meta.dr_readiness_snapshots` projects each of these seven counts as its own
  // `INTEGER` column under a `>= 0` CHECK, so a reader summing the columns would disagree with the
  // stored total the moment an absence was folded in. It is a separate axis, and `ready = false`
  // beside `total_issues = 0` is precisely "nothing wrong was found because nothing was looked at".
  counts.totalIssues =
    counts.overdueDrills +
    counts.staleRunbooks +
    counts.expiredBackups +
    counts.unverifiedBackups +
    counts.replicationViolations +
    counts.failoverBreaches +
    counts.drillBreaches;

  return DrReadinessReportSchema.parse({
    ready: counts.totalIssues === 0 && unevidencedAxes.length === 0,
    unevidencedAxes,
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

/**
 * The three states of `unevidencedAxes`, each said differently.
 *
 * `null` must not print as "none", and that is the one rendering that would restate the defect in
 * the line written to report it: "no axis is unevidenced" is the claim a report predating the check
 * cannot make.
 */
export function formatUnevidencedAxes(axes: readonly DrEvidenceAxis[] | null): string {
  if (axes === null) return "not recorded (this report predates the check)";
  if (axes.length === 0) return "none — every axis carried a record";
  return axes.join(", ");
}

export function formatDrReadiness(report: DrReadinessReport): string {
  const lines: string[] = [];
  // The headline carries the unevidenced figure beside the issue count, because without it a reader
  // meets `NOT READY (0 issue(s))` on the first line with nothing on it explaining the pair.
  const unevidenced = report.unevidencedAxes;
  const verdictSuffix =
    unevidenced === null
      ? ", unevidenced axes not recorded"
      : unevidenced.length === 0
        ? ""
        : `, ${unevidenced.length} axis(es) unevidenced`;
  lines.push(
    `DR readiness: ${report.ready ? "READY" : "NOT READY"} (${report.counts.totalIssues} issue(s)${verdictSuffix})`,
  );
  lines.push(`  unevidenced axes:       ${formatUnevidencedAxes(unevidenced)}`);
  lines.push(`  overdue drills:         ${report.counts.overdueDrills}`);
  lines.push(`  stale runbooks:         ${report.counts.staleRunbooks}`);
  lines.push(`  expired backups:        ${report.counts.expiredBackups}`);
  lines.push(`  unverified backups:     ${report.counts.unverifiedBackups}`);
  lines.push(`  replication violations: ${report.counts.replicationViolations}`);
  lines.push(`  failover RPO/RTO breaches: ${report.counts.failoverBreaches}`);
  lines.push(`  drill RPO/RTO breaches:    ${report.counts.drillBreaches}`);
  return lines.join("\n");
}
