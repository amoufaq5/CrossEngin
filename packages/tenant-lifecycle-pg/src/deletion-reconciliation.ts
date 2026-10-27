import {
  DEADLINE_STANDING_FACTS,
  DEFAULT_DEADLINE_WARNING_DAYS,
  assessDeadline,
  isDeadlineFinding,
  tombstoneMatchesAttestations,
  verifyTombstoneHashes,
  type DeadlineAssessment,
  type DeletionRequestStatus,
  type GdprDeletionRequest,
} from "@crossengin/tenant-lifecycle";

import type { UnreadableRow } from "@crossengin/kernel-pg";

import { isAnchoredByChain } from "./deletion-pipeline.js";
import { DeletionRequestCommittedUnreadable } from "./deletion-request-store.js";
import type {
  PostgresDeletionRequestStore,
  UnreadableRowReporter,
} from "./deletion-request-store.js";
import {
  TOMBSTONE_SCAN_MAX_LIMIT,
  type PostgresTombstoneStore,
  type StoredTombstone,
} from "./tombstone-store.js";

/**
 * Resolving a deletion request that a run left `in_progress`, from evidence rather than from a guess.
 *
 * ADR-0321 built the handle and named what it did not finish: a run that threw something other than
 * the pipeline's own refusal leaves the request `in_progress` forever, because *that process* cannot
 * know whether the deletion committed and re-running on an assumption is how a tenant gets deleted
 * twice. `dueForExecution` only looks at `verified`, so such a request is then never seen again by
 * anything, and an operator resolves it by hand in SQL.
 *
 * **The evidence settles it, and this is the whole decision.** The pipeline writes the tombstone in
 * the *same transaction* as the `DROP SCHEMA` (ADR-0319), and ADR-0321 put the request's id on the
 * tombstone as `relatedDeletionRequestId`. Therefore:
 *
 *   **a tombstone naming the request exists ⟺ that request's deletion committed.**
 *
 * So nothing here infers from the tenant's schema being absent, or from a log line, or from how long
 * ago the run was: it asks the tombstone table one question. A process that died between the commit
 * and the status write left the answer behind in the database.
 *
 * **Presence and absence are not symmetric, and that asymmetry is the second decision.** A tombstone
 * is conclusive the moment it exists, at any age — recording a deletion that demonstrably happened
 * destroys nothing. An *absence* is only an inference, because "not committed" and "not committed
 * yet" look identical: a pipeline still running right now has written no tombstone either. So
 * `never_committed` is gated behind a staleness window, is never applied automatically, and is
 * reported as a distinct verdict so a caller can see it is reasoning from silence.
 *
 * The same shape as ADR-0315's two answers to "what if we cannot tell?" — each correct for its
 * position, and deliberately not reconciled into one rule.
 */

export const RECONCILIATION_VERDICTS = [
  /** Exactly one tombstone names the request: the deletion committed. Conclusive at any age. */
  "completed_by_evidence",
  /**
   * No tombstone names it and it has been stranded longer than the window, so the transaction did
   * not commit and the tenant is untouched. An inference from absence, not evidence.
   */
  "never_committed",
  /**
   * More than one tombstone names it. The premise above is broken, so nothing is chosen — two
   * deletions of one tenant is a finding, not a row to pick from.
   */
  "ambiguous_evidence",
  /** Stranded for less than the window and no tombstone: a run may still be in flight. */
  "too_recent",
  /**
   * A tombstone names the request and does **not** stand up — its hashes disagree with its content,
   * its scope disagrees with the attestations stored beside it, or nothing in the chain witnesses it.
   * Never applied: the request's `completionSha256` is the platform's claim about a proof, and
   * copying a digest off a record that fails verification launders the defect into a second row.
   */
  "evidence_unverified",
  /** Not `in_progress` at all, so there is nothing to reconcile. */
  "not_stranded",
] as const;
export type ReconciliationVerdict = (typeof RECONCILIATION_VERDICTS)[number];

/**
 * Why a stored tombstone does not stand up.
 *
 * `scope_tampered` is the one the forensic chain **cannot** catch, and it is the reason this check
 * exists at all. The chain entry commits to the two digests and the identity, never the scope
 * (ADR-0318, deliberately — a scope can name every table a tenant held and every integrity pass
 * rereads the chain). And `proofSha256` commits to `contentManifestSha256` rather than to the scope
 * itself. So editing a stored row's `scope` column leaves `proofOk` true and the chain intact:
 * `contentManifestOk` and `tombstoneMatchesAttestations` are the only two things in the system that
 * can see it.
 */
export const EVIDENCE_DEFECTS = [
  /**
   * `contentManifestSha256` does not match what the record's own proof version says it covers.
   *
   * The name is narrower than the check and stays that way. The digest commits to the manifest as a
   * whole, so `contentManifestOk` is one boolean over everything that version signs: the scope, plus
   * whatever keys that tag added to it — `PROOF_VERSION_COVERAGE` is where that set is written down,
   * and each tag has added one (ADR-0329's capability declaration, ADR-0331's retention claim,
   * ADR-0351's record-storage declaration). It cannot say *which* key moved, so splitting this per
   * key would mean reporting a distinction nothing can make — and the count of keys is deliberately
   * not restated here, because a number in this comment goes stale on the next tag.
   */
  "scope_tampered",
  /** `proofSha256` does not match the record's own identity and manifest digest. */
  "proof_mismatch",
  /** The scope disagrees with the attestations stored beside it. */
  "scope_disagrees_with_attestations",
  /**
   * The `attestations` column holds something that is not a list of attestations, so the check
   * above could not be run at all.
   *
   * The companion to it and the easier tamper of the two. That column is `JSONB NOT NULL DEFAULT
   * '[]'` with **no CHECK that it is an array**, so `'{}'`, `'null'` and `'"x"'` are all storable —
   * and before this defect existed the mapper answered `[]` for each, every reader gated on
   * `attestations.length === 0`, and the row came back `ok` with `matchesAttestations: null`. So
   * *editing* the evidence into a lie was caught by name and *destroying* it was not, which is the
   * wrong way round: `tombstoneMatchesAttestations` is one of only two detectors for a tampered
   * scope, and this is how you turn it off.
   */
  "attestations_unreadable",
  /** No chain entry witnesses it, or the record does not commit to the one that does. */
  "unwitnessed",
] as const;
export type EvidenceDefect = (typeof EVIDENCE_DEFECTS)[number];

