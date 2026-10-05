import { randomUUID } from "node:crypto";

import type { PageDeliveryReport } from "@crossengin/notification-providers";

import { auditActor, auditEntry, type PostgresAuditEmitter } from "./audit-log-store.js";

/**
 * Making a page's delivery evidence rather than a log line.
 *
 * ADR-0325 wired real transports under `PageDispatcher` and left this as its first open question:
 *
 * > A page is not recorded durably — no `meta.audit_log` row, no incident-timeline note. "We paged
 * > at 03:14 and PagerDuty accepted it" is exactly the claim an incident review needs, and it
 * > currently lives in a log line.
 *
 * A log line is not evidence. It is unanchored, rotates, and is the first thing missing when the
 * review happens weeks later — and for the two findings the paging path exists for (a falsified
 * Article 17 proof, a tampered audit chain) the chain of custody that ADR-0286 onward built stops
 * exactly at the alarm. So a delivery attempt is written to `meta.audit_log` through the same
 * emitter every other privileged action here uses, which means it is anchored into the forensic
 * chain whenever the deployment has one.
 *
 * Four rules.
 *
 * **The operation differs by outcome.** A page that arrived and a page that did not are different
 * facts, and an incident review asks different questions of them — "who was woken, and when" versus
 * "why did nobody come". So they get two operation names rather than one with a boolean, which also
 * makes the second directly countable: `countSince(tenant, since, PAGE_UNDELIVERED_OPERATION)` is a
 * deployment's "how often does our paging path fail" with no payload parsing.
 *
 * **The record carries the per-channel outcomes and nothing tenant-derived.** The outcomes *are*
 * the evidence — which transport took it, which provider, what status it answered, what it said
 * when it refused. What the record must not do is reintroduce what ADR-0310 and ADR-0325 kept out
 * of the page itself: the finding behind a page names a tenant uuid, a tombstone id and a defect
 * name, and none of it is here. The one tenant-derived value is the `tenant_id` the row is scoped
 * to, which is the column, not the payload.
 *
 * **A page for a platform-scope incident cannot be recorded at all.** `meta.audit_log.tenant_id` is
 * NOT NULL, and `PageDeliveryReport` deliberately carries no tenant — so `tenantIdFor` may answer
 * null and then there is no row to write. Reported as `audited: false` with a reason, exactly as
 * `IntegrityEscalator.record` does for the platform chain. Inventing a tenant id would file one
 * tenant's record under another's RLS scope, which is worse than no record.
 *
 * **Failing to record must never throw.** By the time this runs the page has already gone out or
 * already failed, and the incident record is already durable. Raising here would turn a successful
 * escalation into an error — the same mistake ADR-0325 refused when it chose `undelivered` over a
 * throw, and ADR-0320 before it when it reported `tenantRetired: false` on a 200.
 *
 * **This records a *delivery* attempt.** `PageDispatcher.resolve` fans out over the same channels
 * and answers the same `PageDeliveryReport` shape, but closing an alert is a different fact: a
 * resolve fan-out where every channel is `unsupported` would land here as
 * `platform.page_undelivered`, which claims a page failed when none was sent. A caller must not
 * route a resolve report through this; closing an alert wants its own operation if it wants one.
 */

/** A page that at least one channel took. */
export const PAGE_DELIVERED_OPERATION = "platform.page_delivered";
/** A page that no channel took — including a directive that named no channels at all. */
export const PAGE_UNDELIVERED_OPERATION = "platform.page_undelivered";

/** `meta.audit_log.entity` for both operations: a page is a fact about an incident. */
export const PAGE_RECORD_ENTITY = "incident";

const DELIVERED_REASON = "a page for this incident was delivered";
const UNDELIVERED_REASON = "a page for this incident was not delivered by any channel";

