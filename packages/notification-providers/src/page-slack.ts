import { hmacSha256Hex } from "@crossengin/crypto";

import { truncateErrorMessage } from "./email-ses.js";
import { classifyPageFailure, type PageContent, type PageSendResult } from "./page-pagerduty.js";
import { retryAfterFromResponse, type PageFetchLike } from "./retry-after.js";

/*
 * Two more page transports, both thin.
 *
 * Slack: `POST https://slack.com/api/chat.postMessage` with a bot token, because the alert policy's
 * `slack` target names a *channel* (`#ops`) rather than an incoming-webhook URL — a webhook is bound
 * to one channel at creation, so it cannot honour the policy's choice.
 *
 * Webhook: whatever URL the policy names, signed with the platform's own HMAC so the receiver can
 * tell a real page from anyone who learned the URL. Same scheme as the notification bounce webhook
 * (ADR-0302) and `workflow-signal-bridge`, so a deployment has one signature format to verify.
 */

export const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
export const PAGE_SIGNATURE_HEADER = "x-crossengin-signature";
export const PAGE_TIMESTAMP_HEADER = "x-crossengin-timestamp";
/** `hmacSha256Hex` refuses a shorter key; this is where that refusal is surfaced at boot. */
export const MIN_PAGE_SIGNING_SECRET_BYTES = 16;

export interface SlackPageSenderOptions {
  readonly botToken: string;
  readonly fetch?: PageFetchLike;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}

/** Same content rule as the PagerDuty payload: an id, a severity, a declared label. */
export function slackPageBody(content: PageContent, channel: string): string {
  return JSON.stringify({
    channel,
    text: `:rotating_light: ${content.severity.toUpperCase()} ${content.signal} — ${content.incidentId}`,
  });
}

export class SlackPageSender {
  readonly provider = "slack";
  private readonly opts: SlackPageSenderOptions;

  constructor(opts: SlackPageSenderOptions) {
    if (opts.botToken.length === 0) throw new Error("SlackPageSender needs a bot token");
    this.opts = opts;
  }

  async send(content: PageContent, channel: string): Promise<PageSendResult> {
    const doFetch = this.opts.fetch ?? defaultFetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);
    try {
      const response = await doFetch(this.opts.endpoint ?? SLACK_POST_MESSAGE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${this.opts.botToken}`,
        },
        body: slackPageBody(content, channel),
        signal: controller.signal,
      });
      const text = await response.text();
      // Slack answers 200 with `{"ok": false, "error": "..."}` for an application error, so the
      // HTTP status alone would report a page as delivered that Slack refused.
      const ok = response.ok && slackOk(text);
      if (!ok) {
        // `response.ok` with `ok: false` is an application refusal (`channel_not_found`), which no
        // retry fixes. A non-ok status goes through the shared classifier so 429 is retryable.
        const outcome = response.ok ? "rejected" : classifyPageFailure(response.status);
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
        reference: channel,
        errorMessage: null,
      };
    } catch (err) {
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

function slackOk(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return (parsed as { ok?: unknown } | null)?.ok === true;
  } catch {
    return false;
  }
}

export interface WebhookPageSenderOptions {
  /**
   * Signs the body so a receiver can tell a real page from anyone who learned the URL. At least 16
   * bytes, enforced by `hmacSha256Hex`, and checked **at construction** rather than at send time —
   * a secret too short to sign with must fail when the server boots, not when a `sev1` is paging.
   */
  readonly signingSecret?: string;
  readonly fetch?: PageFetchLike;
  readonly timeoutMs?: number;
  readonly clock?: () => Date;
}

export class WebhookPageSender {
  readonly provider = "webhook";
  private readonly opts: WebhookPageSenderOptions;
  private readonly key: Uint8Array | null;

  constructor(opts: WebhookPageSenderOptions = {}) {
    this.opts = opts;
    this.key =
      opts.signingSecret === undefined
        ? null
        : new TextEncoder().encode(opts.signingSecret);
    if (this.key !== null && this.key.length < MIN_PAGE_SIGNING_SECRET_BYTES) {
      throw new Error(
        `a page signing secret must be at least ${MIN_PAGE_SIGNING_SECRET_BYTES.toString()} bytes`,
      );
    }
  }

  async send(content: PageContent, url: string): Promise<PageSendResult> {
    const body = JSON.stringify({
      incidentId: content.incidentId,
      severity: content.severity,
      signal: content.signal,
    });
    const at = (this.opts.clock ?? ((): Date => new Date()))().toISOString();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [PAGE_TIMESTAMP_HEADER]: at,
    };
    if (this.key !== null) {
      // Over `timestamp.body`, so a captured page cannot be replayed with a new timestamp.
      headers[PAGE_SIGNATURE_HEADER] = hmacSha256Hex(this.key, `${at}.${body}`);
    }
    const doFetch = this.opts.fetch ?? defaultFetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers,
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
        reference: url,
        errorMessage: null,
      };
    } catch (err) {
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

const defaultFetch: PageFetchLike = async (url, init) => {
  const response = await fetch(url, init as RequestInit);
  // `headers` carried through so a 429's `Retry-After` reaches the dispatcher.
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
    headers: response.headers,
  };
};
