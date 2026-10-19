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
  /**
   * How the read that produced the five lists above came back, which is not itself evidence.
   *
   * **A nested object and deliberately not a sixth list-valued member**, because ADR-0372's type
   * fence refused that and was right to: every list-valued member of this interface *is* an
   * evidence axis by `DrReadinessAxis`' own definition, so a `readonly DrReadinessAxis[]` here
   * makes the alias circular — measured, `TS2502` on the field and `TS2456` on the alias. One
   * object is not a list, and what it holds is a statement *about* the evidence rather than more of
   * it.
   *
   * It rides on the input and not on a second parameter of `assessDrReadiness`, which was built
   * first and measured worse. The only caller that can fill it is two hops from this function —
   * `apps/operate-server`'s readiness lifecycle calls `buildPersistentDrRuntime(...).assess`, which
   * calls `DrRuntime.assess`, which calls this — so a parameter would be two new places to drop
   * the fact, and dropping it reads as *no row was refused*: this run's most-found shape, in the
   * increment that exists to close an instance of it. A field on the object that carries the lists
   * cannot be separated from them, and `DrRuntime.assess`' own `{...input, now}` spread carries it
   * with no edit at either hop.
   */
  readonly evidenceRead?: DrEvidenceReadOutcome;
}

/** What a caller's **read** of the evidence came back as. See `DrReadinessInput.evidenceRead`. */
export interface DrEvidenceReadOutcome {
  /**
   * The axes whose page came back **incomplete** — at least one stored row this binary could not
   * represent.
   *
   * Supplied rather than derived, and that is the whole reason it exists: `assessDrReadiness` is
   * handed five lists and has no way to know whether a list is the whole of what is on disk. Only
   * the caller that issued the read knows, and before ADR-0373 that caller never got the chance to
   * say — a refused row threw out of the page, so no snapshot was recorded at all. Now the pass
   * completes over the readable subset, and without this the report scores the subset as if it were
   * everything (see `DrReadinessReportSchema.unreadableEvidenceAxes`).
   *
   * **Optional, with absence meaning `[]`**, which is the one place in this area that is not
   * ADR-0331's claim-versus-nobody-looked rule, because here absence is decidable. **Three** of the
   * five axes are read from no store: `--dr-readiness-config` supplies `runbooks`, `backups` and
   * `replication` as literal JSON lists, so for a caller passing literals there is no read behind
   * them and "no row was refused" is true by construction — a required field would demand a
   * ceremonial `[]` from every caller for whom the question is meaningless, `assessDrReadiness({})`
   * included. The one caller that *does* read from a store is fenced where the fence can bite:
   * `DrReadinessLifecycleOptions.onUnreadableExecution` is required, and the lifecycle accumulates
   * this list in the same closure that invokes it, so a row reported and not counted is not
   * expressible there. The report's own field keeps the three-valued distinction, because there
   * absence means a stored row written before the check and nothing can decide it.
   */
  readonly unreadableEvidenceAxes?: readonly DrReadinessAxis[];
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

/**
 * All five axes, `failovers` included — the vocabulary for facts that are **not** about an empty
 * list.
 *
 * `DR_EVIDENCE_AXES` is the four whose emptiness is an absence of evidence, and narrowing it that
 * way is what makes `unevidencedAxes` honest: naming `failovers` there is a compile error because
 * an empty failover list is the healthy claim that nothing failed over. That narrowing is a
 * statement about **emptiness**, so it does not transfer to any other question, and
 * `unreadableEvidenceAxes` is the first question it was wrong for — a refused failover row is
 * incomplete failover evidence whatever an empty list would have meant.
 *
 * Typed over all five and deliberately **not** over the two that have a store read today
 * (`failovers` and `drills`; `runbooks`, `backups` and `replication` arrive as literal
 * `--dr-readiness-config` lists, so no row can be refused on them). That narrowing was considered
 * and refused on the difference between *unproduced* and *meaningless*: `failovers`-as-unevidenced
 * is meaningless, while `backups`-as-partly-unreadable is merely unproduced **today** —
 * `meta.backup_records` is catalogued and has no writer (ADR-0372's own open question 6), so the
 * day it gets one a refused backup row is a legitimate value this enum would have to be widened to
 * admit, with every stored row's vocabulary in question. A schema admitting a value no producer
 * makes is this repo's accepted shape (`DR_VERDICT_UNEXPLAINED_FINDING` is the same); a schema
 * refusing a value a future producer legitimately makes is a migration. The narrowing that *is*
 * load-bearing lives at the call site that knows: `UnreadableDrExecution.axis` in
 * `apps/operate-server/src/dr-readiness.ts` is `Extract`ed to exactly the two axes the lifecycle
 * reads from a store.
 *
 * A literal tuple with `satisfies` for `DR_EVIDENCE_AXES`' two measured reasons — `z.enum` wants a
 * non-empty tuple, and `pg-value-set-domains.ts` resolves an exported enum's members by reading
 * them — and fenced in both directions: `satisfies` refuses a non-axis here, and the axis-map tests
 * recompute exact membership from `DR_AXIS_EMPTY_MEANS` rather than from this list.
 */
export const DR_READINESS_AXES = [
  "failovers",
  "drills",
  "runbooks",
  "backups",
  "replication",
] as const satisfies readonly DrReadinessAxis[];

export const DrReadinessAxisSchema = z.enum(DR_READINESS_AXES);

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
  /**
   * Which axes' evidence came back with **at least one row this binary could not represent**, with
   * absent kept apart from empty exactly as its sibling above.
   *
   * It is a different fact from `unevidencedAxes` and neither can say the other, which is why there
   * are two fields rather than one list with a wider enum. `unevidencedAxes` means *this axis
   * carried no record at all*, and `evidenceFromDrReadiness` renders it verbatim into a SOC 2 pack
   * as `no <axis> record was supplied, so nothing on that axis was verified` — false the moment one
   * readable row sits beside the refused one, which is the common case and is a refusal shaped like
   * a finding (ADR-0336 ranks a wrong answer below a refusal, and a refusal built on a false
   * statement is still a wrong answer). It also cannot carry `failovers` at all, by design.
   *
   * The two **compose** rather than excluding each other, and the pair is more informative than
   * either: `unevidencedAxes: ["drills"]` alone is *nobody drilled*, while the same beside
   * `unreadableEvidenceAxes: ["drills"]` is *drills happened and their rows cannot be read* —
   * ADR-0331's claim-versus-nobody-looked at the axis level, and two opposite remedies (go drill;
   * go fix the row). So this names an axis whenever **any** of its rows was refused, with no
   * "partly" claim smuggled into the name.
   *
   * Three-valued, `null` by default and deliberately not `[]`, for the sibling's reason: a stored
   * `report` JSONB written before this check carries no such key, and a `.default([])` would
   * retro-assert *every axis read completely* over every one of those rows, which is the
   * falsely-true direction. There is a measured counter-argument and it is refused: before ADR-0373
   * a refused row threw out of `assessOnce` into the scheduler's `catch`, so **no snapshot was
   * recorded at all** — every pre-existing row provably came from a pass in which every row read,
   * and `[]` would be true of it. That proves something about one producer at one commit, where the
   * default is applied on every parse for ever, including a hand-edited row and a later producer;
   * and the premise is the behaviour ADR-0373 *removed*, so the population it holds for is closed.
   * `null` asserts nothing, and the one reader refuses to certify on it.
   */
  unreadableEvidenceAxes: z.array(DrReadinessAxisSchema).nullable().default(null),
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

