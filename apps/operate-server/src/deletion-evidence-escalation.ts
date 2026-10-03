import { autoDeclaredForKey, type IncidentRecord } from "@crossengin/incident-response";
import type {
  IncidentCloseOut,
  IncidentDeclarationRequest,
  IncidentDeclarer,
} from "@crossengin/incident-response-runtime";
import { planPageDirective, type PageDirective } from "@crossengin/observability-runtime";

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

/** The episode key: one incident per request, not per pass and not per tombstone. */
export function deletionEvidenceKey(requestId: string): string {
  return autoDeclaredForKey(DELETION_EVIDENCE_SIGNAL, requestId);
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
  readonly requestId: string;
  readonly action: EscalationAction;
  readonly incidentId: string | null;
  readonly page: PageDirective | null;
  readonly closeOut: IncidentCloseOut | null;
  readonly detail: string | null;
}

/** The slice of a reconciliation result this reads. */
export interface EscalatableVerdict {
  readonly requestId: string;
  readonly tenantId: string;
  readonly verdict: string;
  readonly tombstoneId: string | null;
  readonly tombstoneIds: readonly string[];
  readonly detail: string | null;
}

/** The slice of an `auditCompleted` finding this reads. */
export interface EscalatableFinding {
  readonly requestId: string;
  readonly tenantId: string;
  readonly tombstoneId: string;
  readonly present: boolean;
  readonly detail: string;
}

export interface DeletionEscalatorOptions {
  readonly declarer: IncidentDeclarer;
  readonly config: DeletionEscalationConfig;
  readonly page?: (page: PageDirective, incident: IncidentRecord) => void | Promise<void>;
  readonly clock?: () => Date;
  readonly onError?: (err: unknown, requestId: string) => void;
}

export class DeletionEvidenceEscalator {
  private readonly opts: DeletionEscalatorOptions;

  constructor(opts: DeletionEscalatorOptions) {
    this.opts = opts;
  }

  /** Escalates, adopts, closes out or does nothing, per the verdict. */
  async onVerdict(result: EscalatableVerdict): Promise<DeletionEscalationOutcome> {
    const escalates = (ESCALATING_VERDICTS as readonly string[]).includes(result.verdict);
    if (escalates) {
      return this.escalate(result.requestId, {
        title: `Deletion evidence does not verify for request ${result.requestId}`,
        detail: this.detailFor(result),
        tenantId: result.tenantId,
      });
    }
    if ((RESOLVING_VERDICTS as readonly string[]).includes(result.verdict)) {
      return this.resolve(result.requestId, `verdict is now ${result.verdict}`);
    }
    // `never_committed` and `too_recent` land here: neither warrants an incident, and neither
    // resolves one. Nothing is asked of the declarer, which matters because this is the common case
    // on every tick.
    return this.none(result.requestId);
  }

  /** The reverse direction (ADR-0323): a *completed* request whose proof no longer stands up. */
  async onAuditFinding(finding: EscalatableFinding): Promise<DeletionEscalationOutcome> {
    return this.escalate(finding.requestId, {
      title: finding.present
        ? `Deletion proof no longer verifies for completed request ${finding.requestId}`
        : `Deletion proof is missing for completed request ${finding.requestId}`,
      detail: `tenant ${finding.tenantId}, tombstone ${finding.tombstoneId}: ${finding.detail}`,
      tenantId: finding.tenantId,
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
    requestId: string,
    about: { readonly title: string; readonly detail: string; readonly tenantId: string },
  ): Promise<DeletionEscalationOutcome> {
    const key = deletionEvidenceKey(requestId);
    try {
      const open = await this.opts.declarer.findOpen(key);
      if (open !== null) {
        // Adopted, not re-declared. One tampered row examined every three seconds is one episode.
        return {
          requestId,
          action: "adopted",
          incidentId: open.id,
          page: null,
          closeOut: null,
          detail: `already open as ${open.id}`,
        };
      }
      const record = await this.opts.declarer.declare({
        title: about.title,
        autoDeclaredFor: key,
        severity: this.opts.config.severity,
        category: this.opts.config.category,
        declaredBy: this.opts.config.declaredBy,
        detail: about.detail,
        declaredAt: this.now(),
        affectedTenantIds: [about.tenantId],
        securityIncident: true,
        metadata: { surface: `deletion-evidence/${requestId}`, autoDeclared: true },
      } satisfies IncidentDeclarationRequest);
      const page = planPageDirective(
        this.opts.config.alertPolicy,
        this.opts.config.severity,
        record.id,
      );
      if (page !== null) await this.opts.page?.(page, record);
      return {
        requestId,
        action: "declared",
        incidentId: record.id,
        page,
        closeOut: null,
        detail: about.detail,
      };
    } catch (err) {
      // Reported and not thrown: the verdict itself is already correct and returned to the caller,
      // and the next pass re-derives the finding from the same two rows and retries the declaration.
      this.opts.onError?.(err, requestId);
      return {
        requestId,
        action: "failed",
        incidentId: null,
        page: null,
        closeOut: null,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async resolve(requestId: string, reason: string): Promise<DeletionEscalationOutcome> {
    const key = deletionEvidenceKey(requestId);
    try {
      const open = await this.opts.declarer.findOpen(key);
      if (open === null) return this.none(requestId);
      const closeOut = await this.opts.declarer.closeOut(open.id, {
        reason,
        actorUserId: this.opts.config.declaredBy,
        at: this.now(),
      });
      return {
        requestId,
        action: "closed_out",
        incidentId: open.id,
        page: null,
        closeOut,
        detail: reason,
      };
    } catch (err) {
      this.opts.onError?.(err, requestId);
      return {
        requestId,
        action: "failed",
        incidentId: null,
        page: null,
        closeOut: null,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private none(requestId: string): DeletionEscalationOutcome {
    return {
      requestId,
      action: "none",
      incidentId: null,
      page: null,
      closeOut: null,
      detail: null,
    };
  }

  private now(): string {
    return (this.opts.clock ?? ((): Date => new Date()))().toISOString();
  }
}