export interface EvidenceCheck {
  readonly ok: boolean;
  readonly defects: readonly EvidenceDefect[];
  /**
   * `null` when the row carries no attestations to compare against — "cannot say" rather than
   * "disagrees" (ADR-0318's habit). It does **not** disqualify: the hashes still establish that the
   * record is internally intact and commits to its own scope, which is what completing a *request*
   * needs. A row with no evidence beside it predates `attestations` or was not written by the
   * pipeline, and that is worth seeing without stranding the request over it.
   *
   * It stays `null` for an **unreadable** column too, and that is honest rather than a gap: nothing
   * could be compared, so there is no comparison to report. What separates the two cases is
   * `attestations_unreadable` in `defects` — the fact carries the finding, and this field carries
   * only the comparison. Reporting `false` here instead would claim a disagreement nobody
   * established.
   */
  readonly matchesAttestations: boolean | null;
}

/**
 * Whether a stored tombstone stands up well enough to close a GDPR request against it.
 *
 * Pure, and computed from the record already in hand rather than through `store.verify` — which
 * re-reads the row, so the digest written to the request could differ from the one that was checked.
 */
export function verifyStoredEvidence(stored: StoredTombstone): EvidenceCheck {
  const hashes = verifyTombstoneHashes(stored.record);
  const matchesAttestations =
    stored.attestations.length === 0
      ? null
      : tombstoneMatchesAttestations(stored.record, stored.attestations);
  const defects: EvidenceDefect[] = [];
  if (!hashes.contentManifestOk) defects.push("scope_tampered");
  if (!hashes.proofOk) defects.push("proof_mismatch");
  if (matchesAttestations === false) defects.push("scope_disagrees_with_attestations");
  // Read from the mapper's own reading and never inferred from the array being empty: `[]` is a
  // legitimate stored claim, so the length cannot tell an honest proof written with no evidence
  // from one whose evidence was destroyed. This is the gap that made the second detector above
  // switchable off — the check it would have run is skipped either way, and only this says so.
  if (stored.attestationsRead === "unreadable") defects.push("attestations_unreadable");
  // A tombstone nothing witnessed is a row, not a proof: without the chain entry anybody with write
  // access to the table could have inserted it. `isAnchoredByChain` is the stronger question than
  // "is `chain_entry_hash` set" — it also requires the record's own anchors to name that entry, so a
  // column set without the record committing to it does not pass.
  if (!isAnchoredByChain(stored)) defects.push("unwitnessed");
  return { ok: defects.length === 0, defects, matchesAttestations };
}

/**
 * Whether a stored tombstone is worth reporting, and the sentence that says why.
 *
 * **One rule, one place.** The sweep's `continue` and the targeted `verifyTombstone` have to agree
 * exactly, because the second is what a caller holds up to close an episode the first opened — a
 * targeted check that was stricter would never close anything, and one that was laxer would close an
 * episode whose finding still stands. So the condition lives here and both read it.
 *
 * A `dangling` reference is not an `EvidenceDefect`: the proof itself is intact and the row it names
 * is gone. It is reported all the same, because a request row deleted out from under a proof is the
 * one thing no other direction of the audit can see.
 */
export type TombstoneStanding =
  | { readonly ok: true; readonly detail: null }
  | { readonly ok: false; readonly detail: string };

export function tombstoneStanding(
  reference: TombstoneReferenceState,
  relatedDeletionRequestId: string | null,
  check: EvidenceCheck,
): TombstoneStanding {
  const parts: string[] = [];
  if (!check.ok) parts.push(`does not verify: ${check.defects.join(", ")}`);
  if (reference === "dangling") {
    parts.push(`names deletion request ${relatedDeletionRequestId ?? ""}, which does not exist`);
  }
  return parts.length === 0 ? { ok: true, detail: null } : { ok: false, detail: parts.join("; ") };
}

/** Verdicts whose evidence stands on its own, so applying them needs no operator judgement. */
export function isConclusive(verdict: ReconciliationVerdict): boolean {
  return verdict === "completed_by_evidence";
}

/** Verdicts a human has to look at. */
export function needsOperator(verdict: ReconciliationVerdict): boolean {
  return (
    verdict === "never_committed" ||
    verdict === "ambiguous_evidence" ||
    verdict === "evidence_unverified"
  );
}

/**
 * How long a request must have been `in_progress` before an absence of evidence is taken to mean
 * anything. Deliberately far longer than any pipeline run: the cost of waiting is a row that stays
 * visible on a list, and the cost of being wrong is a request marked `rejected` while its deletion
 * was still committing.
 */
export const DEFAULT_STRANDED_AFTER_MS = 3_600_000;

export interface ReconciliationResult {
  readonly requestId: string;
  readonly tenantId: string;
  readonly verdict: ReconciliationVerdict;
  /** The tombstone the evidence points at, when there is exactly one. */
  readonly tombstoneId: string | null;
  /** Every tombstone naming the request, so an ambiguous verdict can be investigated. */
  readonly tombstoneIds: readonly string[];
  /** The verification of the tombstone the evidence points at, when there is exactly one. */
  readonly evidence: EvidenceCheck | null;
  /** Whether the verdict was written to the request. */
  readonly applied: boolean;
  /** Whether the tenant row was retired as part of applying it. `null` when not attempted. */
  readonly tenantRetired: boolean | null;
  readonly strandedForMs: number;
  readonly detail: string | null;
}