  // Filtered off `DR_READINESS_AXES` rather than copied from the caller, which de-duplicates and
  // puts the list in the report's own axis order in one expression — `unevidencedAxes`' idiom one
  // line up. A caller reporting the same axis per refused row (which the lifecycle does, once per
  // row) must not produce `["drills", "drills", "drills"]` in a stored record, and an order that
  // depended on which read finished first would make two passes over one estate compare unequal.
  const reportedUnreadable = input.evidenceRead?.unreadableEvidenceAxes ?? [];
  const unreadableEvidenceAxes = DR_READINESS_AXES.filter((axis) =>
    reportedUnreadable.includes(axis),
  );

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
    // **An unreadable axis is a third way to be not ready**, and folding it in here does not change
    // what `ready` means — ADR-0372 already made this verdict "no issue was found *and* the
    // evidence was complete" when it added the `unevidencedAxes` clause, so an axis whose page had
    // refused rows is the second way evidence is incomplete rather than a new kind of fact. The
    // alternative, guarding only in `evidenceFromDrReadiness`, was measured and refused for a
    // reason this run keeps finding: `formatDrReadiness` and the `[dr] readiness ready=…` boot
    // line read `ready`, so a stored `ready: true` beside a `satisfied: false` control would be
    // one process contradicting itself about one estate, with the **reassuring** half on the
    // surface an operator actually reads (ADR-0361). `totalIssues` is untouched for ADR-0372's
    // stated reason: the seven counts are projected as their own `INTEGER` columns and a reader
    // sums them, so an eighth summand would make the stored total disagree with the columns beside
    // it. `ready = false` with `total_issues = 0` is explicable; a wrong sum is not.
    ready:
      counts.totalIssues === 0 &&
      unevidencedAxes.length === 0 &&
      unreadableEvidenceAxes.length === 0,
    unevidencedAxes,
    unreadableEvidenceAxes,
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
  return formatThreeValuedAxes(
    axes,
    "not recorded (this report predates the check)",
    "none — every axis carried a record",
  );
}

