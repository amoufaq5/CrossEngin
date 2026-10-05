import { randomUUID } from "node:crypto";

import {
  SEVERITIES,
  autoDeclaredForKey,
  type IncidentRecord,
  type Severity,
} from "@crossengin/incident-response";
import {
  closeOutClosesAlert,
  type IncidentCloseOut,
  type IncidentDeclarationRequest,
  type IncidentDeclarer,
} from "@crossengin/incident-response-runtime";
import { planPageDirective, type PageDirective } from "@crossengin/observability-runtime";

import { auditActor, auditEntry, type PostgresAuditEmitter } from "./audit-log-store.js";
import type { DeletionEscalationConfig } from "./deletion-escalation-config.js";

/**
 * Declaring an incident for a deletion proof that does not stand up.
 *
 * ADR-0323 found the gap and left closing it as its first open question: `evidence_unverified` and
 * `ambiguous_evidence` are the two findings the forensic chain is **structurally unable** to raise,
 * because nothing in the chain commits to a tombstone's scope — so `--integrity-proof-config` reports
 * an intact chain over a tampered erasure record. The reconciler catches it and refuses to use it, and
 * until now that was the end of the matter: a line in a log and a row on two routes.
 *
 * A finding the chain cannot raise is exactly the finding that needs an incident, because nothing
 * else will ever notice it.
 *
 * Three rules shape this.
 *
 * **One incident per episode, keyed on the request.** The scheduler re-examines a stranded request
 * every tick — every three seconds in the live verification — so a declaration per pass would be
 * hundreds of incidents for one tampered row. `findOpen(deletionEvidenceKey(requestId))` asks the
 * store what this request already has open before declaring, which is ADR-0294's rule and survives a
 * restart because the answer is a row rather than a memory.
 *
 * **No fallback declarer, unlike the integrity escalator.** ADR-0304 gave that one an unpersisted
 * record so a one-shot compromise finding still pages when the store is unreachable. This finding is
 * *not* one-shot: the next scheduler tick re-derives it from the same two rows, so a failed
 * declaration is retried rather than lost, and an id minted in-process would risk colliding with a
 * stored one for no gain. That is ADR-0293's reasoning for the SLO loop, and it applies here for the
 * same reason.
 *
 * **A recovery closes the incident out.** An evidence finding is not permanent: ADR-0323 verified
 * live that restoring a tampered scope let the next tick complete the request. So a verdict that
 * resolves the finding closes out whatever this request has open — cancelled, or left alone if a
 * human has triaged it, which is the declarer's rule and not a shortcut here.
 *
 * **The grade comes from the defects.** ADR-0324 shipped every finding as `sev1` and named that as
 * its own first open question: an `unwitnessed` tombstone can plausibly be a row written outside
 * the pipeline, while a rewritten scope cannot be anything but a tamper, and grading them alike was
 * dishonest about the difference. `severityForDefects` grades per defect, highest wins, and the one
 * value it returns is used for both the declaration and the page — see `escalate`.
 *
 * **And the escalation itself leaves an anchored row.** `IntegrityEscalator` has written its
 * escalation to `meta.audit_log` since ADR-0288, so the record of the escalation is committed to the
 * forensic chain; this one declared and paged in silence, which ADR-0324 also left open. The row now
 * carries the incident id, the grade, the defects and the verdict — the evidence of *why* a `sev1`
 * was declared, which the incident record alone does not hold.
 *
 * **One episode per evidence record, whichever handle names it** (ADR-0328). ADR-0327's tombstone
 * sweep starts from the *proofs* rather than from a request, and found a real tampered row on its
 * first live pass — but its findings were reported and not escalated, because the episode key above
 * is the request and the findings that matter most have no request to key on. Keying every tombstone
 * finding on the tombstone would have been wrong in the other direction: a tampered tombstone that
 * *is* referenced is reachable from `auditCompleted` too, and the two paths would then declare twice
 * for one fact. So the key follows the **evidence record**, not the path that found it: a finding
 * whose tombstone names a live request escalates under that request's key and is adopted by (or
 * adopts) whatever the request paths already declared, and only a finding with no live request of
 * its own gets a `tombstone:`-namespaced key. The prefix is what makes the two spaces disjoint —
 * a bare id in one namespace could collide with an id in the other.
 */