export interface PageRecorderOptions {
  readonly audit?: PostgresAuditEmitter;
  /**
   * Which tenant's audit scope this page's record belongs to, or null when the incident is
   * platform-scope. There is no default beyond null: the report carries no tenant by design, so a
   * deployment that wants the record has to say, and one that cannot is told rather than guessed at.
   */
  readonly tenantIdFor?: (report: PageDeliveryReport) => string | null;
  readonly clock?: () => Date;
  readonly onError?: (err: unknown) => void;
}

export interface PageRecordOutcome {
  readonly audited: boolean;
  /** Why not, when `audited` is false. Null on success. */
  readonly reason: string | null;
}

/**
 * The fields of a channel outcome this reads.
 *
 * Declared structurally rather than taken as `PageChannelOutcome` wholesale so that a field the
 * dispatcher gains is a decision here rather than a compile break — `attemptsMade` arrived while
 * this module was being written. Absent reads as "the dispatcher did not report it", never as zero.
 */
interface PageOutcomeFields {
  readonly kind: string;
  readonly disposition: string;
  readonly provider: string | null;
  readonly httpStatus: number | null;
  readonly reference: string | null;
  readonly errorMessage: string | null;
  readonly attemptsMade?: number;
  readonly retryAfterMs?: number | null;
  readonly waitedMs?: number;
}

/** The slice of an outcome that is evidence. Nothing here derives from the finding. */
interface RecordedChannelOutcome {
  readonly kind: string;
  readonly disposition: string;
  readonly provider: string | null;
  readonly httpStatus: number | null;
  readonly reference: string | null;
  readonly errorMessage: string | null;
  readonly attemptsMade: number | null;
  readonly retryAfterMs: number | null;
  readonly waitedMs: number | null;
}

function recordedOutcome(outcome: PageOutcomeFields): RecordedChannelOutcome {
  return {
    kind: outcome.kind,
    disposition: outcome.disposition,
    provider: outcome.provider,
    httpStatus: outcome.httpStatus,
    // The provider's own handle for the alert it opened — PagerDuty's dedup key, Slack's message
    // ts. "PagerDuty accepted it" is the claim this record exists to support, and this is the part
    // of it that can be checked against the provider afterwards. It is provider-issued, so it
    // carries nothing from the finding.
    reference: outcome.reference,
    errorMessage: outcome.errorMessage,
    // How many times the transport was actually called. "Failed once" and "failed three times over
    // nine seconds" are different facts about the same `failed` disposition, and a review that is
    // asking why nobody came needs the second one.
    attemptsMade: outcome.attemptsMade ?? null,
    // What the provider itself said about when to come back (ADR-0327). On a page that failed after
    // its whole budget this is the most informative field on the row — "PagerDuty asked for 45s and
    // we stopped rather than hold the page that long" is a different incident-review finding from
    // "the transport was down", and the two are indistinguishable without it.
    retryAfterMs: outcome.retryAfterMs ?? null,
    // How long the page spent *waiting* before the attempt that settled it (ADR-0328). "Retried
    // three times" and "retried three times over eleven seconds" answer different questions for a
    // review asking why nobody came, and with `attemptsMade` and `retryAfterMs` beside it this also
    // separates the three ways a retry stops: short of the policy's attempts with `waitedMs` near
    // the budget is exhaustion, with `retryAfterMs` at the ceiling it is the ceiling, otherwise it
    // succeeded. A duration, so nothing here derives from the finding.
    waitedMs: outcome.waitedMs ?? null,
  };
}

/**
 * The operation one report is recorded under.
 *
 * Deliberately `delivered > 0` rather than `!report.undelivered`: the dispatcher's `undelivered`
 * flag is false for a directive that named **no** channels, because it distinguishes "nothing took
 * it" from "nothing was asked". That distinction is right for a log line and wrong for this record
 * — filing a page nobody received under `platform.page_delivered` would be the false claim the
 * whole module exists to prevent. The flag itself is kept in the payload, so the distinction is not
 * lost.
 */