/**
 * The same three states for the second axis list, with its own two sentences.
 *
 * A sibling rather than a widened `formatUnevidencedAxes`, because the two lists answer different
 * questions and a reader meeting one sentence under two labels learns nothing from the label. What
 * must **not** diverge is the rule — `null` is not "none" — so that lives in one place below and
 * both of these are the sentences.
 */
export function formatUnreadableEvidenceAxes(axes: readonly DrReadinessAxis[] | null): string {
  return formatThreeValuedAxes(
    axes,
    "not recorded (this report predates the unreadable-row check)",
    "none — every axis's evidence read completely",
  );
}

/**
 * `null` must not print as "none", which is the one rendering that would restate the defect in the
 * line written to report it: "no axis is unevidenced" is the claim a report predating the check
 * cannot make, and "every axis read completely" is the claim a report predating ADR-0373 cannot.
 *
 * One function and not two copies, so the rule cannot hold for one list and lapse for the other —
 * which is how one half of a pair goes quiet (ADR-0373's own class, and ADR-0361's).
 */
function formatThreeValuedAxes(
  axes: readonly string[] | null,
  absentSentence: string,
  emptySentence: string,
): string {
  if (axes === null) return absentSentence;
  if (axes.length === 0) return emptySentence;
  return axes.join(", ");
}

export function formatDrReadiness(report: DrReadinessReport): string {
  const lines: string[] = [];
  // The headline carries the unevidenced figure beside the issue count, because without it a reader
  // meets `NOT READY (0 issue(s))` on the first line with nothing on it explaining the pair.
  const unevidenced = report.unevidencedAxes;
  const unreadable = report.unreadableEvidenceAxes;
  const verdictSuffix =
    unevidenced === null
      ? ", unevidenced axes not recorded"
      : unevidenced.length === 0
        ? ""
        : `, ${unevidenced.length} axis(es) unevidenced`;
  // Appended rather than folded into the suffix above, so a report that is both carries both
  // reasons: a `NOT READY (0 issue(s))` headline whose only explanation was dropped is the
  // unexplained pair this function's own comment exists to prevent, and now there are two ways to
  // reach it.
  const unreadableSuffix =
    unreadable === null
      ? ", unreadable-row check not recorded"
      : unreadable.length === 0
        ? ""
        : `, ${unreadable.length} axis(es) partly unreadable`;
  lines.push(
    `DR readiness: ${report.ready ? "READY" : "NOT READY"} (${report.counts.totalIssues} issue(s)${verdictSuffix}${unreadableSuffix})`,
  );
  lines.push(`  unevidenced axes:       ${formatUnevidencedAxes(unevidenced)}`);
  lines.push(`  unreadable evidence:    ${formatUnreadableEvidenceAxes(unreadable)}`);
  lines.push(`  overdue drills:         ${report.counts.overdueDrills}`);
  lines.push(`  stale runbooks:         ${report.counts.staleRunbooks}`);
  lines.push(`  expired backups:        ${report.counts.expiredBackups}`);
  lines.push(`  unverified backups:     ${report.counts.unverifiedBackups}`);
  lines.push(`  replication violations: ${report.counts.replicationViolations}`);
  lines.push(`  failover RPO/RTO breaches: ${report.counts.failoverBreaches}`);
  lines.push(`  drill RPO/RTO breaches:    ${report.counts.drillBreaches}`);
  return lines.join("\n");
}
