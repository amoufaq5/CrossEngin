import type { PageContent, PageSendResult } from "./page-pagerduty.js";

/**
 * Delivering a page, or saying loudly that it was not delivered.
 *
 * Every escalator in this platform plans a `PageDirective` and then hands it to a sink that writes
 * a line to stderr — the SLO loop, the audit-integrity escalator (ADR-0288) and the deletion-evidence
 * escalator (ADR-0324) all do. So the platform declares `sev1` incidents and *claims* to page, and
 * nothing leaves the process. ADR-0324 recorded that as an open question twice over: "a
 * `PageDirective` is still only logged — nothing in the platform delivers one."
 *
 * Three rules.
 *
 * **A page is not a notification, and must not travel as one.** The obvious shortcut is to route
 * these through `notifications` and reuse SES/Twilio. But that stack exists to *withhold* delivery
 * on the recipient's behalf — preferences, suppressions and quiet hours all decide not to send —
 * and a `sev1` page is precisely the thing none of them may apply to. A page gets its own senders so
 * that it cannot acquire a reason not to arrive.
 *
 * **A page carries no tenant data** (`PageContent`, ADR-0310's rule on a different surface): an
 * incident id, a severity from a closed vocabulary, and a label the deployment declared. The finding
 * that fired it names a tenant and a tombstone, and a page reaches a lock screen through somebody
 * else's servers.
 *
 * **Every channel is attempted, and a directive nothing delivered is its own outcome.** One dead
 * provider must not mask the rest, so a throw from one sender does not abort the fan-out; and
 * `delivered: 0` with channels present is `undelivered`, which a caller can log at error and act on.
 * It is **not** thrown: by the time a page is planned the incident record is already durable, and
 * raising here would make a successful declaration look like a failed escalation.
 */

/** The channel kinds an `AlertPolicy` can name. Mirrored, so this package needs no observability dep. */
export const PAGE_CHANNEL_KINDS = [
  "pagerduty_phone",
  "pagerduty_business_hours",
  "slack",
  "email_digest",
  "sms",
  "webhook",
] as const;
export type PageChannelKind = (typeof PAGE_CHANNEL_KINDS)[number];

/** Structural mirror of `AlertChannelTarget`: the kind plus whichever address field it carries. */
export interface PageChannelTargetLike {
  readonly kind: string;
  readonly serviceKey?: string;
  readonly channel?: string;
  readonly url?: string;
  readonly recipients?: readonly string[];
  readonly phoneNumbers?: readonly string[];
}

/** Structural mirror of `PageDirective`. */
export interface PageDirectiveLike {
  readonly severity: string;
  readonly incidentId: string;
  readonly channels: readonly PageChannelTargetLike[];
}

/** One transport. `address` is whatever the target carries for that kind. */
export interface PageChannelSender {
  readonly provider: string;
  send(content: PageContent, address: string): Promise<PageSendResult>;
}

export const PAGE_CHANNEL_DISPOSITIONS = [
  "delivered",
  "rejected",
  "failed",
  /** No sender is wired for this kind, so nothing was attempted. */
  "unroutable",
  /** The target carries no address for its kind — a policy that cannot be acted on. */
  "no_address",
] as const;
export type PageChannelDisposition = (typeof PAGE_CHANNEL_DISPOSITIONS)[number];

export interface PageChannelOutcome {
  readonly kind: string;
  readonly disposition: PageChannelDisposition;
  readonly provider: string | null;
  readonly httpStatus: number | null;
  readonly reference: string | null;
  readonly errorMessage: string | null;
}

export interface PageDeliveryReport {
  readonly incidentId: string;
  readonly attempted: number;
  readonly delivered: number;
  /** True when the directive named channels and **none** of them took it. */
  readonly undelivered: boolean;
  readonly outcomes: readonly PageChannelOutcome[];
}

