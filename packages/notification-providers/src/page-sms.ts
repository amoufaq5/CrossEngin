import { truncateErrorMessage } from "./email-ses.js";
import {
  classifyPageFailure,
  type PageContent,
  type PageSendResult,
} from "./page-pagerduty.js";
import { retryAfterFromResponse, type PageFetchLike } from "./retry-after.js";
import {
  basicAuthHeader,
  encodeTwilioForm,
  TWILIO_API_BASE_URL,
  twilioMessagesPath,
} from "./sms-twilio.js";

/*
 * The fourth page transport: SMS over Twilio's Messages resource, closing ADR-0325's open question
 * that `sms` was `unroutable` while "the senders that could serve it are one package away".
 *
 * It is a *page-native* sender and not `TwilioSmsSender`, which is the whole point. That class is a
 * `ChannelSender`: it takes a `SendRequest` — a notification with a dispatch id, a tenant, a
 * template and a recipient — and the stack around it exists to **withhold** delivery on the
 * recipient's behalf (preferences, suppressions, quiet hours). A `sev1` page is precisely the thing
 * none of those may apply to, so it travels on its own transport and cannot acquire a reason not to
 * arrive (ADR-0325).
 *
 * What *is* shared is three pure functions — the form encoder, the basic-auth header and the
 * account-scoped path. Reusing a pure encoder is not reusing the notification path: none of them
 * touches a `SendRequest`, a suppression or a dispatch record, and duplicating them would only
 * create a second spelling of `application/x-www-form-urlencoded` to keep in step.
 */

/** A page is one GSM-7 segment, so a carrier cannot split or drop part of it. */
export const MAX_PAGE_SMS_CHARACTERS = 160;

/** Identifies the platform on a phone that has no context for `INC-…`. */
export const PAGE_SMS_PREFIX = "CrossEngin";

/*
 * Twilio takes E.164 only, and a page is not the moment to find that out: a malformed `From` is a
 * deployment defect that every page would hit, so it is refused at construction with the
 * credentials. The destination is checked per send because the dispatcher supplies it from the
 * alert policy.
 */
const E164_PAGE_PATTERN = /^\+[1-9]\d{6,14}$/;

/**
 * The page body.
 *
 * Built **only** from `PageContent` — ADR-0310's rule, on the surface where it bites hardest: an
 * SMS crosses a carrier network in cleartext and renders on a lock screen, and unlike PagerDuty
 * there is not even a provider account between us and that. So the three inputs are an identifier
 * the platform minted, a severity from a closed vocabulary, and a label the *deployment* declared.
 * Nothing from the finding, which names a tenant uuid and a tombstone id.
 *
 * When the three together would exceed one segment it is the **signal** that yields, never the
 * incident id: the label is a hint about what fired, the id is the only thing a woken responder can
 * look the detail up by. If the prefix, severity and id alone overflow, the body is left long
 * rather than mangled — a two-segment page is a cost, a truncated id is a dead end.
 */
export function smsPageBody(content: PageContent): string {
  const head = `${PAGE_SMS_PREFIX} ${content.severity.toUpperCase()}`;
  const tail = content.incidentId;
  const budget = MAX_PAGE_SMS_CHARACTERS - head.length - tail.length - 2;
  const signal =
    budget <= 0 ? "" : content.signal.slice(0, Math.min(content.signal.length, budget));
  return signal.length === 0 ? `${head} ${tail}` : `${head} ${signal} ${tail}`;
}

export interface SmsPageSenderOptions {
  readonly accountSid: string;
  /** Preferred credential: an API key can be revoked without rotating the account's auth token. */
  readonly apiKeySid?: string;
  readonly apiKeySecret?: string;
  readonly authToken?: string;
  /** Exactly one sender identity: an E.164 number, or a messaging service. */
  readonly fromNumber?: string;
  readonly messagingServiceSid?: string;
  readonly fetch?: PageFetchLike;
  /** Full URL, not a base — a VPC endpoint, an egress proxy, or a staging stand-in receiver. */
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}

export class SmsPageSender {
  readonly provider = "twilio";

  private readonly accountSid: string;
  private readonly authUser: string;
  private readonly authPass: string;
  private readonly fromNumber: string | null;
  private readonly messagingServiceSid: string | null;
  private readonly opts: SmsPageSenderOptions;