/** The verdicts that warrant an incident. */
export const ESCALATING_VERDICTS = ["evidence_unverified", "ambiguous_evidence"] as const;

/**
 * The verdicts that mean a previously-declared finding is resolved.
 *
 * `never_committed` is **not** here on purpose. A request that escalated as `evidence_unverified` had
 * a tombstone; reading `never_committed` later means that tombstone has since *vanished*, which is
 * worse than what was declared, not better. The incident stays open.
 */
export const RESOLVING_VERDICTS = ["completed_by_evidence", "not_stranded"] as const;

export const DELETION_EVIDENCE_SIGNAL = "deletion_evidence";

/**
 * The operations an escalation and its recovery leave in `meta.audit_log`, which the anchoring
 * emitter commits to the forensic chain (ADR-0286/0288) — so the record of the escalation is itself
 * tamper-evident, which is what `IntegrityEscalator` has had since ADR-0288 and this did not
 * (ADR-0324's fourth open question).
 */
export const DELETION_EVIDENCE_ESCALATED_OPERATION = "platform.deletion_evidence_escalated";
export const DELETION_EVIDENCE_RESOLVED_OPERATION = "platform.deletion_evidence_resolved";

/**
 * The severity this finding is declared at, graded from its defects.
 *
 * **Highest wins.** A record with two defects is at least as bad as its worst one, so the grading
 * takes the maximum rather than averaging or taking the last: an averaging scheme would let
 * `unwitnessed` dilute `scope_tampered`, and a last-wins one would make the order
 * `verifyStoredEvidence` happens to push defects in load-bearing. A defect with no override, and an
 * empty defect list, fall back to `config.severity` — so a caller that cannot report defects at all
 * (the type carries them optionally) is graded exactly as it was before this existed.
 */
export function severityForDefects(
  defects: readonly string[],
  config: DeletionEscalationConfig,
): Severity {
  const overrides: Readonly<Record<string, Severity | undefined>> = config.severityByDefect ?? {};
  // Seeded with nothing rather than with `config.severity`: the fallback is *per defect*, not a
  // floor. Seeding it would make the default a minimum every override had to beat, so a deployment
  // could never grade a defect *down* from the default — which is the whole point of the map.
  let worst: Severity | null = null;
  for (const defect of defects) {
    const graded = overrides[defect] ?? config.severity;
    // `sev1` is index 0, so the more severe grade is the lower index.
    if (worst === null || SEVERITIES.indexOf(graded) < SEVERITIES.indexOf(worst)) worst = graded;
  }
  return worst ?? config.severity;
}

/** The episode key: one incident per request, not per pass and not per tombstone. */
export function deletionEvidenceKey(requestId: string): string {
  return autoDeclaredForKey(DELETION_EVIDENCE_SIGNAL, requestId);
}

/**
 * The namespace that keeps the two kinds of handle from ever meaning each other.
 *
 * A tombstone id and a request id are both opaque strings from different tables; nothing stops a
 * deployment from minting one that looks like the other. An unprefixed tombstone key would then
 * collide with a request episode and adopt an incident declared about a different record — which is
 * the precise failure this whole module exists to prevent, in its own index.
 */
export const TOMBSTONE_EPISODE_PREFIX = "tombstone:";

/** The episode key for an evidence record that no live deletion request names. */
export function deletionEvidenceTombstoneKey(tombstoneId: string): string {
  return autoDeclaredForKey(DELETION_EVIDENCE_SIGNAL, `${TOMBSTONE_EPISODE_PREFIX}${tombstoneId}`);
}

/**
 * What an episode is *about*.
 *
 * The three paths into this escalator see the same tampered row through different handles — a
 * stranded request, a completed request, a tombstone nothing names — and an episode must be one
 * incident regardless of which one arrived. So the subject is the record, and the key is derived
 * from it rather than chosen by the caller.
 */
export const ESCALATION_SUBJECT_KINDS = ["request", "tombstone"] as const;
export type EscalationSubjectKind = (typeof ESCALATION_SUBJECT_KINDS)[number];

export interface EscalationSubject {
  readonly kind: EscalationSubjectKind;
  readonly id: string;
}

export function episodeKeyFor(subject: EscalationSubject): string {
  return subject.kind === "request"
    ? deletionEvidenceKey(subject.id)
    : deletionEvidenceTombstoneKey(subject.id);
}

