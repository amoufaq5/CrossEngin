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
 * Four rules.
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
 *
 * **A page can be taken back, and a failed one can be tried again — but only the right ones.**
 * `resolve` closes what `deliver` opened, where the transport holds state that can be closed:
 * PagerDuty keys an alert on `dedup_key`, so the escalators that cancel their incident when a
 * finding clears (ADR-0324) can now close the alert too, instead of leaving a rotation paged about
 * something already fixed. Slack and the webhook report `unsupported`, which is not a failure.
 * And the dispatcher — not the senders — owns a bounded retry, because only it sees the whole
 * directive and because `failed` is the one disposition worth another call: `rejected` means the
 * provider said no and will say no again.
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
  /**
   * Close whatever `send` opened, when the transport holds open state that can be closed.
   *
   * **Optional on purpose.** PagerDuty keys an open alert on `dedup_key`, so a second call with
   * `event_action: "resolve"` closes exactly the alert this incident opened. Slack and the signed
   * webhook have nothing to resolve — a posted message cannot be unposted, and a webhook POST is
   * already consumed. A sender without this is reported `unsupported`, which is not a failure: the
   * transport was never asked to do anything.
   */
  resolve?(incidentId: string, address: string): Promise<PageSendResult>;
}

export const PAGE_CHANNEL_DISPOSITIONS = [
  "delivered",
  "rejected",
  "failed",
  /** No sender is wired for this kind, so nothing was attempted. */
  "unroutable",
  /** The target carries no address for its kind — a policy that cannot be acted on. */
  "no_address",
  /**
   * The sender exists but has no `resolve`, so there is nothing to close. Only ever produced by
   * `resolve`, never by `deliver`, and it is **not** a failure — see `undelivered`.
   */
  "unsupported",
] as const;
export type PageChannelDisposition = (typeof PAGE_CHANNEL_DISPOSITIONS)[number];

export interface PageChannelOutcome {
  readonly kind: string;
  readonly disposition: PageChannelDisposition;
  readonly provider: string | null;
  readonly httpStatus: number | null;
  readonly reference: string | null;
  readonly errorMessage: string | null;
  /**
   * How many times the transport was actually called — 1 with no retry configured, 0 for a
   * disposition settled before any call (`unroutable` / `no_address` / `unsupported`). A report
   * says how hard it tried, so a single error line distinguishes "failed once" from "failed
   * three times over nine seconds".
   */
  readonly attemptsMade: number;
}

export interface PageDeliveryReport {
  readonly incidentId: string;
  readonly attempted: number;
  readonly delivered: number;
  /**
   * True when something was **asked** of a transport and none of it got through.
   *
   * `undelivered` means a page that should have gone out did not. An `unsupported` channel is not
   * that: nothing was asked of it, because there was nothing for it to do. So a resolve fan-out
   * where every channel is `unsupported` is **not** undelivered, while one where the single
   * resolvable channel failed is. `unroutable` and `no_address` *do* count — a policy naming a
   * channel the deployment never wired is a page that should have gone out and did not.
   */
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

/**
 * Bounded retry for a page the transport did not take.
 *
 * `attempts` is the **total** number of calls, not extra ones, so `1` — the default — is the
 * no-retry behaviour this dispatcher had before. Clamped to at least 1, because 0 attempts would
 * silently drop a `sev1`.
 */
export interface PageRetryPolicy {
  readonly attempts: number;
  readonly delayMs: number;
}

export interface PageDispatcherOptions {
  /** One sender per channel kind. A kind with none is reported `unroutable`, never skipped. */
  readonly senders: Partial<Record<string, PageChannelSender>>;
  /** The deployment-declared label that goes in the page. */
  readonly signal: string;
  readonly onReport?: (report: PageDeliveryReport) => void;
  /**
   * Absent by default, so a dispatcher retries nothing unless its caller asked for it.
   *
   * ADR-0325 Option E declined a retry *inside the senders* for a reason that still holds: the
   * three escalators have different cadences — the SLO loop and the deletion reconciler re-derive
   * their finding every tick and would re-page anyway, while the integrity escalator is one-shot
   * and a transport blip loses its only announcement. So the policy lives here, on the one object
   * that sees the whole directive, and each caller configures its own.
   */
  readonly retry?: PageRetryPolicy;
  /** Injected so a test does not wait. Defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Which dispositions a retry may be attempted for. Exactly one, and the rest are reasoned below. */
function isRetryable(disposition: PageChannelDisposition): boolean {
  // `failed` only — a timeout, a 5xx, a DNS failure, a sender that threw. Calling again may work.
  //
  // Never `rejected`: PagerDuty answered 400 on the routing key, Slack answered
  // `channel_not_found`. The senders already separate that from `failed` precisely so this
  // decision can be made, and retrying a refusal just collects the same refusal again — at the
  // one moment the platform most needs the attempts it has.
  //
  // Never `unroutable`, `no_address` or `unsupported`: all three are facts about the deployment or
  // the transport, settled before any call. No number of attempts wires a sender, fills in an
  // address, or gives Slack an unpost button.
  return disposition === "failed";
}

export class PageDispatcher {
  private readonly opts: PageDispatcherOptions;

  constructor(opts: PageDispatcherOptions) {
    this.opts = opts;
  }

  async deliver(directive: PageDirectiveLike): Promise<PageDeliveryReport> {
    return this.fanOut(directive, "deliver");
  }