export function pageRecordOperation(report: PageDeliveryReport): string {
  return report.delivered > 0 ? PAGE_DELIVERED_OPERATION : PAGE_UNDELIVERED_OPERATION;
}

export class PageRecorder {
  private readonly opts: PageRecorderOptions;

  constructor(opts: PageRecorderOptions) {
    this.opts = opts;
  }

  /** Records one delivery attempt. Returns what it managed to write. */
  /**
   * `tenantId` is passed by the caller, not derived from the report — and that is forced by
   * ADR-0325's own content rule interacting with this one (ADR-0326).
   *
   * A `PageDeliveryReport` carries an incident id, a severity, a label and the per-channel outcomes,
   * because a page may not carry tenant data. So nothing in it can answer "whose audit row is this",
   * and a `tenantIdFor(report)` resolver has nothing to resolve *from*. The escalator that initiated
   * the page does know — it is on the `IncidentRecord` it just declared — so it supplies it. The
   * resolver remains for a caller that has a directory and only an incident id.
   */
  async record(report: PageDeliveryReport, suppliedTenantId?: string | null): Promise<PageRecordOutcome> {
    const audit = this.opts.audit;
    if (audit === undefined) {
      // Not an error: a deployment may have no audit emitter at all (no database, or no chain to
      // anchor into). The page still went out; it is the evidence that is missing.
      return { audited: false, reason: "no audit emitter configured" };
    }
    let resolved: string | null;
    try {
      resolved = suppliedTenantId ?? this.opts.tenantIdFor?.(report) ?? null;
    } catch (err) {
      // The resolver may consult a directory. It is on the recording path, so its failure is a
      // failure to record — never one that escapes over a page that already left.
      this.opts.onError?.(err);
      return { audited: false, reason: "could not resolve the page's tenant scope" };
    }
    // A blank answer is no answer: the emitter would reject it as a non-UUID anyway, and stopping
    // here keeps the refusal a reported outcome rather than a caught exception.
    const scopedTenantId = resolved !== null && resolved.trim().length > 0 ? resolved : null;
    if (scopedTenantId === null) {
      return {
        audited: false,
        reason:
          "page has no tenant scope and meta.audit_log.tenant_id is NOT NULL," +
          " so the delivery could not be recorded",
      };
    }
    const operation = pageRecordOperation(report);
    const clock = this.opts.clock ?? (() => new Date());
    try {
      await audit.emit(
        auditEntry({
          id: randomUUID(),
          tenantId: scopedTenantId,
          // The recording clock, not the dispatcher's: this row dates when the delivery was
          // written down, and a report handed over late must not be backdated into the chain.
          occurredAt: clock().toISOString(),
          actor: auditActor({ kind: "system", userId: null }),
          operation,
          entity: PAGE_RECORD_ENTITY,
          entityId: report.incidentId,
          after: {
            incidentId: report.incidentId,
            attempted: report.attempted,
            delivered: report.delivered,
            undelivered: report.undelivered,
            outcomes: report.outcomes.map(recordedOutcome),
          },
          reason: operation === PAGE_DELIVERED_OPERATION ? DELIVERED_REASON : UNDELIVERED_REASON,
        }),
      );
      return { audited: true, reason: null };
    } catch (err) {
      // The page is already out of the process and the incident already stored. Route the failure
      // to the deployment's error sink and report it; never raise it over the escalation.
      this.opts.onError?.(err);
      return {
        audited: false,
        reason: `audit emit failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

/** One line for the escalator's log, naming whether the page became evidence. */
export function formatPageRecord(
  report: PageDeliveryReport,
  outcome: PageRecordOutcome,
): string {
  const head = `${pageRecordOperation(report)} ${report.incidentId}`;
  if (outcome.audited) return `${head}: recorded`;
  return `${head}: NOT recorded (${outcome.reason ?? "unknown"})`;
}