/**
 * One request whose Article 12(3) standing a sweep reports.
 *
 * It carries the `DeadlineAssessment` rather than flattening it, which is the decision: the
 * assessment is where the standing, the deadline in force, the answer instant, the signed delta and
 * the horizon are computed once, and a finding that re-spelled any of them would be a second
 * derivation of a figure a regulator is shown. The identity is what this layer adds — the
 * assessment is a property of the record and these three are how a caller finds it.
 *
 * It replaced a `DeadlineBreach` that could carry only the one standing it was named for, and the
 * narrowness was the defect: a `completed` request's lateness was reportable and a **breach still
 * running** was not expressible at all, which is the condition `isOverdue` answers and nothing
 * asked. `completedAt` was a required field, so the type could not have held a request that had not
 * finished even if something had looked.
 *
 * Deliberately **not** an `EvidenceAudit`. That type's fields are all about whether the *proof*
 * stands up (`present`, `digestMatches`, `check`), and a late-but-verifying completion answers "fine"
 * to every one of them — so folding it in would make a finding whose every field says nothing is
 * wrong. Worse, mechanically: every `auditCompleted` finding reaches
 * `DeletionEvidenceEscalator.onAuditFinding` through the scheduler, which declares a paging **sev1**
 * for a detected tamper (ADR-0324). A deadline standing is a standing compliance fact, not a tamper,
 * and in this repository the grade *is* the route — so it would page the tamper rotation for
 * something that, for every standing but one, no page can fix. Which standing that one is is the
 * contract's `DEADLINE_STANDING_FACTS.deadlineCanStillBeMet`, and the grade is the deployment's.
 */
export interface DeadlineFinding {
  readonly requestId: string;
  readonly tenantId: string;
  /** The proof the erasure was carried out, when the request names one. */
  readonly tombstoneId: string | null;
  readonly assessment: DeadlineAssessment;
}

/**
 * What a sweep does with a request whose Article 12(3) standing is a finding.
 *
 * **Required**, on `onUnreadableRequest`'s rule and for the same measured reason, which ADR-0387
 * widened rather than invented: `isOverdue` and `daysUntilDeadline` had **zero** non-test callers in
 * the workspace and the `completed`-only predicate beside them had exactly one, so of the three
 * readings that answer for an Article 12(3) deadline two were asked by nothing. An optional reporter
 * defaulting to "drop it silently" would leave it that way for every deployment that did not opt in,
 * which is the defect restated as a default (ADR-0364's addendum, ADR-0371's `onRefused`) — and the
 * finding this would drop is a deletion request the platform is late on, or about to be.
 */
export type DeadlineFindingReporter = (finding: DeadlineFinding) => void;

/**
 * One sentence per finding, derived from the standing's **declared facts** rather than from its
 * name.
 *
 * Here because node.ts built it twice — the two `DeletionReconciler` wirings carried
 * byte-identical interpolations of one string, which is the maintained-list shape (ADR-0288) in a
 * log line — and a third caller is owed the moment a route renders one.
 *
 * It reads `breached` / `deadlineCanStillBeMet` and the two nullables, and names no standing, so a
 * seventh standing gets a sentence from the facts it is obliged to declare instead of falling
 * through to a default nobody chose.
 */
export function formatDeadlineFinding(finding: DeadlineFinding): string {
  const a = finding.assessment;
  const facts = DEADLINE_STANDING_FACTS[a.standing];
  const days = (ms: number): string => Math.round(Math.abs(ms) / 86_400_000).toString();
  const where = `request ${finding.requestId} (tenant ${finding.tenantId}, status ${a.status})`;
  const deadline = a.extendedAt === null ? a.deadlineAt : `${a.deadlineAt}, extended ${a.extendedAt}`;
  if (a.msPastDeadline === null) {
    return `${where} is ${a.status} and its record does not state when the data subject was answered; deadline ${deadline}`;
  }
  if (facts.breached) {
    return a.answeredAt === null
      ? `${where} is ${days(a.msPastDeadline)}d past its Article 12(3) deadline and still unanswered; deadline ${deadline}`
      : `${where} answered the data subject ${days(a.msPastDeadline)}d past its Article 12(3) deadline (${deadline} -> ${a.answeredAt}); tombstone ${finding.tombstoneId ?? "(none)"}`;
  }
  if (facts.deadlineCanStillBeMet) {
    return `${where} is due in ${days(a.msPastDeadline)}d and its Article 12(3) deadline can still be met; deadline ${deadline}`;
  }
  // Neither a breach nor meetable, so the deadline was met. `reported` is false for both standings
  // that land here, which is why this arm is reachable only from a direct call — and it still has to
  // be right for both, because "is within" is false of a request that has already been answered.
  return a.answeredAt === null
    ? `${where} is within its Article 12(3) deadline; deadline ${deadline}`
    : `${where} answered the data subject within its Article 12(3) deadline; deadline ${deadline}`;
}

/**
 * Appends a note to a verdict's detail, keeping `null` for "nothing to say".
 *
 * `null` rather than an empty string on both sides, because `ReconciliationResult.detail` is
 * `string | null` and an empty string there would read as a detail that exists and says nothing.
 */
function withNote(detail: string | null, note: string | null): string | null {
  if (note === null) return detail;
  return detail === null ? note : `${detail}; ${note}`;
}