  /*
   * Every refusal is at construction, which is this platform's habit and is load-bearing here: a
   * `sev1` escalation is the worst possible moment to discover that the credentials are half
   * configured. `buildPageSendersFromEnv` then leaves the transport unwired and the dispatcher
   * reports `unroutable` — a visible gap at boot rather than a page that fails at 03:14.
   */
  constructor(opts: SmsPageSenderOptions) {
    if (opts.accountSid.length === 0) {
      throw new Error("SmsPageSender: accountSid is required");
    }
    const hasApiKeySid = opts.apiKeySid !== undefined && opts.apiKeySid.length > 0;
    const hasApiKeySecret =
      opts.apiKeySecret !== undefined && opts.apiKeySecret.length > 0;
    if (hasApiKeySid !== hasApiKeySecret) {
      throw new Error(
        "SmsPageSender: apiKeySid and apiKeySecret must be supplied together",
      );
    }
    const hasAuthToken = opts.authToken !== undefined && opts.authToken.length > 0;
    if (!hasApiKeySid && !hasAuthToken) {
      throw new Error(
        "SmsPageSender: supply either apiKeySid + apiKeySecret or authToken",
      );
    }
    const hasFrom = opts.fromNumber !== undefined && opts.fromNumber.length > 0;
    const hasService =
      opts.messagingServiceSid !== undefined && opts.messagingServiceSid.length > 0;
    if (hasFrom === hasService) {
      throw new Error(
        "SmsPageSender: supply exactly one of fromNumber or messagingServiceSid",
      );
    }
    if (hasFrom && !E164_PAGE_PATTERN.test(opts.fromNumber as string)) {
      throw new Error("SmsPageSender: fromNumber must be in E.164 form, e.g. +15550000000");
    }

    this.accountSid = opts.accountSid;
    this.authUser = hasApiKeySid ? (opts.apiKeySid as string) : opts.accountSid;
    this.authPass = hasApiKeySid
      ? (opts.apiKeySecret as string)
      : (opts.authToken as string);
    this.fromNumber = hasFrom ? (opts.fromNumber as string) : null;
    this.messagingServiceSid = hasService ? (opts.messagingServiceSid as string) : null;
    this.opts = opts;
  }

  /*
   * No `StatusCallback`: that parameter is how a notification's carrier verdict reaches
   * `bounce-webhook.ts` and becomes a `SuppressionRecord`. A page must not feed the machinery that
   * decides not to send — a page that bounces is a deployment to fix, not a number to suppress.
   */
  buildForm(content: PageContent, phoneNumber: string): string {
    return encodeTwilioForm({
      To: phoneNumber,
      ...(this.fromNumber !== null ? { From: this.fromNumber } : {}),
      ...(this.messagingServiceSid !== null
        ? { MessagingServiceSid: this.messagingServiceSid }
        : {}),
      Body: smsPageBody(content),
    });
  }

  /** `phoneNumber` is the alert policy target's first `phoneNumbers` entry, per `pageAddressFor`. */
  async send(content: PageContent, phoneNumber: string): Promise<PageSendResult> {
    if (!E164_PAGE_PATTERN.test(phoneNumber)) {
      // `rejected`, not `failed`: an identical retry cannot succeed, and the dispatcher's two
      // dispositions exist precisely so a caller can tell those apart.
      return {
        outcome: "rejected",
        provider: this.provider,
        httpStatus: null,
        reference: null,
        errorMessage: "page sms target is not an E.164 number",
      };
    }

    const url =
      this.opts.endpoint ?? `${TWILIO_API_BASE_URL}${twilioMessagesPath(this.accountSid)}`;
    const doFetch = this.opts.fetch ?? defaultFetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          authorization: basicAuthHeader(this.authUser, this.authPass),
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: this.buildForm(content, phoneNumber),
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
      // `delivered` means Twilio took custody, which is as far as a synchronous send can see — the
      // same meaning the PagerDuty and Slack senders give it. Carrier confirmation arrives later on
      // a status callback this sender deliberately does not ask for.
      return {
        outcome: "delivered",
        provider: this.provider,
        httpStatus: response.status,
        reference: parseMessageSid(text),
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

function parseMessageSid(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    const sid = (parsed as { sid?: unknown } | null)?.sid;
    return typeof sid === "string" && sid.length > 0 ? sid : null;
  } catch {
    return null;
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
