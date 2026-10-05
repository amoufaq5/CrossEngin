import {
  SES_SEND_EMAIL_PATH,
  SES_SERVICE_NAME,
  parseSesErrorBody,
  sesEndpointHost,
  signAwsV4,
  truncateErrorMessage,
  type AwsCredentials,
} from "./email-ses.js";
import {
  classifyPageFailure,
  type PageContent,
  type PageSendResult,
} from "./page-pagerduty.js";
import { retryAfterFromResponse, type PageFetchLike } from "./retry-after.js";

/*
 * The fifth page transport: email over SES, closing ADR-0329's open end that `email_digest` stayed
 * `unroutable` "so a deployment with only email has no page at all and is told so once per page".
 *
 * That gap was the worst-shaped one left in the paging stack. ADR-0325's rule is that a channel the
 * alert policy **names** and the environment cannot serve is a `sev1` that will not arrive, and a
 * deployment whose only configured channel is email was exactly that: the policy named it, the
 * dispatcher reported `unroutable`, the report was logged at error, and nobody was woken. Every
 * other kind in `PAGE_CHANNEL_KINDS` has a transport; this was the hole.
 *
 * It is a *page-native* sender and not `SesEmailSender`, which is the entire point and the same
 * reasoning `SmsPageSender` was built on. That class is a `ChannelSender`: it takes a `SendRequest`
 * — a notification with a dispatch id, a tenant, a template and a recipient — and the stack around
 * it exists to **withhold** delivery on the recipient's behalf (preferences, suppressions, quiet
 * hours). A `sev1` is precisely the thing none of those may apply to. So this travels on its own
 * transport, under its own credentials, and cannot acquire a reason not to arrive.
 *
 * What *is* shared is the SigV4 signer, the endpoint host, the error parser and the message
 * truncator — four pure functions, none of which touches a `SendRequest`, a suppression or a
 * dispatch record. Reusing a pure signer is not reusing the notification path, and duplicating
 * SigV4 would create a second implementation of a cryptographic protocol to keep in step.
 *
 * On the name: the channel kind is `email_digest`, which comes from `AlertPolicy`'s vocabulary where
 * it means "batch these rather than sending each one". **A page is sent immediately anyway**, and
 * that is deliberate rather than an oversight — a digested page is not a page. The kind is the
 * routing key the policy carries; it is not an instruction about latency when what is being routed
 * is a `sev1`.
 */

/** A subject line long enough to carry the grade and the id, short enough not to be elided. */
export const MAX_PAGE_EMAIL_SUBJECT_LENGTH = 120;

/** Identifies the platform in an inbox that has no context for `INC-…`. */
export const PAGE_EMAIL_PREFIX = "CrossEngin";

/*
 * Deliberately permissive, and only a shape check. Validating an address properly is RFC 5322, which
 * nothing here needs: the address comes from the deployment's own alert policy, not from user input,
 * and the cost of a wrong one is a page that does not arrive — which SES reports and the dispatcher
 * surfaces. What this catches is the mistake that actually happens: a phone number or a `#channel`
 * pasted into `recipients` because the policy's other kinds take those.
 */
const PAGE_EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

/** `hmacSha256Hex`'s floor, which SigV4's key derivation runs through. */
const MIN_SIGNING_SECRET_BYTES = 16;

/**
 * The subject line, built **only** from `PageContent`.
 *
 * ADR-0310's rule, on the surface where it is least obvious: an email subject is rendered in a
 * notification preview on a locked phone and travels through at least one third-party mail server,
 * and often a corporate relay and a spam scanner besides. So the three inputs are an identifier the
 * platform minted, a severity from a closed vocabulary, and a label the *deployment* declared.
 * Nothing from the finding, which names a tenant uuid and a tombstone id.
 *
 * When they would overflow it is the **signal** that yields and never the incident id — `page-sms.ts`
 * reasons this through for the same decision: the label is a hint about what fired, the id is the
 * only thing a woken responder can look the detail up by.
 */
export function emailPageSubject(content: PageContent): string {
  const head = `[${PAGE_EMAIL_PREFIX} ${content.severity.toUpperCase()}]`;
  const tail = content.incidentId;
  const budget = MAX_PAGE_EMAIL_SUBJECT_LENGTH - head.length - tail.length - 2;
  const signal = budget <= 0 ? "" : content.signal.slice(0, Math.min(content.signal.length, budget));
  return signal.length === 0 ? `${head} ${tail}` : `${head} ${signal} ${tail}`;
}

/**
 * The body. Text only, and that is a decision rather than laziness.
 *
 * An HTML page would have to be escaped, and the one input that could carry markup is the
 * deployment-declared `signal` — so an HTML body would introduce an injection surface to render
 * three fields that have no formatting. Text also degrades correctly everywhere: an SMS gateway
 * forwarding a mail, a terminal mail reader, a pager bridge.
 */
export function emailPageBody(content: PageContent): string {
  return [
    `${content.severity.toUpperCase()}: ${content.signal}`,
    "",
    `Incident: ${content.incidentId}`,
    "",
    "This is an automated page. The incident record holds the detail;",
    "this message deliberately carries none of it.",
  ].join("\n");
}

export interface EmailPageSenderOptions {
  readonly region: string;
  readonly fromAddress: string;
  readonly credentials: AwsCredentials;
  readonly fetch?: PageFetchLike;
  /** Full URL, not a base — a VPC endpoint, an egress proxy, or a staging stand-in receiver. */
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  /** Injected so a test can sign deterministically; SigV4 commits to the timestamp. */
  readonly now?: () => Date;
}

export class EmailPageSender {
  readonly provider = "ses";

  private readonly opts: EmailPageSenderOptions;