export interface ReconcilerOptions {
  readonly requests: PostgresDeletionRequestStore;
  readonly tombstones: PostgresTombstoneStore;
  /**
   * Retires the tenant row. Optional: a run that died after the commit may also have died before
   * retiring the row, and reconciliation is the only thing that will ever notice.
   */
  readonly retire?: (tenantId: string) => Promise<boolean>;
  /**
   * What to do with a request row the contract cannot represent.
   *
   * **Required**, and this is the surface the requirement matters most on. Both sweeps here read a
   * page and walk it, so one refused row used to throw out of the store's own `.map()` and stop
   * every *other* row being examined — `auditCompleted` returning nothing was then
   * indistinguishable from `auditCompleted` finding nothing, which is the whole claim this class
   * exists to make. An unreadable row is itself a finding of the same family: a completed Article 17
   * erasure whose request record has stopped being readable.
   *
   * Not folded into the returned findings, because `EvidenceAudit` and `ReconciliationResult` both
   * require a `requestId` and a `tenantId` and a row the contract refused supplies neither
   * trustworthily — ADR-0371's `onRefused` shape, for its reason.
   */
  readonly onUnreadableRequest: UnreadableRowReporter;
  /**
   * What to do with a request whose Article 12(3) standing is a finding.
   *
   * One reporter for both passes. `auditCompleted` emits it for a late *completion* from a walk that
   * is already iterating exactly the completed requests — so that fact costs no second page read and
   * the two pages cannot disagree about which requests were examined — and `auditDeadlines` emits it
   * for everything else: a request still waiting past its deadline, one approaching it, a refusal
   * recorded late, and a terminal record that does not state when it answered.
   *
   * Two reporters for one fact family was the alternative and is refused for the reason this whole
   * surface keeps finding: a deployment would wire one and not the other, and the half it wired
   * would read as coverage. The two passes are disjoint by **status** — `auditCompleted` owns
   * `completed` and `auditDeadlines` owns the other five — which is a property of the queries rather
   * than of a filter either applies, so no finding is emitted twice.
   *
   * Deliberately not emitted from `DeletionRunner` at the moment of completion as well: that would
   * be a second producer of one fact, and the sweeps cover every request including the one just
   * written.
   */
  readonly onDeadlineFinding: DeadlineFindingReporter;
  readonly strandedAfterMs?: number;
  /**
   * How many days before its deadline a waiting request is reported as `approaching`.
   *
   * Optional with `DEFAULT_DEADLINE_WARNING_DAYS`, which is `strandedAfterMs`' treatment one field
   * over and is the right shape here for the same reason: the horizon's failure mode is reporting
   * too early or too late, never reporting *nothing*, so a default cannot make the sweep silent. It
   * is **required** on `assessDeadline` itself, where a default would put the judgement inside the
   * computation with nobody having chosen it, and every finding carries the value it was assessed
   * under so `approaching` is legible without the deployment's configuration in hand.
   */
  readonly deadlineWarningDays?: number;
  readonly clock?: () => Date;
  readonly onReconciled?: (result: ReconciliationResult) => void;
}

/**
 * Reads the evidence for stranded requests and, where it is conclusive, records it.
 *
 * `applyNeverCommitted` is the one thing a caller may authorise that the evidence does not: marking a
 * request `rejected` because no tombstone names it. It is off by default and belongs to an operator
 * looking at the row, never to a scheduler.
 */
export class DeletionReconciler {
  private readonly opts: ReconcilerOptions;

  constructor(opts: ReconcilerOptions) {
    this.opts = opts;
  }

  private now(): Date {
    return (this.opts.clock ?? ((): Date => new Date()))();
  }

  private window(): number {
    return this.opts.strandedAfterMs ?? DEFAULT_STRANDED_AFTER_MS;
  }

  private warningDays(): number {
    return this.opts.deadlineWarningDays ?? DEFAULT_DEADLINE_WARNING_DAYS;
  }

  /**
   * Assesses one request, emits the finding if its standing is one, and hands the same finding back.
   *
   * The one place the reporting rule lives, so the two passes cannot disagree about which standings
   * reach a caller: both call this and neither tests a standing by name. `isDeadlineFinding` reads
   * `DEADLINE_STANDING_FACTS`, so a seventh standing is reported or not by what it declares rather
   * than by whichever branch an `if`-chain here ended on.
   *
   * It **returns** the finding rather than letting `auditDeadlines` re-ask, so the returned page and
   * what the reporter saw are the same set by construction. Two readings of the standing — one to
   * emit, one to collect — is how a page comes to disagree with the log it was supposed to mirror.
   */
  private reportDeadline(request: GdprDeletionRequest): DeadlineFinding | null {
    const assessment = assessDeadline(request, {
      now: this.now(),
      warningDays: this.warningDays(),
    });
    if (!isDeadlineFinding(assessment.standing)) return null;
    const finding: DeadlineFinding = {
      requestId: request.id,
      tenantId: request.tenantId,
      tombstoneId: request.tombstoneId,
      assessment,
    };
    this.opts.onDeadlineFinding(finding);
    return finding;
  }

  /** The verdict alone, writing nothing. */
  async assess(request: GdprDeletionRequest): Promise<ReconciliationResult> {
    return this.assessWith(request, await this.evidenceFor(request));
  }

  private async evidenceFor(request: GdprDeletionRequest): Promise<readonly StoredTombstone[]> {
    return request.status === "in_progress"
      ? this.opts.tombstones.findForRequest(request.id)
      : [];
  }

  private assessWith(
    request: GdprDeletionRequest,
    found: readonly StoredTombstone[],
  ): ReconciliationResult {
    const base = {
      requestId: request.id,
      tenantId: request.tenantId,
      evidence: null,
      applied: false,
      tenantRetired: null,
    };
    const strandedForMs =
      request.inProgressAt === null
        ? 0
        : Math.max(0, this.now().getTime() - new Date(request.inProgressAt).getTime());

    if (request.status !== "in_progress") {
      return {
        ...base,
        verdict: "not_stranded",
        tombstoneId: null,
        tombstoneIds: [],
        strandedForMs,
        detail: `status is ${request.status}`,
      };
    }

    const ids = found.map((t) => t.record.id);

    if (found.length > 1) {
      return {
        ...base,
        verdict: "ambiguous_evidence",
        tombstoneId: null,
        tombstoneIds: ids,
        strandedForMs,
        detail: `${found.length.toString()} tombstones name this request`,
      };
    }
    const only = found[0];
    if (only !== undefined) {
      const check = verifyStoredEvidence(only);
      if (!check.ok) {
        // The deletion did commit — the row is here — but this record cannot be used to close the
        // request, because the request's `completionSha256` is the platform's claim about a proof.
        // Reported, never applied: a human has a tampered or unwitnessed tombstone to deal with, and
        // that is a bigger problem than a request stuck `in_progress`.
        return {
          ...base,
          verdict: "evidence_unverified",
          evidence: check,
          tombstoneId: only.record.id,
          tombstoneIds: ids,
          strandedForMs,
          detail: `tombstone ${only.record.id} does not verify: ${check.defects.join(", ")}`,
        };
      }
      // Conclusive, and conclusive immediately: the tombstone and the drop committed together, so its
      // existence is not a hint about what probably happened.
      return {
        ...base,
        verdict: "completed_by_evidence",
        evidence: check,
        tombstoneId: only.record.id,
        tombstoneIds: ids,
        strandedForMs,
        detail: null,
      };
    }
    if (strandedForMs < this.window()) {
      return {
        ...base,
        verdict: "too_recent",
        tombstoneId: null,
        tombstoneIds: [],
        strandedForMs,
        detail: `stranded for ${strandedForMs.toString()}ms; the window is ${this.window().toString()}ms`,
      };
    }
    return {
      ...base,
      verdict: "never_committed",
      tombstoneId: null,
      tombstoneIds: [],
      strandedForMs,
      detail: "no tombstone names this request, so its transaction did not commit",
    };
  }