/** The address a target carries for its kind, or null when the policy names none. */
export function pageAddressFor(target: PageChannelTargetLike): string | null {
  switch (target.kind) {
    case "pagerduty_phone":
    case "pagerduty_business_hours":
      return target.serviceKey ?? null;
    case "slack":
      return target.channel ?? null;
    case "webhook":
      return target.url ?? null;
    case "email_digest":
      return target.recipients?.[0] ?? null;
    case "sms":
      return target.phoneNumbers?.[0] ?? null;
    default:
      return null;
  }
}

export interface PageDispatcherOptions {
  /** One sender per channel kind. A kind with none is reported `unroutable`, never skipped. */
  readonly senders: Partial<Record<string, PageChannelSender>>;
  /** The deployment-declared label that goes in the page. */
  readonly signal: string;
  readonly onReport?: (report: PageDeliveryReport) => void;
}

export class PageDispatcher {
  private readonly opts: PageDispatcherOptions;

  constructor(opts: PageDispatcherOptions) {
    this.opts = opts;
  }

  async deliver(directive: PageDirectiveLike): Promise<PageDeliveryReport> {
    const content: PageContent = {
      incidentId: directive.incidentId,
      severity: directive.severity,
      signal: this.opts.signal,
    };
    const outcomes: PageChannelOutcome[] = [];
    for (const target of directive.channels) {
      outcomes.push(await this.one(content, target));
    }
    const delivered = outcomes.filter((o) => o.disposition === "delivered").length;
    const attempted = outcomes.filter(
      (o) => o.disposition !== "unroutable" && o.disposition !== "no_address",
    ).length;
    const report: PageDeliveryReport = {
      incidentId: directive.incidentId,
      attempted,
      delivered,
      undelivered: outcomes.length > 0 && delivered === 0,
      outcomes,
    };
    this.opts.onReport?.(report);
    return report;
  }

  private async one(
    content: PageContent,
    target: PageChannelTargetLike,
  ): Promise<PageChannelOutcome> {
    const sender = this.opts.senders[target.kind];
    if (sender === undefined) {
      // Named in the policy and not wired. Reported rather than skipped: ADR-0301's
      // skip-a-partial-provider rule is about *notifications*, where not sending is the safe
      // direction. For a page it is the failure.
      return {
        kind: target.kind,
        disposition: "unroutable",
        provider: null,
        httpStatus: null,
        reference: null,
        errorMessage: `no page sender wired for '${target.kind}'`,
      };
    }
    const address = pageAddressFor(target);
    if (address === null) {
      return {
        kind: target.kind,
        disposition: "no_address",
        provider: sender.provider,
        httpStatus: null,
        reference: null,
        errorMessage: `policy target for '${target.kind}' carries no address`,
      };
    }
    try {
      const result = await sender.send(content, address);
      return {
        kind: target.kind,
        disposition: result.outcome,
        provider: result.provider,
        httpStatus: result.httpStatus,
        reference: result.reference,
        errorMessage: result.errorMessage,
      };
    } catch (err) {
      // A sender that throws rather than returning a result. Caught per channel so one dead
      // provider cannot stop the others from being tried.
      return {
        kind: target.kind,
        disposition: "failed",
        provider: sender.provider,
        httpStatus: null,
        reference: null,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/** One line per channel, for a log that has to be readable at 3am. */
export function formatPageReport(report: PageDeliveryReport): string {
  const head = report.undelivered
    ? `PAGE UNDELIVERED ${report.incidentId}`
    : `PAGE ${report.incidentId} delivered=${report.delivered.toString()}/${report.attempted.toString()}`;
  const lines = report.outcomes.map(
    (o) =>
      `  ${o.kind} → ${o.disposition}` +
      `${o.httpStatus === null ? "" : ` http=${o.httpStatus.toString()}`}` +
      `${o.errorMessage === null ? "" : ` (${o.errorMessage})`}`,
  );
  return [head, ...lines].join("\n");
}
