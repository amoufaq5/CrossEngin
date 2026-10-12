import type { PageContent, PageSendResult } from "./page-pagerduty.js";
import {
  DEFAULT_PAGE_RETRY_BUDGET_MS,
  pageRetryBudgetMs,
  retryAfterExceedsCeiling,
} from "./retry-after.js";

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
 *
 * **A retry honours the provider's own `Retry-After`, up to a ceiling.** The retry above was
 * uniform, which made it worse than useless against the condition it exists for: a 429 carrying
 * `Retry-After: 10` was retried at 2s and 4s, both refused, and the page reported `failed` having
 * spent its budget inside the window the provider named. So the wait is `max(policy, provider)` —
 * the policy is the floor so `Retry-After: 0` cannot become a hot loop, the provider's figure is
 * the floor when longer — and an instruction past `MAX_RETRY_AFTER_MS` ends the retry instead of
 * being obeyed, because a page held that long is no longer a page.
 *
 * **And the retry does not arrive as a spike, and its total wait is a number we can state.** Three
 * attempts at a flat two seconds is the worst shape for the condition the retry exists for. A
 * provider that is rate-limiting or degraded is degraded for *everyone*, so every replica of this
 * process retried at the same two offsets and the retries arrived together, at the one moment the
 * provider could least take them. So the gap grows, it is jittered upward from a floor, and the
 * summed waiting is capped — see `PageRetryPolicy`, `pageBackoffMs` and
 * `DEFAULT_PAGE_RETRY_BUDGET_MS`. All three are additive: a policy naming only `attempts` and
 * `delayMs` still behaves exactly as ADR-0326 left it, because a change of shape in the delay in
 * front of a human is something a deployment opts into.
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
  /**
   * What the provider's `Retry-After` asked for on the last attempt, or null for "said nothing".
   *
   * **Required with null**, unlike `PageSendResult.retryAfterMs` which is optional: the dispatcher
   * constructs these itself, so there is no double to break, and a reader that walks an outcome
   * structurally (the audit-record writer in `apps/operate-server` does) should see "no
   * instruction" stated rather than inferred from an absent key.
   */
  readonly retryAfterMs: number | null;
  /**
   * How long this channel spent **waiting** before the attempt that settled it, summed over the
   * gaps. 0 whenever nothing waited, including every disposition settled before a call.
   *
   * The question an incident review asks is not "how many times did it try" but "how long before
   * anybody was told", and once the gap grows and jitters, `attemptsMade` no longer implies it:
   * three attempts is anywhere from 4s to 12s under the recommended policy, and up to the whole
   * budget once a provider's `Retry-After` is in play. One field rather than a per-attempt list,
   * because the three ways a retry stops are already separable with it — `attemptsMade` short of
   * the policy's with `waitedMs` near the budget is budget exhaustion, with
   * `retryAfterMs >= MAX_RETRY_AFTER_MS` it is the ceiling, and otherwise it succeeded.
   *
   * A duration, so it carries nothing from the finding (ADR-0310, ADR-0325).
   */
  readonly waitedMs: number;
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
  /**
   * The platform's **floor** between attempts, not the whole rule: a provider's `Retry-After` wins
   * when it is longer, and the backoff grows from here. See `waitBefore` and `pageBackoffMs`.
   */
  readonly delayMs: number;
  /**
   * What each gap is multiplied by, compounding: gap *n* is `delayMs × factor^(n-1)`.
   *
   * Defaults to **1**, which is ADR-0326's flat retry, so a policy that names only the two fields
   * above is unchanged. `JITTERED_PAGE_RETRY` sets 2.
   *
   * Exponential rather than linear because the two cases want opposite things from the same budget:
   * a blip clears in the first gap and should not have paid for the outage, while an outage wants
   * the later attempts spread out. Compounding is the only growth where almost all of the budget is
   * spent on the last gap, so the blip keeps the short first attempt and the outage still gets its
   * spread. A factor below 1 is clamped to 1 — a shrinking gap is not a backoff, and it would push
   * the wait under the floor `delayMs` exists to be.
   */
  readonly backoffFactor?: number;
  /**
   * How much of the gap may be added to it at random, as a fraction: the wait is uniform over
   * `[gap, gap × (1 + jitterRatio))`. Clamped to `[0, 1]`, and **0** by default — no jitter, which
   * is again ADR-0326's behaviour.
   *
   * **Jitter upward from a floor, not around a midpoint.** The failure mode is several replicas of
   * this process retrying one degraded provider in lockstep, which full or equal jitter both
   * decorrelate — but both do it by spreading *below* the configured delay, and this platform has
   * already decided that delay is a floor it owns: ADR-0327 made `max(policy, provider)` the rule so
   * that `Retry-After: 0` could not become a hot loop against a provider already struggling. A
   * scheme that halves the gap re-opens exactly that. Jittering upward keeps the floor and still
   * spreads the arrivals over a window as wide as equal jitter's (a 2× window at ratio 1), at the
   * cost of a slightly later worst case — which the budget bounds.
   *
   * What it fixes: the *second and later* attempts of many replicas no longer land together, so a
   * degraded provider sees a wave instead of a spike. What it does not: the **first** attempts are
   * not jittered at all and never will be, because a page goes out at once; the total number of
   * calls is unchanged, so this spreads load rather than shedding it; and a `Retry-After` longer
   * than the jittered gap re-synchronises every replica it binds, which is accepted, because the
   * alternative is holding a page longer than the provider asked for.
   */
  readonly jitterRatio?: number;
  /**
   * The ceiling on this policy's **summed** waiting, defaulting to `DEFAULT_PAGE_RETRY_BUDGET_MS`
   * and clamped to `MAX_PAGE_RETRY_BUDGET_MS`. The dispatcher stops when the next gap would not fit
   * rather than sleeping past it, so a worst case is a number and not an argument.
   */
  readonly totalBudgetMs?: number;
}