  /**
   * Assesses one request and writes the verdict where it may.
   *
   * `completed_by_evidence` is applied whatever the caller asked, because it is a record of something
   * that already happened and withholding it leaves a deleted tenant's request reading `in_progress`.
   */
  async reconcileOne(
    request: GdprDeletionRequest,
    opts: { readonly applyNeverCommitted?: boolean } = {},
  ): Promise<ReconciliationResult> {
    const found = await this.evidenceFor(request);
    const assessed = this.assessWith(request, found);
    const only = found[0];
    if (assessed.verdict === "completed_by_evidence" && only !== undefined) {
      return this.report(await this.applyCompleted(request, assessed, only));
    }
    if (assessed.verdict === "never_committed" && opts.applyNeverCommitted === true) {
      const note = await this.applyStatus(request.id, "rejected", {
        at: this.now().toISOString(),
        rejectedReason: `reconciled: ${assessed.detail ?? "no tombstone"}`.slice(0, 500),
      });
      return this.report({ ...assessed, applied: true, detail: withNote(assessed.detail, note) });
    }
    return this.report(assessed);
  }

  /**
   * One status write, with the committed-but-unreadable case lifted out — `DeletionRunner.move`'s
   * shape, in the other class that writes these rows.
   *
   * The two `transition` calls here were as unguarded as the runner's three, and this one is the
   * worse pair. `transition` raises `DeletionRequestCommittedUnreadable` for every `to`, so:
   *
   *   - out of `applyCompleted` the throw escaped `reconcileOne` and `reconcileStranded`, **dropping
   *     the rest of the stranded page** — the same "one bad row takes the page" shape the list read
   *     was fixed for — and it escaped *between* the committed `completed` write and
   *     `retireQuietly`, so the repair happened, the tenant row was never retired, nothing recorded
   *     that the request had been resolved, and the next sweep could not see it either, because
   *     `stranded` walks `in_progress` and the row now reads `completed`. A repair that ran and left
   *     no trace of having run.
   *   - out of the `never_committed` arm the same, for an operator-authorised act.
   *
   * It returns the **note** rather than a verdict, because the verdict is already settled by the
   * evidence and the write committing does not change it: `applied` is `true` either way, which is
   * the fact the row establishes. So the condition lands in `detail`, which is where this type
   * carries everything an operator has to read and act on.
   */
  private async applyStatus(
    requestId: string,
    to: DeletionRequestStatus,
    fields: {
      readonly at: string;
      readonly tombstoneId?: string;
      readonly completionSha256?: string;
      readonly rejectedReason?: string;
    },
  ): Promise<string | null> {
    try {
      await this.opts.requests.transition(requestId, to, fields);
      return null;
    } catch (err) {
      if (!(err instanceof DeletionRequestCommittedUnreadable)) throw err;
      return (
        `recorded '${err.committedStatus}'; the request row cannot be read back: ${err.parseMessage}`
      );
    }
  }

  private async applyCompleted(
    request: GdprDeletionRequest,
    assessed: ReconciliationResult,
    evidence: StoredTombstone,
  ): Promise<ReconciliationResult> {
    const note = await this.applyStatus(request.id, "completed", {
      at: this.now().toISOString(),
      // Both off the tombstone itself, never recomputed: the digest a completed request commits to
      // has to be the one the stored proof carries, or the join ADR-0321 added is a lie.
      tombstoneId: evidence.record.id,
      completionSha256: evidence.record.proofSha256,
    });
    // A run that died after the commit may also have died before retiring the row, and nothing else
    // will ever notice — the deletion is not in any queue any more. It runs whether or not the
    // status write's row could be read back, and that ordering is the whole of why `applyStatus`
    // returns a note instead of throwing: the `completed` write committed, so the retire is still
    // owed, and the throw used to land exactly between the two.
    const retired = this.opts.retire === undefined ? null : await this.retireQuietly(request.tenantId);
    return {
      ...assessed,
      applied: true,
      tenantRetired: retired,
      detail: withNote(assessed.detail, note),
    };
  }

  private async retireQuietly(tenantId: string): Promise<boolean | null> {
    try {
      return (await this.opts.retire?.(tenantId)) ?? null;
    } catch {
      // The request is already recorded `completed` against a real tombstone; failing the whole
      // reconciliation over the row's status would undo the part that was worth doing.
      return null;
    }
  }

  /**
   * Reconciles every `in_progress` request. Conclusive verdicts only.
   *
   * Deliberately **not** filtered to the staleness window: the window governs the *inference from
   * absence*, not the listing. A request whose pipeline committed and whose status write then failed
   * is conclusive immediately, and that is the case worth fixing promptly — ADR-0321's
   * `completed_unrecorded`. A request still being worked right now appears here too and comes back
   * `too_recent`, which writes nothing.
   */
  async reconcileStranded(limit = 25): Promise<readonly ReconciliationResult[]> {
    const stranded = await this.opts.requests.stranded(
      this.now().toISOString(),
      this.opts.onUnreadableRequest,
      limit,
    );
    const results: ReconciliationResult[] = [];
    for (const request of stranded) {
      results.push(await this.reconcileOne(request));
    }
    return results;
  }