/**
 * Which handle a sweep finding's episode belongs to — the decision ADR-0327 left open.
 *
 * A tombstone and the request that names it are **the same fact**, so a `referenced` finding takes
 * the request's key and shares the episode `auditCompleted` and `reconcileStranded` already use for
 * that row. Keying it on the tombstone would declare a second incident for one tampered record, once
 * per direction that noticed.
 *
 * A `dangling` finding keys on the **tombstone**, even though it carries a request id. Nothing can
 * adopt an episode for a row that no longer exists — the request paths cannot reach it, so there is
 * no episode there to share — and the finding is about the proof, which is the thing still present
 * and still wrong. The same guard answers an input whose `reference` and `relatedDeletionRequestId`
 * disagree, which is what makes `requestId` on the outcome structurally unable to name a request
 * that is not there.
 */
export function tombstoneFindingSubject(finding: EscalatableTombstoneFinding): EscalationSubject {
  return finding.reference === "referenced" && finding.relatedDeletionRequestId !== null
    ? { kind: "request", id: finding.relatedDeletionRequestId }
    : { kind: "tombstone", id: finding.tombstoneId };
}

/**
 * The incident title for a sweep finding.
 *
 * A `dangling` finding is reported even when its proof is intact, so the usual sentence would be
 * false for it: the wrong thing there is the missing request, not the verification. Titles are read
 * by whoever is woken up, and one that overstates the finding costs exactly the credibility a `sev1`
 * depends on.
 */
function tombstoneFindingTitle(
  finding: EscalatableTombstoneFinding,
  defects: readonly string[],
): string {
  if (defects.length === 0 && finding.reference === "dangling") {
    return `Deletion proof ${finding.tombstoneId} names a deletion request that does not exist`;
  }
  const reach = finding.reference === "unreferenced" ? "unreferenced " : "";
  return `Deletion proof does not verify for ${reach}tombstone ${finding.tombstoneId}`;
}

/** What the escalator did about one verdict or finding. */
export const ESCALATION_ACTIONS = [
  /** A new incident was declared for this episode. */
  "declared",
  /** This episode already had one open; it was adopted rather than duplicated. */
  "adopted",
  /** The finding is resolved and the open incident was closed out. */
  "closed_out",
  /** Nothing warranted escalation and nothing was open. */
  "none",
  /** The declarer could not be reached. The next pass re-derives the finding and retries. */
  "failed",
] as const;
export type EscalationAction = (typeof ESCALATION_ACTIONS)[number];

export interface DeletionEscalationOutcome {
  /**
   * The deletion request this episode is about, or **null** when it is about a tombstone that no
   * live request names.
   *
   * Kept rather than replaced by `subject`, and widened rather than reused: every existing caller
   * reads this field, and the alternative — putting a tombstone id in it — would make the outcome
   * of a tombstone episode claim a request id that does not exist, which is the same class of false
   * record this module exists to catch. It is non-null exactly when `subject.kind === "request"`,
   * so a caller that only wants the request can keep asking for it and will not be told a lie.
   */
  readonly requestId: string | null;
  /** The record the episode is about, whichever handle the finding arrived under. */
  readonly subject: EscalationSubject;
  /** `autoDeclaredFor` for this episode — what `findOpen` was asked, and what was declared under. */
  readonly episodeKey: string;
  readonly action: EscalationAction;
  readonly incidentId: string | null;
  /**
   * The grade this pass declared and paged at — one value, used for both (see `escalate`). On a
   * `closed_out` pass it is the grade the incident was *declared* at, read off the open record,
   * because that is the grade the resolve routed at (ADR-0326).
   */
  readonly severity: Severity | null;
  readonly page: PageDirective | null;
  readonly closeOut: IncidentCloseOut | null;
  /**
   * Whether **this pass** wrote the escalation to `meta.audit_log` (and so anchored it). False for
   * `adopted` and `none`, which write nothing by design — the declaration's row already stands —
   * and false when no emitter is wired or the emit failed.
   */
  readonly audited: boolean;
  readonly detail: string | null;
}

/** The slice of a reconciliation result this reads. */
export interface EscalatableVerdict {
  readonly requestId: string;
  readonly tenantId: string;
  readonly verdict: string;
  readonly tombstoneId: string | null;
  readonly tombstoneIds: readonly string[];
  /**
   * `EVIDENCE_DEFECTS` from the verification behind the verdict, which grade the severity. Optional
   * because a caller may not have them; absent reads as "no gradation" and declares at
   * `config.severity`, exactly as every caller did before grading existed.
   */
  readonly defects?: readonly string[];
  readonly detail: string | null;
}