  /*
   * Every refusal is at construction, which is this platform's habit and is load-bearing here: a
   * `sev1` escalation is the worst possible moment to discover that the credentials are half
   * configured. `buildPageSendersFromEnv` then leaves the transport unwired and the dispatcher
   * reports `unroutable` — a visible gap at boot rather than a page that fails at 03:14.
   */
  constructor(opts: EmailPageSenderOptions) {
    if (opts.region.trim().length === 0) {
      throw new Error("EmailPageSender: region is required");
    }
    if (!PAGE_EMAIL_PATTERN.test(opts.fromAddress)) {
      throw new Error("EmailPageSender: fromAddress must be an email address");
    }
    if (opts.credentials.accessKeyId.length === 0 || opts.credentials.secretAccessKey.length === 0) {
      throw new Error("EmailPageSender: accessKeyId and secretAccessKey are required");
    }
    // SigV4 derives its signing key through `hmacSha256Hex`, which refuses a key under 16 bytes —
    // so a short secret does not fail at construction by itself, it throws on the *first send*,
    // which is a `sev1` that reports `failed` for a reason no retry can fix. `WebhookPageSender`
    // set the precedent of refusing a too-short secret up front; the floor is the same because it
    // is the same primitive underneath. A real AWS secret access key is 40 characters, so nothing
    // legitimate is excluded.
    if (opts.credentials.secretAccessKey.length < MIN_SIGNING_SECRET_BYTES) {
      throw new Error(
        `EmailPageSender: secretAccessKey must be at least ${MIN_SIGNING_SECRET_BYTES.toString()}` +
          " characters; a shorter one cannot derive a SigV4 signing key",
      );
    }
    this.opts = opts;
  }

  /*
   * No `ConfigurationSetName` and no tags. Both are how a notification's SES event reaches
   * `bounce-webhook.ts` and becomes a `SuppressionRecord`, and a page must not feed the machinery
   * that decides not to send: a page that bounces is a deployment to fix, not an address to
   * suppress. `page-sms.ts` omits `StatusCallback` for exactly this reason.
   */
  buildPayload(content: PageContent, address: string): string {
    return JSON.stringify({
      FromEmailAddress: this.opts.fromAddress,
      Destination: { ToAddresses: [address] },
      Content: {
        Simple: {
          Subject: { Data: emailPageSubject(content), Charset: "UTF-8" },
          Body: { Text: { Data: emailPageBody(content), Charset: "UTF-8" } },
        },
      },
    });
  }

  /** `address` is the alert policy target's first `recipients` entry, per `pageAddressFor`. */
  async send(content: PageContent, address: string): Promise<PageSendResult> {
    if (!PAGE_EMAIL_PATTERN.test(address)) {
      // `rejected`, not `failed`: an identical retry cannot succeed, and the dispatcher's two
      // dispositions exist precisely so a caller can tell those apart. The reason names the
      // position and not the value — a rejected "email address" is exactly the thing that might be
      // somebody's phone number.
      return {
        outcome: "rejected",
        provider: this.provider,
        httpStatus: null,
        reference: null,
        errorMessage: "page email target is not an email address",
      };
    }

    const payload = this.buildPayload(content, address);
    const host = sesEndpointHost(this.opts.region);
    const url = this.opts.endpoint ?? `https://${host}${SES_SEND_EMAIL_PATH}`;
    const headers = signAwsV4({
      method: "POST",
      path: SES_SEND_EMAIL_PATH,
      // Signed against the real SES host even when `endpoint` points somewhere else — the same
      // choice `SesEmailSender` makes, so the two do not disagree about what a signature covers.
      // AWS recomputes the signature from the `Host` it *receives*, so a proxy that forwards the
      // request with the host preserved presents one AWS accepts; signing the proxy's host would
      // break every send through one, which is the configuration the override exists for.
      //
      // Worth knowing, because a live run through a stand-in receiver shows it: `host` is in the
      // signed header set but the `Host:` actually transmitted on *this* hop is set by the HTTP
      // client from the URL authority, not by us. That is harmless on the direct path, where the
      // two are the same string, and it means a proxy which rewrites Host rather than preserving
      // it will produce a signature AWS rejects. That is a property of the proxy, not of this code.
      host,
      payload,
      region: this.opts.region,
      service: SES_SERVICE_NAME,
      credentials: this.opts.credentials,
      now: (this.opts.now ?? ((): Date => new Date()))(),
    });

    const doFetch = this.opts.fetch ?? defaultFetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: { ...headers, accept: "application/json" },
        body: payload,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        // `classifyPageFailure`, not `classifySesFailure`. The two answer different questions: the
        // SES one yields a `DeliveryOutcome` for a *notification* and has members
        // (`bounced_hard`, `rate_limited`) that drive suppression, which a page must never reach.
        // What the dispatcher needs is the retryability split, and that is shared by all the HTTP
        // page senders — which is why 429 is `failed` here rather than a terminal refusal.
        const outcome = classifyPageFailure(response.status);
        const parsed = parseSesErrorBody(text);
        return {
          outcome,
          provider: this.provider,
          httpStatus: response.status,
          reference: null,
          errorMessage: truncateErrorMessage(parsed.message ?? parsed.type ?? text),
          retryAfterMs: retryAfterFromResponse(response, outcome === "failed"),
        };
      }
      // `delivered` means SES took custody, which is as far as a synchronous send can see — the
      // same meaning the PagerDuty, Slack and SMS senders give it. A later bounce arrives on an
      // SES event this sender deliberately does not subscribe to.
      return {
        outcome: "delivered",
        provider: this.provider,
        httpStatus: response.status,
        reference: parseMessageId(text),
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

function parseMessageId(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    const id = (parsed as { MessageId?: unknown } | null)?.MessageId;
    return typeof id === "string" && id.length > 0 ? id : null;
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