  /**
   * The other direction: `completed` requests whose proof no longer stands up.
   *
   * ADR-0322 closed the stranded case and left this one open — a request completed against a
   * tombstone that has since been deleted or edited was found by nothing, because reconciliation only
   * ever looked at `in_progress`. A completed request is the platform's standing claim that an
   * Article 17 erasure was carried out and can be evidenced; this is the audit of that claim.
   *
   * Returns **only** the findings. A listing of every completed request grows without bound and says
   * nothing; "which completed deletions can no longer be proven" is a page an operator can act on.
   *
   * A row the contract cannot represent goes to `onUnreadableRequest` and the walk continues, where
   * before it threw out of the store's `.map()` and ended the audit. That mattered more than one lost
   * row: this method's answer is *the absence of findings*, so a throw and a clean audit were the
   * same observation — a claim of "every completed deletion still verifies" that nothing had checked.
   *
   * A request whose Article 12(3) standing is a finding goes to `onDeadlineFinding` and is not an
   * `EvidenceAudit`, because the two questions are independent and only one of them is about the
   * proof: a completion can be late and perfectly evidenced. This pass owns `completed` and
   * `auditDeadlines` owns the other five statuses, which is what keeps one shared reporter from
   * seeing a request twice — a property of the two queries rather than of a filter either applies.
   */
  async auditCompleted(limit = 100): Promise<readonly EvidenceAudit[]> {
    const completed = await this.opts.requests.completedWithTombstone(
      this.opts.onUnreadableRequest,
      limit,
    );
    const findings: EvidenceAudit[] = [];
    for (const request of completed) {
      const named = request.tombstoneId;
      // **First in the loop body**, so no later `continue` can skip it — and the last of them is
      // taken by every healthy request, which is the ordinary late completion. A deadline standing
      // is independent of whether the proof stands up: a completion can be late and perfectly
      // evidenced, and that case is the one the reading exists for.
      //
      // Through `reportDeadline`, which is the one emission rule both passes read. This site used
      // to emit from a `completed`-only predicate (ADR-0372's `isCompletedLate`, deleted by
      // ADR-0387 once it had become `status === "completed" && answeredAfterDeadline(…) === true`)
      // while `auditDeadlines` emitted from `isDeadlineFinding` — two rules for one reporter, which
      // is how two halves of one fact family come to disagree about one row.
      this.reportDeadline(request);
      if (named === null) continue; // The contract forbids it; the store would have refused the row.
      const stored = await this.opts.tombstones.read(named);
      if (stored === null) {
        findings.push({
          requestId: request.id,
          tenantId: request.tenantId,
          tombstoneId: named,
          present: false,
          digestMatches: false,
          check: null,
          detail: "the tombstone this request was completed against no longer exists",
        });
        continue;
      }
      const check = verifyStoredEvidence(stored);
      // A third question the stranded path never has to ask: the request carries its own copy of the
      // digest, so the two can disagree even when both records are internally intact.
      const digestMatches = request.completionSha256 === stored.record.proofSha256;
      if (check.ok && digestMatches) continue;
      findings.push({
        requestId: request.id,
        tenantId: request.tenantId,
        tombstoneId: named,
        present: true,
        digestMatches,
        check,
        detail: digestMatches
          ? `tombstone does not verify: ${check.defects.join(", ")}`
          : "the request's completionSha256 does not match the tombstone's proof",
      });
    }
    return findings;
  }

  /**
   * The Article 12(3) pass: every request the data subject is still waiting on, and every refusal
   * recorded late.
   *
   * **This is the direction nothing had.** The three existing ones all start from a request the
   * platform has already acted on — `reconcileStranded` walks `in_progress`, `auditCompleted` walks
   * `completed`, `auditTombstones` starts from the proofs — so a request sitting `submitted` because
   * nobody verified it, or `verified` because no runner claimed it, was examined by nothing at all
   * while its one-month deadline ran. `submitted` and `deferred` were read by **no query in the
   * workspace**, and `isOverdue` — the predicate that answers for exactly this — had **zero**
   * non-test callers.
   *
   * **Findings only, and it writes nothing.** A deadline is not a repair: the act that cures an
   * approaching one is verifying or running the request, which is the runner's and an operator's,
   * and nothing cures a breach at all. ADR-0323's rule, one subject over.
   *
   * Two reads because the two predicates are different in kind — the waiting set is compared against
   * the **clock** and the late refusals against a second **stored** column — and each page is
   * ordered for what it is: nearest deadline first, so a cut page drops the requests furthest from
   * their deadline before it drops a breach, and newest refusal first. `complete` says whether
   * either page was cut (ADR-0367's `declares` arm: a bounded reading that says how far it looked is
   * honest where silence is not).
   *
   * `examined` is what this pass **assessed**, never what it hoped to: a row the contract refused was
   * read and not assessed, so it goes to `onUnreadableRequest` and sits outside this figure, which is
   * `auditTombstones`' rule for the same count.
   */
  async auditDeadlines(limit = DEFAULT_DEADLINE_AUDIT_LIMIT): Promise<DeadlineAuditPage> {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    const waiting = await this.opts.requests.unanswered(this.opts.onUnreadableRequest, bounded);
    const lateRefusals = await this.opts.requests.rejectedAfterDeadline(
      this.opts.onUnreadableRequest,
      bounded,
    );
    const findings: DeadlineFinding[] = [];
    for (const request of [...waiting, ...lateRefusals]) {
      const finding = this.reportDeadline(request);
      if (finding !== null) findings.push(finding);
    }
    return {
      examined: waiting.length + lateRefusals.length,
      complete: waiting.length < bounded && lateRefusals.length < bounded,
      findings,
      warningDays: this.warningDays(),
    };
  }