/** A gap that grows by this much is one a blip does not pay for and an outage is spread by. */
export const DEFAULT_PAGE_BACKOFF_FACTOR = 2;

/** Full jitter on the increment: a 2× window above the floor, equal jitter's spread without its dip. */
export const DEFAULT_PAGE_JITTER_RATIO = 1;

/**
 * ADR-0326's three-attempts-two-seconds, grown, jittered and bounded.
 *
 * Recognisably the same policy — the attempt count and the first gap's floor are untouched — so a
 * deployment reading `PAGE_RETRY_ATTEMPTS` / `PAGE_RETRY_DELAY_MS` still gets what those names say.
 * Worst case: a gap of under 4s then one of under 8s, so **under 12 seconds** of waiting with no
 * provider instruction in play, and never more than `DEFAULT_PAGE_RETRY_BUDGET_MS` (30s) with one —
 * against a five-minute `sev1` acknowledgement target.
 */
export const JITTERED_PAGE_RETRY: PageRetryPolicy = {
  attempts: 3,
  delayMs: 2_000,
  backoffFactor: DEFAULT_PAGE_BACKOFF_FACTOR,
  jitterRatio: DEFAULT_PAGE_JITTER_RATIO,
  totalBudgetMs: DEFAULT_PAGE_RETRY_BUDGET_MS,
};

/**
 * The gap this policy asks for after `attemptsMade` attempts, jitter included.
 *
 * `random` must answer `[0, 1)` and is injected rather than taken from `Math.random` so that every
 * assertion about a sequence of waits is exact. A source that answers outside its contract, or not a
 * number at all, contributes **no** jitter: this value is a delay in front of somebody waiting to be
 * woken, so a broken source costs the spread and never the floor.
 */
export function pageBackoffMs(
  policy: PageRetryPolicy,
  attemptsMade: number,
  random: () => number,
): number {
  const factor = Math.max(1, policy.backoffFactor ?? 1);
  const steps = Math.max(0, Math.trunc(attemptsMade) - 1);
  const gap = policy.delayMs * Math.pow(factor, steps);
  if (!Number.isFinite(gap)) return Number.MAX_SAFE_INTEGER;
  const ratio = Math.min(1, Math.max(0, policy.jitterRatio ?? 0));
  // Not called at all at ratio 0, so a flat policy consumes no randomness — which is what makes
  // "unchanged from ADR-0326" assertable rather than merely true of the numbers.
  if (ratio === 0) return Math.trunc(gap);
  const r = random();
  const draw = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0;
  return Math.trunc(gap + gap * ratio * draw);
}

/**
 * Whether the next gap fits in what is left of the policy's total waiting budget.
 *
 * Asked **before** sleeping, and answered about the whole gap: a retry that slept the remainder and
 * then called anyway would arrive before the provider's own instruction allowed, which is ADR-0327's
 * defect in a new place. Stopping instead reports `failed`, and every escalator either re-derives its
 * finding on the next tick or has a human reading an `undelivered` line.
 */
export function fitsPageRetryBudget(
  policy: PageRetryPolicy,
  waitedMs: number,
  nextWaitMs: number,
): boolean {
  return waitedMs + nextWaitMs <= pageRetryBudgetMs(policy.totalBudgetMs);
}

/**
 * How long to wait before the next attempt.
 *
 * `max`, not a replacement, and both halves are load-bearing. The policy's delay is the platform's
 * floor, so a provider answering `Retry-After: 0` — or a date already past — cannot turn the retry
 * into a hot loop against a rate limiter. The provider's figure is the floor when it is longer,
 * because it is the one number that knows when the next attempt can succeed: ADR-0326's uniform
 * two seconds spent a `sev1`'s whole budget inside a window the provider had already said it would
 * refuse, which made the retry *less* likely to land than a single attempt.
 *
 * Its first argument is the policy's *backoff for this attempt* (`pageBackoffMs`), not the raw
 * `delayMs`, so growth and jitter compose into the floor rather than competing with the provider:
 * the longer of "what the platform will wait anyway" and "what the provider asked for" still wins.
 */
