import { z } from "zod";
import type { ComplianceFramework } from "@crossengin/access-reviews";
import { EVIDENCE_SOURCE_KINDS } from "./controls.js";

export const ControlEvidenceSchema = z
  .object({
    controlId: z.string().min(1),
    sourceKind: z.enum(EVIDENCE_SOURCE_KINDS),
    satisfied: z.boolean(),
    summary: z.string().min(1),
    findings: z.array(z.string().min(1)),
    observedAt: z.string().datetime(),
    detailRef: z.string().min(1).nullable(),
  })
  .strict();
export type ControlEvidence = z.infer<typeof ControlEvidenceSchema>;

/** Structural view of `EncryptionCoverageReport` from `@crossengin/kernel-pg`. */
export interface EncryptionCoverageLike {
  readonly schema: string;
  readonly pgcryptoInstalled: boolean;
  readonly total: number;
  readonly plaintext: number;
  readonly issues: readonly { readonly kind: string; readonly detail: string }[];
}

/** Structural view of `DrReadinessReport` from `@crossengin/dr-runtime`. */
export interface DrReadinessLike {
  readonly ready: boolean;
  /**
   * Which of the report's evidence axes carried no record, `null` when it cannot say.
   *
   * **Required, not optional**, on this repo's rule (ADR-0338, ADR-0361): a default that cannot
   * possibly be correct fails silently in the unsafe direction, so the compiler asks instead. An
   * absent field defaulting to `[]` would assert that every axis carried a record, which is exactly
   * the claim this control used to make over nothing.
   *
   * `readonly string[]` and not the axis enum because this is a structural view and
   * `@crossengin/certification-runtime` does not depend on `@crossengin/dr-runtime` — so the
   * vocabulary is not importable here, and the axis names are rendered into findings rather than
   * matched against a closed set. The producer's own schema is where an unrecognised axis is
   * refused.
   */
  readonly unevidencedAxes: readonly string[] | null;
  readonly counts: {
    readonly totalIssues: number;
    readonly overdueDrills?: number;
    readonly staleRunbooks?: number;
    readonly expiredBackups?: number;
    readonly unverifiedBackups?: number;
    /**
     * The seventh summand, and it was missing from this view while the producer and the stored row
     * both carried it — so a deployment whose only DR issues were replication violations was told
     * `NOT READY (3 issue(s))` with the bare header as its **entire** findings list: three issues
     * and not one word about what they were. `assessDrReadiness` sums exactly these seven into
     * `totalIssues` from one source, so six readable of seven summands meant the header could
     * exceed everything this adapter was able to name.
     */
    readonly replicationViolations?: number;
    readonly failoverBreaches?: number;
    readonly drillBreaches?: number;
  };
}

/** Structural view of `AccessReviewEvidence` from `@crossengin/access-reviews`. */
export interface AccessReviewEvidenceLike {
  readonly framework: ComplianceFramework;
  readonly status: string;
  readonly sealedSha256: string | null;
  /**
   * How many access-review items this pack's campaigns covered in total.
   *
   * **Required, not optional**, for `unevidencedAxes`' reason: it is the only field that lets this
   * adapter see its own scope, and a default cannot be correct in either direction — `0` would
   * refuse every pack written before the field was read, and any positive default would assert a
   * scope nobody counted. The record has carried this figure since it was written
   * (`AccessReviewEvidenceSchema.totalItemsAcrossCampaigns`), the producer derives it from
   * `input.items.length` and the store binds and reads it back, so the one non-test caller passes
   * the whole record and satisfies this for free.
   *
   * Without it the only quantitative gate here was `completionRate`, which
   * `computeCampaignEvidenceMetrics` answers `1` over zero items as a division guard — so an
   * empty pack read as a complete one.
   */
  readonly totalItemsAcrossCampaigns: number;
  readonly completionRate: number;
  readonly strongAttestationRate: number;
  readonly controlMappings: readonly string[];
}

/** Structural view of `verifyChainIntegrity(...)` from `@crossengin/forensics`. */
export interface ForensicChainLike {
  readonly valid: boolean;
  readonly brokenAt: number | null;
  readonly reason?: string | null;
}