/** The slice of an `auditCompleted` finding this reads. */
export interface EscalatableFinding {
  readonly requestId: string;
  readonly tenantId: string;
  readonly tombstoneId: string;
  readonly present: boolean;
  readonly defects?: readonly string[];
  readonly detail: string;
}

/**
 * The slice of an `auditTombstones` finding this reads (ADR-0327, ADR-0328).
 *
 * `reference` is a `TombstoneReferenceState` and `defects` an `EVIDENCE_DEFECTS` list, both typed as
 * strings here for the same reason every other input in this file is: the escalator takes findings
 * from three callers and must not refuse one for a vocabulary it has not been rebuilt against.
 */
export interface EscalatableTombstoneFinding {
  readonly tombstoneId: string;
  readonly tenantId: string;
  /** `"unreferenced" | "referenced" | "dangling"`. */
  readonly reference: string;
  readonly relatedDeletionRequestId: string | null;
  readonly defects?: readonly string[];
  readonly detail: string;
}

export interface DeletionEscalatorOptions {
  readonly declarer: IncidentDeclarer;
  readonly config: DeletionEscalationConfig;
  /**
   * Records the escalation in `meta.audit_log`, which the anchoring emitter commits to the chain
   * (ADR-0286) — so the record of *this* escalation is as tamper-evident as the records it is
   * escalating about. Omitted ⇒ the incident is declared and the page sent, but the escalation
   * leaves no readable row, which is where ADR-0324 left it.
   *
   * Unlike `IntegrityEscalator`, this always has a tenant: every finding is about one record — a
   * request or a tombstone — and either names its tenant. So `audited: false` here only ever means
   * "not wired" or "the write failed", never "there was no tenant to write it against".
   */
  readonly audit?: PostgresAuditEmitter;
  readonly page?: (page: PageDirective, incident: IncidentRecord) => void | Promise<void>;
  /**
   * Closes the alert at the provider when the incident is closed out (ADR-0326).
   *
   * Separate from `page` because the two are different acts: `page` wakes somebody, this tells the
   * provider to stop. PagerDuty keys both on the incident id (`dedup_key`), so the resolve lands on
   * the alert the trigger opened. A transport with nothing to close — Slack, a webhook — reports
   * `unsupported`, which is not a failure: a posted message cannot be unposted.
   *
   * The directive is planned at the **incident's** severity, not the configured default, so the
   * resolve fans out over exactly the channels its trigger did. See `resolve`.
   */
  readonly resolvePage?: (page: PageDirective) => void | Promise<void>;
  readonly clock?: () => Date;
  /**
   * The second argument is the **subject's** id — the request id for a request episode, the
   * tombstone id for a tombstone one. Deliberately the bare id rather than the episode key: the key
   * is derivable from it and a log line reading `deletion_evidence:tombstone:tomb_…` is worse at the
   * only thing this argument is for, which is naming the row to go and look at.
   */
  readonly onError?: (err: unknown, subjectId: string) => void;
}

export class DeletionEvidenceEscalator {
  private readonly opts: DeletionEscalatorOptions;

  constructor(opts: DeletionEscalatorOptions) {
    this.opts = opts;
  }

  /** Escalates, adopts, closes out or does nothing, per the verdict. */
  async onVerdict(result: EscalatableVerdict): Promise<DeletionEscalationOutcome> {
    const subject: EscalationSubject = {
      kind: "request",
      id: result.requestId,
    };
    const escalates = (ESCALATING_VERDICTS as readonly string[]).includes(result.verdict);
    if (escalates) {
      return this.escalate(subject, {
        title: `Deletion evidence does not verify for request ${result.requestId}`,
        detail: this.detailFor(result),
        tenantId: result.tenantId,
        defects: result.defects ?? [],
        verdict: result.verdict,
      });
    }
    if ((RESOLVING_VERDICTS as readonly string[]).includes(result.verdict)) {
      return this.resolve(subject, `verdict is now ${result.verdict}`, {
        tenantId: result.tenantId,
        verdict: result.verdict,
      });
    }
    // `never_committed` and `too_recent` land here: neither warrants an incident, and neither
    // resolves one. Nothing is asked of the declarer, which matters because this is the common case
    // on every tick.
    return this.none(subject);
  }