  /**
   * Close the alerts this incident opened, over the same channels and with the same reporting
   * shape as `deliver`. ADR-0324's escalators cancel their incident when the finding clears; until
   * this existed the PagerDuty alert stayed open regardless, so a resolved finding kept paging.
   */
  async resolve(directive: PageDirectiveLike): Promise<PageDeliveryReport> {
    return this.fanOut(directive, "resolve");
  }

  private async fanOut(
    directive: PageDirectiveLike,
    operation: "deliver" | "resolve",
  ): Promise<PageDeliveryReport> {
    const content: PageContent = {
      incidentId: directive.incidentId,
      severity: directive.severity,
      signal: this.opts.signal,
    };
    const outcomes: PageChannelOutcome[] = [];
    for (const target of directive.channels) {
      outcomes.push(await this.one(content, target, operation));
    }
    const delivered = outcomes.filter((o) => o.disposition === "delivered").length;
    const attempted = outcomes.filter((o) => o.attemptsMade > 0).length;
    // Anything but `unsupported` was asked of a transport, so a channel that could not be
    // reached (`unroutable`, `no_address`) still counts as a page that should have gone out.
    const asked = outcomes.filter((o) => o.disposition !== "unsupported").length;
    const report: PageDeliveryReport = {
      incidentId: directive.incidentId,
      attempted,
      delivered,
      undelivered: asked > 0 && delivered === 0,
      outcomes,
    };
    this.opts.onReport?.(report);
    return report;
  }

  private async one(
    content: PageContent,
    target: PageChannelTargetLike,
    operation: "deliver" | "resolve",
  ): Promise<PageChannelOutcome> {
    const sender = this.opts.senders[target.kind];
    if (sender === undefined) {
      // Named in the policy and not wired. Reported rather than skipped: ADR-0301's
      // skip-a-partial-provider rule is about *notifications*, where not sending is the safe
      // direction. For a page it is the failure.
      return settled(target.kind, "unroutable", null, `no page sender wired for '${target.kind}'`);
    }
    // Set only on a resolve, so `resolveFn === undefined` below means "this is a deliver" — the
    // one case that may fall through to `send`.
    const resolveFn = operation === "resolve" ? sender.resolve : undefined;
    if (operation === "resolve" && resolveFn === undefined) {
      // Asked before the address, because it is the more informative answer: a transport with
      // nothing to resolve is not a policy that needs fixing.
      return settled(
        target.kind,
        "unsupported",
        sender.provider,
        `page sender '${sender.provider}' has nothing to resolve`,
      );
    }
    const address = pageAddressFor(target);
    if (address === null) {
      return settled(
        target.kind,
        "no_address",
        sender.provider,
        `policy target for '${target.kind}' carries no address`,
      );
    }
    const invoke: () => Promise<PageSendResult> =
      resolveFn === undefined
        ? (): Promise<PageSendResult> => sender.send(content, address)
        : (): Promise<PageSendResult> => resolveFn.call(sender, content.incidentId, address);

    const attempts = Math.max(1, Math.trunc(this.opts.retry?.attempts ?? 1));
    const delayMs = this.opts.retry?.delayMs ?? 0;
    const sleep = this.opts.sleep ?? defaultSleep;
    let outcome = await this.callOnce(invoke, sender.provider, target.kind, 1);
    while (isRetryable(outcome.disposition) && outcome.attemptsMade < attempts) {
      await sleep(delayMs);
      outcome = await this.callOnce(invoke, sender.provider, target.kind, outcome.attemptsMade + 1);
    }
    return outcome;
  }

  private async callOnce(
    invoke: () => Promise<PageSendResult>,
    provider: string,
    kind: string,
    attemptsMade: number,
  ): Promise<PageChannelOutcome> {
    try {
      const result = await invoke();
      return {
        kind,
        disposition: result.outcome,
        provider: result.provider,
        httpStatus: result.httpStatus,
        reference: result.reference,
        errorMessage: result.errorMessage,
        attemptsMade,
      };
    } catch (err) {
      // A sender that throws rather than returning a result. Caught per channel so one dead
      // provider cannot stop the others from being tried — and `failed`, so it is retryable.
      return {
        kind,
        disposition: "failed",
        provider,
        httpStatus: null,
        reference: null,
        errorMessage: err instanceof Error ? err.message : String(err),
        attemptsMade,
      };
    }
  }
}

/** A disposition reached without calling the transport, so `attemptsMade` is 0. */
function settled(
  kind: string,
  disposition: PageChannelDisposition,
  provider: string | null,
  errorMessage: string,
): PageChannelOutcome {
  return {
    kind,
    disposition,
    provider,
    httpStatus: null,
    reference: null,
    errorMessage,
    attemptsMade: 0,
  };
}

const defaultSleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

/** One line per channel, for a log that has to be readable at 3am. */
export function formatPageReport(report: PageDeliveryReport): string {
  const head = report.undelivered
    ? `PAGE UNDELIVERED ${report.incidentId}`
    : `PAGE ${report.incidentId} delivered=${report.delivered.toString()}/${report.attempted.toString()}`;
  const lines = report.outcomes.map(
    (o) =>
      `  ${o.kind} → ${o.disposition}` +
      // Only when it retried, so the common line stays as short as it was.
      `${o.attemptsMade > 1 ? ` ×${o.attemptsMade.toString()}` : ""}` +
      `${o.httpStatus === null ? "" : ` http=${o.httpStatus.toString()}`}` +
      `${o.errorMessage === null ? "" : ` (${o.errorMessage})`}`,
  );
  return [head, ...lines].join("\n");
}