const SEALED_EVIDENCE_STATUSES: ReadonlySet<string> = new Set([
  "sealed",
  "submitted_to_auditor",
  "accepted_by_auditor",
]);

export const DEFAULT_MIN_COMPLETION_RATE = 0.95;

/**
 * The finding a schema with no at-rest columns carries.
 *
 * Named rather than inlined so a reader of a stored report can tell this apart from a real
 * plaintext finding, and so a test can assert on it without matching prose.
 */
export const ENCRYPTION_SCOPE_ABSENT_FINDING =
  "scope_absent: no column is declared encrypt-at-rest in this schema, so nothing was verified — on a JSONB-store deployment every phi/regulated field lives in one JSONB document column and is stored in plaintext";

/**
 * The findings a DR readiness report carries when it cannot evidence the control.
 *
 * Named rather than inlined for `ENCRYPTION_SCOPE_ABSENT_FINDING`'s reasons, and spelled in its
 * idiom — the first word is the machine-readable kind, so a reader of a stored report can filter on
 * it and a test can assert on it without matching prose.
 */
export const DR_EVIDENCE_SCOPE_UNKNOWN_FINDING =
  "evidence_scope_unknown: this DR readiness report predates the unevidenced-axis check, so it cannot say which axes carried a record — and a report that cannot say whether anything was looked at does not evidence this control";

/**
 * The finding an access-review pack covering no item at all carries.
 *
 * Deliberately the **same `scope_absent` kind** as the encryption sibling rather than a third
 * spelling: it is one class — *this control was asked over an empty scope and so certified
 * nothing* — and sharing the kind is what lets a reader of a stored report answer "which controls
 * were satisfied over nothing?" with one filter. The two are told apart by the `sourceKind` on the
 * evidence that carries them, which is already how a reader reaches a finding.
 */
export const ACCESS_REVIEW_SCOPE_ABSENT_FINDING =
  "scope_absent: this access-review pack covered no item across its campaigns, so no access was reviewed — completionRate is 1 over zero items as a division guard, not as a measurement, so an empty pack seals and reads as a complete one";

export const DR_AXIS_UNEVIDENCED_KIND = "axis_unevidenced";

export function drAxisUnevidencedFinding(axis: string): string {
  return (
    `${DR_AXIS_UNEVIDENCED_KIND}: no ${axis} record was supplied, so nothing on that axis was ` +
    "verified — every count in a readiness report is derived by filtering a supplied list, so an " +
    "empty one scores zero issues rather than a finding"
  );
}

/**
 * The report declares itself not ready for a reason this reader cannot itemize.
 *
 * Unreachable from any producer in this workspace — `assessDrReadiness` sets `ready` to exactly
 * `totalIssues === 0 && unevidencedAxes.length === 0`, so a `false` there always comes with an
 * issue count or a named axis. It is reachable from a hand-edited row and from a later producer
 * with an axis this reader does not know, and in both cases the alternative is `satisfied: false`
 * with an empty findings list: a claim with no evidence, in the function written to end that.
 * Said rather than assumed away (ADR-0371's `anchor_unverified`).
 *
 * The sentence names **all three** of the things that have to be absent for it to fire, because it
 * used to name two and was therefore false about the very row it was added for: with the
 * itemization gated on the stored total, `{totalIssues: 0, overdueDrills: 3, expiredBackups: 2}`
 * surfaced neither of its two component counts and this finding then asserted the report carried
 * none. A finding that misdescribes its own trigger is worse than no finding.
 */
export const DR_VERDICT_UNEXPLAINED_FINDING =
  "verdict_unexplained: this report declares itself not ready while carrying no issue count, no component count and no unevidenced axis, so the reason is one this reader cannot itemize";