  /** The reverse direction (ADR-0323): a *completed* request whose proof no longer stands up. */
  async onAuditFinding(finding: EscalatableFinding): Promise<DeletionEscalationOutcome> {
    return this.escalate(
      { kind: "request", id: finding.requestId },
      {
        title: finding.present
          ? `Deletion proof no longer verifies for completed request ${finding.requestId}`
          : `Deletion proof is missing for completed request ${finding.requestId}`,
        detail: `tenant ${finding.tenantId}, tombstone ${finding.tombstoneId}: ${finding.detail}`,
        tenantId: finding.tenantId,
        defects: finding.defects ?? [],
        // The audit direction has no reconciliation verdict — it is asked about requests that are
        // already `completed`. Recorded as null rather than as a borrowed verdict name, so the row
        // does not claim a reconciliation that never ran.
        verdict: null,
      },
    );
  }

  /**
   * The third direction (ADR-0327): a stored proof that does not stand up, found by a sweep that
   * started from the tombstone table rather than from any request.
   *
   * These are the findings nothing escalated, and they include the only ones **no other direction
   * can see at all** — every tombstone the synchronous deletion route of ADR-0320 writes has no
   * `relatedDeletionRequestId`, so both request-shaped audits walk straight past it. A falsified
   * Article 17 proof that nothing else will ever notice is exactly the finding that needs an
   * incident, which is ADR-0324's reasoning applied to the records it left out.
   */
  async onTombstoneFinding(
    finding: EscalatableTombstoneFinding,
  ): Promise<DeletionEscalationOutcome> {
    const subject = tombstoneFindingSubject(finding);
    const defects = finding.defects ?? [];
    return this.escalate(subject, {
      title: tombstoneFindingTitle(finding, defects),
      detail: `tenant ${finding.tenantId}, tombstone ${finding.tombstoneId} (${finding.reference}): ${finding.detail}`,
      tenantId: finding.tenantId,
      defects,
      // No reconciliation ran — this direction never asks about a request's status — so the row
      // records no verdict rather than borrowing a name from a path that did not execute, exactly
      // as `onAuditFinding` does.
      verdict: null,
      tombstoneId: finding.tombstoneId,
      reference: finding.reference,
    });
  }

  /**
   * Closes out the episode of a tombstone the caller has **verified clean**.
   *
   * This is the one place where the sweep's shape does not hand the answer over. `auditTombstones`
   * reports findings only, so a page carrying no finding for a tombstone does not say that tombstone
   * verifies — it may simply not have been on the page, since the sweep walks one page per tick and
   * laps. Treating absence from an arbitrary page as a recovery would cancel a `sev1` about a
   * tampered Article 17 proof on the strength of not having looked, which is worse than an alert
   * left up.
   *
   * So the recovery is explicit and the caller carries the burden of proof. **What the caller must
   * guarantee: that this tombstone id was among the rows examined by a page that reported no finding
   * for it** — established by a targeted re-read, or from the keyset range a page covers
   * (`afterTombstoneId` exclusive through `nextAfterTombstoneId` inclusive), never from a clean page
   * whose range it cannot place the row inside. Nothing calls this on a timer today, and that is the
   * honest state of it: a recovery the caller cannot substantiate is worse than none.
   *
   * Only **tombstone-keyed** episodes close here. A finding whose tombstone names a live request
   * escalated under that request's key, and its recovery is the request's own — `onVerdict`'s
   * `RESOLVING_VERDICTS`, which can see the request's status. Passing such a tombstone here finds
   * nothing open and answers `none`, which is correct rather than a miss.
   */
  async onTombstoneResolved(
    tombstoneId: string,
    tenantId: string,
  ): Promise<DeletionEscalationOutcome> {
    return this.resolve({ kind: "tombstone", id: tombstoneId }, "the tombstone's proof verifies", {
      tenantId,
      verdict: null,
      tombstoneId,
    });
  }

  private detailFor(result: EscalatableVerdict): string {
    const named =
      result.tombstoneIds.length > 1
        ? `tombstones ${result.tombstoneIds.join(", ")}`
        : `tombstone ${result.tombstoneId ?? "none"}`;
    return `tenant ${result.tenantId}, ${named}: ${result.detail ?? result.verdict}`;
  }

