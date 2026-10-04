import { truncateErrorMessage } from "./email-ses.js";
import { retryAfterFromResponse, type PageFetchLike } from "./retry-after.js";

/*
 * PagerDuty Events API v2:
 *   POST https://events.pagerduty.com/v2/enqueue
 * JSON, no auth header — the `routing_key` in the body *is* the credential, and it is the
 * integration key of a PagerDuty service. That is why this is the one page channel that needs
 * nothing configured beyond the alert policy: `AlertChannelTarget` already carries `serviceKey`.
 */

export const PAGERDUTY_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue";

/** `critical` and `error` are the two this platform uses; PagerDuty also accepts warning/info. */
export const PAGERDUTY_SEVERITIES = ["critical", "error", "warning", "info"] as const;
export type PagerDutySeverity = (typeof PAGERDUTY_SEVERITIES)[number];

export const PAGE_DELIVERY_OUTCOMES = ["delivered", "rejected", "failed"] as const;
export type PageDeliveryOutcome = (typeof PAGE_DELIVERY_OUTCOMES)[number];

/** `Too Many Requests`: the one 4xx that means "ask again", not "no". */
export const PAGE_RATE_LIMIT_STATUS = 429;

/**
 * A non-2xx page response, classified for the dispatcher's retry rule.
 *
 * The split is the whole reason `rejected` and `failed` are different outcomes: `failed` is retried
 * and `rejected` is not, because resending a refusal only collects it again. So **429 must be
 * `failed`** — PagerDuty's Events API and Slack's `chat.postMessage` both answer 429 with a
 * `Retry-After` under load, which is the canonical retryable condition, and classifying it with the
 * other 4xx made the retry unable to help in precisely the case it exists for. Found by review rather
 * than by a test, because every sender had the same wrong rule and the tests agreed with them.
 *
 * Shared by all three transports so a page cannot behave differently per channel.
 */
export function classifyPageFailure(status: number): PageDeliveryOutcome {
  if (status === PAGE_RATE_LIMIT_STATUS) return "failed";
  return status >= 400 && status < 500 ? "rejected" : "failed";
}

export interface PageSendResult {
  readonly outcome: PageDeliveryOutcome;
  readonly provider: string;
  readonly httpStatus: number | null;
  readonly reference: string | null;
  readonly errorMessage: string | null;
  /**
   * What the provider's `Retry-After` asked for, in milliseconds, when the outcome is retryable.
   *
   * **Optional, not required.** This interface is implemented by the senders here and by test
   * doubles across the repo, and making it required would break every one of those at once for no
   * gain — absent and `null` mean the same thing, which is that the provider said nothing.
   */
  readonly retryAfterMs?: number | null;
}

/**
 * What a page may say.
 *
 * Deliberately three fields, and the reasoning is ADR-0310's, applied to a different surface for
 * the same reason: a page leaves the platform through a third-party provider and arrives on a
 * phone's lock screen. So everything in it is either an identifier the platform minted
 * (`incidentId`), a value from a closed vocabulary (`severity`), or a label the **deployment**
 * declared at construction (`signal`). Nothing is taken from the finding that triggered it —
 * a deletion-evidence detail names a tenant uuid and a tombstone id, and an audit-integrity one
 * names a tenant's chain. The responder looks the incident up; the page only has to wake them.
 */
export interface PageContent {
  readonly incidentId: string;
  readonly severity: string;
  /** A deployment-declared label for what fired, e.g. `audit-integrity`. Never free text. */
  readonly signal: string;
}

export interface PagerDutyPageSenderOptions {
  readonly fetch?: PageFetchLike;
  readonly endpoint?: string;
  /** The `source` field PagerDuty shows on the alert. A deployment name, not tenant data. */
  readonly source?: string;
  readonly timeoutMs?: number;
}

export function pagerDutySeverityFor(severity: string): PagerDutySeverity {
  return severity === "sev1" || severity === "sev2" ? "critical" : "error";
}

/**
 * The Events API body.
 *
 * `dedup_key` is the incident id, which is the provider-level mirror of ADR-0294's once-per-episode
 * rule: PagerDuty keys an open alert on it, so re-paging the same incident updates the one alert
 * instead of opening another. The escalators already adopt rather than re-declare, and this holds
 * even if one of them ever pages twice for one episode.
 */