/**
 * Whether a scope figure says that **something was in scope**, failing closed on anything it cannot
 * read as a positive count.
 *
 * `=== 0` is the obvious spelling and it fails **open**. These are *structural* views, so a caller
 * the compiler never sees — plain JS, or a row off `JSON.parse` whose producer predates the
 * field — passes `undefined`, and `undefined === 0` is false, which reads as "scope present" and
 * certifies the control over nothing. `NaN` and a negative count do the same. Negating `> 0` is
 * total over all three: only a number strictly above zero asserts a scope, which is this repo's
 * fail-closed rule — when a check cannot be completed, deny rather than allow.
 *
 * One predicate and not one per adapter, because the two call sites answer the same question and a
 * second spelling is how one of them ends up fail-open again.
 */
function scopeIsAbsent(count: number): boolean {
  return !(count > 0);
}

export function evidenceFromEncryptionCoverage(
  controlId: string,
  report: EncryptionCoverageLike,
  observedAt: string,
): ControlEvidence {
  const findings = report.issues.map((i) => `${i.kind}: ${i.detail}`);
  // `issues.length === 0` means "no plaintext column was found", which is a different statement
  // from "no column was found", and on the deployment that matters they are not the same fact.
  // A JSONB-store deployment keeps every field — `phi` and `regulated` included — inside one
  // `document` JSONB column, so it declares **zero** at-rest columns and therefore zero issues,
  // and this control used to answer `satisfied: true` with the summary "0 at-rest column(s) …
  // are ciphertext; pgcrypto installed". Verified live: the same `POST /v1/patients` that 500s on
  // the column store returns 201 on the JSONB store and `document->>'mrn'` reads back `MRN-1` in
  // plaintext. So the control affirmed encryption at rest over unencrypted PHI, in the report a
  // HIPAA auditor reads.
  //
  // That is ADR-0335's `certifiable` defect inverted, and the inversion is the dangerous
  // direction: there an unwired adapter answered `null`, the engine read it as *no evidence*, and
  // a control was falsely false — a cost. Here a control is falsely **true**, which is not a cost
  // but the compliance failure itself. So zero scope is `scope_absent`, never satisfaction:
  // an absence of evidence is not evidence, which is this repo's fail-closed rule (an
  // unresolvable identity yields an empty result set, never an unfiltered one).
  const scopeAbsent = scopeIsAbsent(report.total);
  if (scopeAbsent) findings.unshift(ENCRYPTION_SCOPE_ABSENT_FINDING);
  const satisfied = findings.length === 0;
  return ControlEvidenceSchema.parse({
    controlId,
    sourceKind: "encryption_coverage",
    satisfied,
    summary: scopeAbsent
      ? `no at-rest column(s) declared in ${report.schema}: this control is unevidenced, not satisfied`
      : satisfied
        ? `${report.total.toString()} at-rest column(s) in ${report.schema} are ciphertext; pgcrypto installed`
        : `${report.plaintext.toString()} of ${report.total.toString()} at-rest column(s) in ${report.schema} are plaintext or pgcrypto is missing`,
    findings,
    observedAt,
    detailRef: report.schema,
  });
}