  /**
   * The third direction: every tombstone, whether or not anything names it.
   *
   * Both other directions start from a *request* — `reconcileStranded` walks `in_progress` ones and
   * `auditCompleted` walks `completed` ones — so a tombstone written by the synchronous deletion
   * route of ADR-0320 is examined by neither, because it has no request at all. That is not a small
   * gap: `verifyStoredEvidence` is the **only** detector for a tampered `scope`, since `proofSha256`
   * commits to `contentManifestSha256` and the chain entry commits to the two digests and the
   * identity — **neither commits to the scope** (ADR-0323). For these tombstones nothing looked.
   *
   * **Findings only, and this one writes nothing at all.** ADR-0323 established that
   * `evidence_unverified` is a verdict nothing may apply — not a scheduler and not an operator —
   * because `acceptNeverCommitted` authorises an inference from an *absence* of evidence and says
   * nothing about a record that lies. A sweep that found a tampered scope has even less standing
   * than that: it starts from no request, so there is nothing whose status it could be right about,
   * and the only honest act is to report the row.
   */
  async auditTombstones(
    input: { readonly limit?: number; readonly afterTombstoneId?: string | null } = {},
  ): Promise<TombstoneAuditPage> {
    // Clamped to the store's own cap, not merely floored: asking for more than the store will serve
    // yields a short page, and a short page is how this reports the end of the table.
    const limit = Math.max(
      1,
      Math.min(TOMBSTONE_SCAN_MAX_LIMIT, Math.trunc(input.limit ?? DEFAULT_TOMBSTONE_AUDIT_LIMIT)),
    );
    const page = await this.opts.tombstones.scanAll({
      limit,
      afterTombstoneId: input.afterTombstoneId ?? null,
    });
    const findings: TombstoneAudit[] = [];
    for (const stored of page.records) {
      const named = stored.record.relatedDeletionRequestId ?? null;
      const reference = await this.referenceStateOf(named);
      const check = verifyStoredEvidence(stored);
      // Every defect is reported, **including** on a tombstone a request names, rather than leaving
      // the referenced ones to `auditCompleted`. Suppressing them would be wrong twice over: that
      // direction walks only `status = 'completed'` requests under its own limit, so a tombstone
      // whose request sits `in_progress`, `rejected` or `deferred` would fall through both; and it
      // would make this sweep's coverage depend on another sweep's filter. A duplicate finding is
      // noise a caller can drop on the tombstone id — a missed one is not recoverable at all.
      const standing = tombstoneStanding(reference, named, check);
      if (standing.ok) continue;
      findings.push({
        tombstoneId: stored.record.id,
        tenantId: stored.record.tenantId,
        reference,
        relatedDeletionRequestId: named,
        check,
        detail: standing.detail,
      });
    }
    return {
      // What this call actually **verified**, never what it hoped to nor what it read: "we examined
      // 4,000 and found nothing" is a claim an auditor can be given, and it cannot be made from the
      // absence of a log line (ADR-0323). A row the contract refused was read and not verified, so
      // it is beside this figure rather than inside it — `checked: 2` next to one refusal says what
      // happened where `3` would claim an examination that did not occur (ADR-0371).
      examined: page.records.length,
      findings,
      // A refused row is a finding of its own, and it cannot be a `TombstoneAudit`: that shape
      // carries a `verifyStoredEvidence` result and a reference state, and neither can be computed
      // for a row nobody could represent. Reporting `unverified` for it would claim an examination;
      // reporting nothing would make a sweep whose only purpose is finding defective proofs go
      // quiet on the one row it found something wrong with.
      unreadable: page.unreadable,
      // Over every row the page held, readable or not. A page shorter than the limit is the end of
      // the table, not a boundary — and the cursor comes from the store, because the last row of a
      // page may be the refused one and the records then do not reach it.
      nextAfterTombstoneId:
        page.rowsRead < limit ? null : page.lastTombstoneId,
    };
  }

  /**
   * How a tombstone is reached. At most one lookup, and none for an unreferenced one — the majority
   * case the sweep exists for.
   */
  private async referenceStateOf(
    relatedDeletionRequestId: string | null,
  ): Promise<TombstoneReferenceState> {
    if (relatedDeletionRequestId === null) return "unreferenced";
    return (await this.opts.requests.read(relatedDeletionRequestId)) === null
      ? "dangling"
      : "referenced";
  }

  /**
   * One tombstone, asked about by id: does it exist, does it stand up **now**, and how is it reached.
   *
   * The sweep cannot answer this. It covers one page per tick and laps, so a page that came back
   * clean says nothing about any particular row — the row may simply not have been on it. That is why
   * ADR-0328 left `onTombstoneResolved` without a caller: closing an escalated episode needs evidence
   * about *that* tombstone, and the only thing a clean page establishes is a count.
   *
   * **What a caller is entitled to conclude.** On `verified`: this row exists and the sweep would
   * report nothing for it, so an episode opened against this tombstone may be closed — this is the
   * proof `onTombstoneResolved` asks for. On `unverified`: the finding still stands, with `check` and
   * `reference` saying which of the two reasons it is. On `absent`: **nothing may be closed**. A
   * tombstone that is gone is not a tombstone that verifies; it is the Article 17 proof itself having
   * been deleted, which is a worse fact than a tampered scope and the one a naive "it no longer
   * appears in the findings" check would read as recovery.
   *
   * A caller is **not** entitled to conclude anything about the tenant's data from any of the three:
   * this reads the proof, not what the proof is about.
   *
   * Writes nothing, like its sibling. ADR-0323's rule is that `evidence_unverified` is a verdict
   * nothing may apply; a lookup by id has even less standing than a sweep, because a caller chose the
   * row.
   */
  async verifyTombstone(tombstoneId: string): Promise<TombstoneVerification> {
    const stored = await this.opts.tombstones.read(tombstoneId);
    if (stored === null) {
      return {
        tombstoneId,
        outcome: "absent",
        tenantId: null,
        reference: null,
        relatedDeletionRequestId: null,
        check: null,
        detail: "no tombstone with this id is stored",
      };
    }
    const named = stored.record.relatedDeletionRequestId ?? null;
    const reference = await this.referenceStateOf(named);
    const check = verifyStoredEvidence(stored);
    const standing = tombstoneStanding(reference, named, check);
    return {
      tombstoneId: stored.record.id,
      outcome: standing.ok ? "verified" : "unverified",
      tenantId: stored.record.tenantId,
      reference,
      relatedDeletionRequestId: named,
      check,
      detail: standing.detail,
    };
  }