export function waitBefore(policyDelayMs: number, retryAfterMs: number | null): number {
  return Math.max(policyDelayMs, retryAfterMs ?? 0);
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
  /**
   * The jitter's source, answering `[0, 1)`. Injected for the same reason `sleep` is — a retry whose
   * waits cannot be asserted exactly is a retry nothing pins — and defaulting to `Math.random`,
   * which is the right quality here: the point is that two replicas disagree, not that nobody can
   * predict them.
   */
  readonly random?: () => number;
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

    const policy = this.opts.retry ?? NO_RETRY;
    const attempts = Math.max(1, Math.trunc(policy.attempts));
    const sleep = this.opts.sleep ?? defaultSleep;
    const random = this.opts.random ?? Math.random;
    let waited = 0;
    let outcome = await this.callOnce(invoke, sender.provider, target.kind, 1, waited);
    while (isRetryable(outcome.disposition) && outcome.attemptsMade < attempts) {
      // A provider asking for longer than the ceiling ends the retry here, with the outcome as it
      // stands. The alternative is holding the page for however long it asked, and past
      // MAX_RETRY_AFTER_MS what is being held is no longer a page — reporting `failed` hands the
      // caller back its own cadence, which for two of the three escalators re-derives the finding
      // and pages again anyway.
      if (retryAfterExceedsCeiling(outcome.retryAfterMs)) break;
      const wait = waitBefore(
        pageBackoffMs(policy, outcome.attemptsMade, random),
        outcome.retryAfterMs,
      );
      // The budget is checked against the gap it is about to sleep, not against the one it already
      // slept, so the worst case is the budget and not the budget plus one more gap.
      if (!fitsPageRetryBudget(policy, waited, wait)) break;
      await sleep(wait);
      waited += wait;
      outcome = await this.callOnce(
        invoke,
        sender.provider,
        target.kind,
        outcome.attemptsMade + 1,
        waited,
      );
    }
    return outcome;
  }

  private async callOnce(
    invoke: () => Promise<PageSendResult>,
    provider: string,
    kind: string,
    attemptsMade: number,
    waitedMs: number,
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
        // Optional on the sender's result, stated here: absent and null both mean "said nothing".
        retryAfterMs: result.retryAfterMs ?? null,
        waitedMs,
      };
    } catch (err) {
      // A sender that throws rather than returning a result. Caught per channel so one dead
      // provider cannot stop the others from being tried — and `failed`, so it is retryable.
      //
      // **A throw gets the same delay as a `failed` response, deliberately.** The tempting rule is
      // that a connection which never opened is a different signal from a provider that answered
      // 503, and so deserves its own first gap. But the dispatcher cannot see that distinction: all
      // three HTTP senders catch their own transport failures and report them *as results* with a
      // null `httpStatus` (`page-pagerduty.ts` is pinned by a test for exactly this), so a timeout
      // or a DNS failure — the case the rule is aimed at — never arrives here. What arrives here is
      // a sender that broke its own contract. Giving that its own cadence would hand the special
      // delay to a bug and the ordinary one to the network failure it was written for.
      //
      // What a throw *does* now get is the growing, jittered gap below, which is the right answer
      // to "no instruction": ADR-0327 could only fall back to a flat delay, and a flat delay is
      // what synchronised the replicas in the first place.
      return {
        kind,
        disposition: "failed",
        provider,
        httpStatus: null,
        reference: null,
        errorMessage: err instanceof Error ? err.message : String(err),
        attemptsMade,
        // A sender that threw never reached a response, so there is no instruction to honour.
        retryAfterMs: null,
        waitedMs,
      };
    }
  }
}

/** Stands in for an absent policy so the loop has one shape. One attempt, so it never waits. */
const NO_RETRY: PageRetryPolicy = { attempts: 1, delayMs: 0 };

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
    retryAfterMs: null,
    waitedMs: 0,
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
      // Only when it retried, so the common line stays as short as it was. The elapsed wait goes
      // beside the count because once the gap grows the count no longer implies it: "×3" is
      // anywhere from four seconds to the whole budget.
      `${o.attemptsMade > 1 ? ` ×${o.attemptsMade.toString()}` : ""}` +
      `${o.waitedMs > 0 ? ` over ${(o.waitedMs / 1000).toFixed(1)}s` : ""}` +
      `${o.httpStatus === null ? "" : ` http=${o.httpStatus.toString()}`}` +
      `${o.errorMessage === null ? "" : ` (${o.errorMessage})`}`,
  );
  return [head, ...lines].join("\n");
}