export function evidenceFromDrReadiness(
  controlId: string,
  report: DrReadinessLike,
  observedAt: string,
): ControlEvidence {
  const findings: string[] = [];
  const c = report.counts;
  // The components are gathered **before** anything is gated, because "is there anything to
  // itemize" and "is the stored total positive" are two different questions and this function used
  // to ask the second for the first. `assessDrReadiness` sums these seven into `totalIssues` from
  // one source, so on every row it writes the two agree — but a hand-edited or later-producer row
  // can carry `{totalIssues: 0, overdueDrills: 3, expiredBackups: 2}`, and gating the whole list on
  // the total surfaced neither of those two and then fired `DR_VERDICT_UNEXPLAINED_FINDING`, which
  // says the report carries no component count. The reader's own fallback contradicted the row in
  // front of it.
  const components: string[] = [];
  if (c.overdueDrills) components.push(`overdue drills: ${c.overdueDrills.toString()}`);
  if (c.staleRunbooks) components.push(`stale runbooks: ${c.staleRunbooks.toString()}`);
  if (c.expiredBackups) components.push(`expired backups: ${c.expiredBackups.toString()}`);
  if (c.unverifiedBackups)
    components.push(`unverified backups: ${c.unverifiedBackups.toString()}`);
  if (c.replicationViolations)
    components.push(`replication violations: ${c.replicationViolations.toString()}`);
  if (c.failoverBreaches)
    components.push(`failover RPO/RTO breaches: ${c.failoverBreaches.toString()}`);
  if (c.drillBreaches) components.push(`drill RPO/RTO breaches: ${c.drillBreaches.toString()}`);
  // The header restates the stored total, so it is emitted only when that total is positive — a
  // "0 DR readiness issue(s)" line would publish the disagreement as though it were a finding,
  // which is what the old `!report.ready` condition did and what driving this off the count fixed.
  // Still behaviour-preserving on every row `assessDrReadiness` wrote, where the sum is the total.
  if (c.totalIssues > 0) findings.push(`${c.totalIssues.toString()} DR readiness issue(s)`);
  findings.push(...components);
  // This is the rule `evidenceFromEncryptionCoverage` argues at length — read it there rather than
  // restating it — applied to its sibling, which was the member ADR-0337 did not fix.
  // That increment found the falsely-true control in *this file* and closed the instance it had in
  // hand, leaving the class open one function down: every count here is derived by filtering a
  // supplied list, so a deployment that recorded no backup, no drill and no runbook scored
  // `ready: true, totalIssues: 0` and this control answered `satisfied: true` with the summary
  // "DR readiness: READY (0 issues)" — DR readiness certified in a SOC 2 evidence pack over
  // nothing at all, on every deployment rather than a misconfigured one: three of the four
  // evidence axes have no durable source, and `meta.backup_records` has no writer anywhere.
  const unevidenced = report.unevidencedAxes;
  const absence =
    unevidenced === null
      ? [DR_EVIDENCE_SCOPE_UNKNOWN_FINDING]
      : unevidenced.map((axis) => drAxisUnevidencedFinding(axis));
  // A `ready: false` that neither the counts nor the axes explain would otherwise be
  // `satisfied: false` with nothing said: see `DR_VERDICT_UNEXPLAINED_FINDING`.
  if (!report.ready && findings.length === 0 && absence.length === 0) {
    findings.push(DR_VERDICT_UNEXPLAINED_FINDING);
  }
  // Unshifted so the absence is the first thing a reader of the findings meets, which is the
  // sibling's reason: a real issue beside an unevidenced axis must not bury the one fact that says
  // the control was not evaluated.
  findings.unshift(...absence);
  // **Not `report.ready`.** Satisfaction is now derived from the same sources the verdict is, so a
  // stored `ready: true` that disagrees with its own axes cannot buy it.
  const satisfied = findings.length === 0;
  return ControlEvidenceSchema.parse({
    controlId,
    sourceKind: "dr_readiness",
    summary:
      unevidenced === null
        ? "this DR readiness report predates the unevidenced-axis check and cannot say which axes carried a record: this control is unevidenced, not satisfied"
        : unevidenced.length > 0
          ? `no DR record on ${unevidenced.join(", ")}: this control is unevidenced, not satisfied`
          : satisfied
            ? "DR readiness: READY (0 issues)"
            : // Never the bare `NOT READY (0 issue(s))` pair, which is self-contradictory and is
              // exactly what a row whose total disagrees with its own components used to read. Each
              // arm says one true thing: the stored total where it is positive, the disagreement
              // where the components outrun it, and the unexplained verdict where neither exists.
              c.totalIssues > 0
              ? `DR readiness: NOT READY (${c.totalIssues.toString()} issue(s))`
              : components.length > 0
                ? `DR readiness: NOT READY (this row reports 0 total issues and disagrees with the ${components.length.toString()} component count(s) itemized in its findings)`
                : "DR readiness: NOT READY (this report itemizes no issue and names no unevidenced axis)",
    satisfied,
    findings,
    observedAt,
    detailRef: null,
  });
}