  private async escalate(
    subject: EscalationSubject,
    about: {
      readonly title: string;
      readonly detail: string;
      readonly tenantId: string;
      readonly defects: readonly string[];
      readonly verdict: string | null;
      readonly tombstoneId?: string;
      readonly reference?: string;
    },
  ): Promise<DeletionEscalationOutcome> {
    const key = episodeKeyFor(subject);
    // One grade, read once, used for the declaration AND for the page. A second call to
    // `severityForDefects` would be two chances to disagree, and a page routed by a different grade
    // than the incident carries is a page to the wrong rotation about an incident that does not say
    // so.
    const severity = severityForDefects(about.defects, this.opts.config);
    try {
      const open = await this.opts.declarer.findOpen(key);
      if (open !== null) {
        // Adopted, not re-declared. One tampered row examined every three seconds is one episode.
        // No audit row either: the declaration's row already stands, and one per tick would bury it.
        return {
          ...this.episode(subject),
          action: "adopted",
          incidentId: open.id,
          severity: null,
          page: null,
          closeOut: null,
          audited: false,
          detail: `already open as ${open.id}`,
        };
      }
      const record = await this.opts.declarer.declare({
        title: about.title,
        autoDeclaredFor: key,
        severity,
        category: this.opts.config.category,
        declaredBy: this.opts.config.declaredBy,
        detail: about.detail,
        declaredAt: this.now(),
        affectedTenantIds: [about.tenantId],
        securityIncident: true,
        metadata: {
          surface: `deletion-evidence/${subject.kind}/${subject.id}`,
          autoDeclared: true,
        },
      } satisfies IncidentDeclarationRequest);
      const page = planPageDirective(this.opts.config.alertPolicy, severity, record.id);
      if (page !== null) await this.opts.page?.(page, record);
      const audited = await this.record({
        operation: DELETION_EVIDENCE_ESCALATED_OPERATION,
        subject,
        tenantId: about.tenantId,
        incidentId: record.id,
        severity,
        defects: about.defects,
        verdict: about.verdict,
        reason: about.detail,
        ...(about.tombstoneId !== undefined ? { tombstoneId: about.tombstoneId } : {}),
        ...(about.reference !== undefined ? { reference: about.reference } : {}),
      });
      return {
        ...this.episode(subject),
        action: "declared",
        incidentId: record.id,
        severity,
        page,
        closeOut: null,
        audited,
        detail: about.detail,
      };
    } catch (err) {
      // Reported and not thrown: the verdict itself is already correct and returned to the caller,
      // and the next pass re-derives the finding from the same two rows and retries the declaration.
      this.opts.onError?.(err, subject.id);
      return {
        ...this.episode(subject),
        action: "failed",
        incidentId: null,
        severity: null,
        page: null,
        closeOut: null,
        audited: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async resolve(
    subject: EscalationSubject,
    reason: string,
    about: {
      readonly tenantId: string;
      readonly verdict: string | null;
      readonly tombstoneId?: string;
    },
  ): Promise<DeletionEscalationOutcome> {
    const key = episodeKeyFor(subject);
    try {
      const open = await this.opts.declarer.findOpen(key);
      if (open === null) return this.none(subject);
      const closeOut = await this.opts.declarer.closeOut(open.id, {
        reason,
        actorUserId: this.opts.config.declaredBy,
        at: this.now(),
      });
      const audited = await this.record({
        operation: DELETION_EVIDENCE_RESOLVED_OPERATION,
        subject,
        tenantId: about.tenantId,
        incidentId: open.id,
        // The grade the incident was *declared* at, read off the record rather than re-derived.
        // `severityForDefects([], config)` would answer the configured default here — the finding
        // has resolved, so there are no defects left to grade from — and that is only the declared
        // grade when the declaration happened to take the default. A `sev3` incident's resolution
        // row claiming `sev1` is the same class of false record this module exists to prevent.
        severity: open.severity,
        defects: [],
        verdict: about.verdict,
        reason,
        ...(about.tombstoneId !== undefined ? { tombstoneId: about.tombstoneId } : {}),
      });
      // Tell the provider to close the alert the declaration opened — but only if the record
      // actually closed. `human_owned` means a human triaged it and the incident is still open, so
      // resolving its alert would take it off the board of the person holding it.
      //
      // Planned from the same policy and keyed on the same incident id, so it reaches the alert
      // `dedup_key` opened — and at the incident's **own** grade, because the grade is what chose
      // the route. `AlertPolicy` maps a severity to a channel set, so planning the resolve at the
      // configured default would fan it out over the default's channels: a `sev3` finding that paged
      // a webhook would be "resolved" at PagerDuty, which never had an alert for it, while the
      // webhook rotation that did keeps a page nobody closed. A resolve reaches where its trigger
      // did, or it closes nothing.
      if (closeOutClosesAlert(closeOut)) {
        const resolveDirective = planPageDirective(
          this.opts.config.alertPolicy,
          open.severity,
          open.id,
        );
        if (resolveDirective !== null) await this.opts.resolvePage?.(resolveDirective);
      }
      return {
        ...this.episode(subject),
        action: "closed_out",
        incidentId: open.id,
        severity: open.severity,
        page: null,
        closeOut,
        audited,
        detail: reason,
      };
    } catch (err) {
      this.opts.onError?.(err, subject.id);
      return {
        ...this.episode(subject),
        action: "failed",
        incidentId: null,
        severity: null,
        page: null,
        closeOut: null,
        audited: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Writes the escalation itself to `meta.audit_log` — the evidence of *why* this grade was
   * declared, which the incident record alone does not carry.
   *
   * Returns rather than throws, and is called **after** the declaration and the page: by then the
   * incident is durable and somebody has been told, so an unwritable audit row must not turn a
   * successful escalation into a `failed` one that the next tick re-declares. Reported as
   * `audited: false`, exactly as `IntegrityEscalator.record` does, and for the sharper version of
   * the same reason — the audit log being unwritable is one of the conditions we escalate for.
   */
  private async record(input: {
    readonly operation: string;
    readonly subject: EscalationSubject;
    readonly tenantId: string;
    readonly incidentId: string;
    readonly severity: Severity;
    readonly defects: readonly string[];
    readonly verdict: string | null;
    readonly reason: string;
    readonly tombstoneId?: string;
    readonly reference?: string;
  }): Promise<boolean> {
    if (this.opts.audit === undefined) return false;
    try {
      await this.opts.audit.emit(
        auditEntry({
          id: randomUUID(),
          tenantId: input.tenantId,
          occurredAt: this.now(),
          actor: auditActor({ kind: "system", userId: null }),
          operation: input.operation,
          // The entity is the record the escalation is *about*, which for a tombstone episode is not
          // a request. Filing it as a `GdprDeletionRequest` with a tombstone id in `entityId` would
          // be a row whose entity and id disagree — and for an unreferenced tombstone there is no
          // request to file it under at all, which is the whole reason this path exists. Named as
          // its table names it (`meta.tenant_tombstones`), the way `TenantSchema` is.
          entity: input.subject.kind === "request" ? "GdprDeletionRequest" : "TenantTombstone",
          entityId: input.subject.id,
          after: {
            incidentId: input.incidentId,
            severity: input.severity,
            category: this.opts.config.category,
            defects: [...input.defects],
            verdict: input.verdict,
            // Carried even when the entity is the request: a referenced finding files under the
            // request's id, so without this the row would not name the proof that is wrong.
            ...(input.tombstoneId !== undefined ? { tombstoneId: input.tombstoneId } : {}),
            ...(input.reference !== undefined ? { reference: input.reference } : {}),
          },
          reason: input.reason,
        }),
      );
      return true;
    } catch (err) {
      this.opts.onError?.(err, input.subject.id);
      return false;
    }
  }

  /** The three fields every outcome carries, derived from the subject so they cannot disagree. */
  private episode(subject: EscalationSubject): {
    readonly requestId: string | null;
    readonly subject: EscalationSubject;
    readonly episodeKey: string;
  } {
    return {
      requestId: subject.kind === "request" ? subject.id : null,
      subject,
      episodeKey: episodeKeyFor(subject),
    };
  }

  private none(subject: EscalationSubject): DeletionEscalationOutcome {
    return {
      ...this.episode(subject),
      action: "none",
      incidentId: null,
      severity: null,
      page: null,
      closeOut: null,
      audited: false,
      detail: null,
    };
  }

  private now(): string {
    return (this.opts.clock ?? ((): Date => new Date()))().toISOString();
  }
}