  private report(result: ReconciliationResult): ReconciliationResult {
    this.opts.onReconciled?.(result);
    return result;
  }
}

/** One finding from `auditCompleted`: a completed request whose proof no longer stands up. */
export interface EvidenceAudit {
  readonly requestId: string;
  readonly tenantId: string;
  readonly tombstoneId: string;
  readonly present: boolean;
  readonly digestMatches: boolean;
  /** `null` when the tombstone is gone, so there was nothing to check. */
  readonly check: EvidenceCheck | null;
  readonly detail: string;
}

/**
 * How a tombstone is reached, which is an operational fact distinct from whether it verifies.
 *
 * The three are genuinely different problems and collapsing them would lose the one this direction
 * was built for: `unreferenced` is a tombstone **no other audit can see**, and `dangling` is a
 * request row deleted out from under a proof — not the same thing as never having had one.
 */
export const TOMBSTONE_REFERENCE_STATES = [
  /** No `relatedDeletionRequestId`: every tombstone the synchronous deletion route writes. */
  "unreferenced",
  /** Names a deletion request that exists. */
  "referenced",
  /** Names a deletion request that is not there. */
  "dangling",
] as const;
export type TombstoneReferenceState = (typeof TOMBSTONE_REFERENCE_STATES)[number];

/** How many tombstones one `auditTombstones` page verifies when the caller does not say. */
export const DEFAULT_TOMBSTONE_AUDIT_LIMIT = 100;

/** How many requests one `auditDeadlines` pass assesses **per read** when the caller does not say. */
export const DEFAULT_DEADLINE_AUDIT_LIMIT = 100;

/**
 * One `auditDeadlines` pass: what it assessed, what it found, and how far it looked.
 *
 * `examined` without `complete` would be the claim ADR-0367 refuses — a figure that reads as a
 * census while being a prefix — and `complete` without `examined` would be "nothing was found" with
 * no denominator (ADR-0323). The pair is the honest reading, and `warningDays` is the third
 * ingredient because `approaching` means nothing without the horizon it was measured against.
 */
export interface DeadlineAuditPage {
  /** How many requests this pass **assessed**. A row the contract refused is not among them. */
  readonly examined: number;
  /**
   * `false` when either read filled its limit, so the pass is a bounded reading of the queue.
   *
   * The waiting read is ordered nearest-deadline-first, so a cut page drops the requests *furthest*
   * from their deadline and loses a breach only when there are more breaches than the limit. That is
   * a property of the ordering and not a reason to call a cut page complete.
   */
  readonly complete: boolean;
  readonly findings: readonly DeadlineFinding[];
  /** The horizon this pass used, so `approaching` is legible without the deployment's config. */
  readonly warningDays: number;
}

/** One finding from `auditTombstones`: a stored tombstone that does not stand up on its own terms. */
export interface TombstoneAudit {
  readonly tombstoneId: string;
  readonly tenantId: string;
  readonly reference: TombstoneReferenceState;
  readonly relatedDeletionRequestId: string | null;
  /** Always present: unlike `auditCompleted`, this direction starts from the record itself. */
  readonly check: EvidenceCheck;
  readonly detail: string;
}

export interface TombstoneAuditPage {
  /**
   * How many tombstones this page verified. The findings alone cannot say it, and "nothing was
   * found" is only a claim if the number of records looked at comes with it.
   */
  readonly examined: number;
  readonly findings: readonly TombstoneAudit[];
  /**
   * Rows the store could not represent — read, not verified, and not expressible as a
   * `TombstoneAudit` because that shape needs a `verifyStoredEvidence` result this row cannot have.
   *
   * Its own axis for the reason `AuditAnchorReport.unreadable` is: a page that is clean on the
   * findings and non-empty here is a page that found nothing **in what it could read**, which is a
   * different claim from a clean sweep and the one an auditor has to be given.
   */
  readonly unreadable: readonly UnreadableRow[];
  /** The cursor for the next page, or `null` when the sweep reached the end of the table. */
  readonly nextAfterTombstoneId: string | null;
}

/**
 * What `verifyTombstone` can answer. Three outcomes, not two, and the third is the point.
 *
 * `absent` is a fact of its own: a proof that has been deleted is neither verified nor unverified,
 * and folding it into either would let a caller close an episode because the row it was about is no
 * longer there to fail. A row that cannot be found is the strongest finding this module has.
 */
export const TOMBSTONE_VERIFICATION_OUTCOMES = [
  /** No row holds this id. Closes nothing; the proof is gone. */
  "absent",
  /** Stored, and the sweep would report nothing for it. The only outcome that closes an episode. */
  "verified",
  /** Stored, and the sweep's finding still stands — see `check` and `reference` for which. */
  "unverified",
] as const;
export type TombstoneVerificationOutcome = (typeof TOMBSTONE_VERIFICATION_OUTCOMES)[number];

/** One targeted verification. `tenantId`, `reference` and `check` are null exactly when `absent`. */
export interface TombstoneVerification {
  /** The id asked about, which is the record's own id whenever one was found. */
  readonly tombstoneId: string;
  readonly outcome: TombstoneVerificationOutcome;
  readonly tenantId: string | null;
  /**
   * Carried rather than left for the caller to work out, because an episode's key depends on it
   * (ADR-0328): a referenced tombstone's episode is keyed on the **request** and an unreferenced
   * one's on the tombstone, so a caller that guessed would close the wrong episode or none.
   */
  readonly reference: TombstoneReferenceState | null;
  readonly relatedDeletionRequestId: string | null;
  readonly check: EvidenceCheck | null;
  /** Null exactly when `verified` — there is nothing to say about a row that stands up. */
  readonly detail: string | null;
}

/** Re-exported so a caller need not reach into the tombstone module for the one type it reads. */
export type { StoredTombstone };