export function evidenceFromForensicChain(
  controlId: string,
  result: ForensicChainLike,
  observedAt: string,
): ControlEvidence {
  const findings: string[] = [];
  if (!result.valid) {
    const at = result.brokenAt === null ? "?" : result.brokenAt.toString();
    findings.push(
      `chain broken at sequence ${at}${result.reason ? `: ${result.reason}` : ""}`,
    );
  }
  return ControlEvidenceSchema.parse({
    controlId,
    sourceKind: "forensic_chain",
    satisfied: result.valid,
    summary: result.valid
      ? "audit hash-chain integrity verified"
      : "audit hash-chain integrity FAILED",
    findings,
    observedAt,
    detailRef: null,
  });
}

export interface AccessReviewEvidenceOptions {
  readonly minCompletionRate?: number;
  readonly requireSeal?: boolean;
}

export function evidenceFromAccessReviewEvidence(
  controlId: string,
  evidence: AccessReviewEvidenceLike,
  observedAt: string,
  options: AccessReviewEvidenceOptions = {},
): ControlEvidence {
  const minCompletion = options.minCompletionRate ?? DEFAULT_MIN_COMPLETION_RATE;
  const requireSeal = options.requireSeal ?? true;
  const findings: string[] = [];
  const sealed = SEALED_EVIDENCE_STATUSES.has(evidence.status);
  if (requireSeal && (!sealed || evidence.sealedSha256 === null)) {
    findings.push(`evidence not sealed (status=${evidence.status})`);
  }
  if (evidence.completionRate < minCompletion) {
    findings.push(
      `completion rate ${evidence.completionRate.toFixed(2)} below ${minCompletion.toFixed(2)}`,
    );
  }
  // The fourth and last member of the class `evidenceFromEncryptionCoverage` argues above — read
  // the rule there rather than restating it. This was the one adapter guarded at neither level:
  // the encryption sibling gates zero scope here, the forensic one is gated at its *source*
  // (`forensicChainSource` returns `[]` for an empty chain, whose comment says a valid-by-vacuity
  // empty log must not read as a satisfied control), and `accessReviewSource` gates only
  // `kind === "none"` — no pack at all — which is a different fact from a pack that exists, seals,
  // carries a real digest and covers nothing.
  //
  // Reachable from the shipped producer and not merely from a hand-edited row, which is what makes
  // it the sharpest of the four. There is no zero-item refusal among `compileCampaignEvidence`'s
  // six, and the repo's own test is titled "compiles an empty finished campaign at 100%
  // completion". Measured end to end through the real functions: a finished campaign with no items
  // compiles `totalItemsAcrossCampaigns: 0, completionRate: 1`, seals to a contract-valid
  // `sealed` record, and this control answered `satisfied: true` with the summary "soc2_type2
  // access review sealed at 100% completion" and an empty findings list — a SOC 2 evidence pack
  // certifying that access was reviewed, over zero reviewed items. `completionRate` was the only
  // quantitative gate and `1 < 0.95` is false, so nothing here could see the scope.
  //
  // The guard belongs in this adapter and deliberately **not** in
  // `computeCampaignEvidenceMetrics`, whose `completionRate: 1` is a division guard: changing it
  // would move every stored pack's rates and so the sealed digest computed over them
  // (ADR-0332's quantise-in-the-producer rule read the other way). The metric is right; reading it
  // as a measurement over an empty scope was wrong.
  const scopeAbsent = scopeIsAbsent(evidence.totalItemsAcrossCampaigns);
  if (scopeAbsent) findings.unshift(ACCESS_REVIEW_SCOPE_ABSENT_FINDING);
  const satisfied = findings.length === 0;
  return ControlEvidenceSchema.parse({
    controlId,
    sourceKind: "access_review_campaign",
    satisfied,
    summary: scopeAbsent
      ? `no access-review item in scope for ${evidence.framework}: this control is unevidenced, not satisfied`
      : satisfied
        ? `${evidence.framework} access review sealed at ${(evidence.completionRate * 100).toFixed(0)}% completion`
        : `${evidence.framework} access review deficient`,
    findings,
    observedAt,
    detailRef: evidence.sealedSha256,
  });
}