export function pagerDutyEventBody(
  content: PageContent,
  routingKey: string,
  source: string,
): string {
  return JSON.stringify({
    routing_key: routingKey,
    event_action: "trigger",
    dedup_key: content.incidentId,
    payload: {
      summary: `${content.signal} ${content.severity} ${content.incidentId}`,
      severity: pagerDutySeverityFor(content.severity),
      source,
      // `custom_details` is the obvious place to put the finding, and it is deliberately empty of
      // it: PagerDuty renders these into emails, SMS and push notifications.
      custom_details: { incidentId: content.incidentId, signal: content.signal },
    },
  });
}

/**
 * The resolve body, which closes the alert `pagerDutyEventBody` opened.
 *
 * Same `dedup_key`, so this closes the one alert that incident opened rather than guessing at an
 * alert id — which is the whole reason `dedup_key` is the incident id. ADR-0324 already cancels its
 * incident when the evidence is put right; without this the PagerDuty alert stayed open, so a
 * resolved finding kept a rotation awake.
 *
 * There is deliberately **no `payload`**: the Events API rejects one on a resolve, and there is
 * nothing to say anyway — the alert being closed already names the incident.
 */
export function pagerDutyResolveBody(incidentId: string, routingKey: string): string {
  return JSON.stringify({
    routing_key: routingKey,
    event_action: "resolve",
    dedup_key: incidentId,
  });
}

export class PagerDutyPageSender {
  readonly provider = "pagerduty";
  private readonly opts: PagerDutyPageSenderOptions;

  constructor(opts: PagerDutyPageSenderOptions = {}) {
    this.opts = opts;
  }

  /** `routingKey` comes from the alert policy's `serviceKey`, per channel target. */
  async send(content: PageContent, routingKey: string): Promise<PageSendResult> {
    return this.post(
      pagerDutyEventBody(content, routingKey, this.opts.source ?? "crossengin"),
      content.incidentId,
    );
  }

  /**
   * Close this incident's alert. The counterpart to `send`, and the reason `PageChannelSender`'s
   * `resolve` is optional: PagerDuty is the only one of the three transports that holds open state
   * a later call can close. A posted Slack message cannot be unposted.
   */
  async resolve(incidentId: string, routingKey: string): Promise<PageSendResult> {
    return this.post(pagerDutyResolveBody(incidentId, routingKey), incidentId);
  }

  private async post(body: string, dedupKey: string): Promise<PageSendResult> {
    const url = this.opts.endpoint ?? PAGERDUTY_EVENTS_URL;
    const doFetch = this.opts.fetch ?? defaultFetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        const outcome = classifyPageFailure(response.status);
        return {
          outcome,
          provider: this.provider,
          httpStatus: response.status,
          reference: null,
          errorMessage: truncateErrorMessage(text),
          retryAfterMs: retryAfterFromResponse(response, outcome === "failed"),
        };
      }
      return {
        outcome: "delivered",
        provider: this.provider,
        httpStatus: response.status,
        reference: parseDedupKey(text) ?? dedupKey,
        errorMessage: null,
      };
    } catch (err) {
      // A timeout or a DNS failure. `failed` rather than `rejected`: retrying may work. The
      // sender never retries on its own — the dispatcher owns that policy, because only it sees
      // the whole directive and the caller's cadence (ADR-0325).
      return {
        outcome: "failed",
        provider: this.provider,
        httpStatus: null,
        reference: null,
        errorMessage: truncateErrorMessage(err instanceof Error ? err.message : String(err)),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseDedupKey(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    const key = (parsed as { dedup_key?: unknown } | null)?.dedup_key;
    return typeof key === "string" && key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

const defaultFetch: PageFetchLike = async (url, init) => {
  const response = await fetch(url, init as RequestInit);
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
    // Carried through so a 429's `Retry-After` reaches the dispatcher. `Headers.get` is
    // case-insensitive, which is why the reader asks for the lowercase name.
    headers: response.headers,
  };
};
