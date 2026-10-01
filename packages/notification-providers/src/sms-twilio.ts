import {
  computeSmsSegments,
  type DeliveryOutcome,
  type NotificationChannel,
  type ProviderKind,
} from "@crossengin/notifications";

import {
  CHANNEL_MISMATCH_ERROR_CODE,
  truncateErrorMessage,
  type ChannelSender,
  type FetchLike,
  type SendRequest,
  type SendResult,
} from "./email-ses.js";

/*
 * Twilio Programmable Messaging, API version 2010-04-01:
 *   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
 * form-encoded, HTTP Basic auth. Twilio accepts either `AccountSid:AuthToken` or, preferred,
 * `ApiKeySid:ApiKeySecret` for the same account — an API key can be revoked without rotating the
 * account's auth token, and the auth token is also the key Twilio signs status callbacks with.
 *
 * A deployment must supply: the Account SID, one credential pair (API key sid + secret, or the
 * auth token), and exactly one sender identity — a `fromNumber` in E.164 or a
 * `messagingServiceSid`. A `statusCallbackUrl` is optional but is what makes delivery and
 * carrier-failure events reach `bounce-webhook.ts` at all.
 */

export const TWILIO_API_BASE_URL = "https://api.twilio.com";
export const TWILIO_API_VERSION = "2010-04-01";

export function twilioMessagesPath(accountSid: string): string {
  return `/${TWILIO_API_VERSION}/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
}

/** Flat `application/x-www-form-urlencoded`, which is all the Messages resource takes. */
export function encodeTwilioForm(
  form: Readonly<Record<string, string | number | undefined>>,
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(form)) {
    if (value === undefined) continue;
    parts.push(
      `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
    );
  }
  return parts.join("&");
}

export function basicAuthHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
}

// ---------------------------------------------------------------------------
// Composing the message
// ---------------------------------------------------------------------------

export type SmsComposer = (request: SendRequest) => string;

/*
 * As with email, `SendRequest` carries no rendered body. An SMS leaves the platform in cleartext
 * through a carrier network, so the default body carries no tenant data at all beyond the
 * template id — a deployment that wants more injects a composer and owns that decision.
 */
export const defaultSmsComposer: SmsComposer = (request) =>
  `CrossEngin: a notification (${request.templateId}) is waiting for you.`;

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * Twilio error codes that mean this number will never receive this message: an invalid or
 * non-mobile destination, or a recipient who replied STOP. Terminal (`bounced_hard`), so the
 * retry ladder is not spent on it. 21610 additionally becomes an `unsubscribe` suppression when
 * the same verdict arrives at the bounce webhook.
 */
export const TWILIO_PERMANENT_RECIPIENT_CODES: readonly number[] = [
  21211, 21214, 21217, 21610, 21612, 21614,
];

/**
 * Twilio error codes that mean our own configuration is wrong — bad credentials, a `From` we do
 * not own, a region we have not enabled. Retryable `failed`, following ADR-0274's rule for
 * `no_sender_configured`: the dispatch must survive so that fixing the configuration delivers it.
 */
export const TWILIO_CONFIGURATION_CODES: readonly number[] = [
  20003, 20404, 21219, 21408, 21606, 21611, 21659, 30002,
];

export const TWILIO_THROTTLE_CODES: readonly number[] = [20429, 31206, 63018];

/** `DeliveryAttemptSchema` accepts 0–20 segments; see the clamp in `send`. */
export const MAX_SMS_SEGMENTS = 20;

/** Statuses on a 2xx that mean Twilio has taken custody of the message. */
export const TWILIO_ACCEPTED_STATUSES: readonly string[] = [
  "accepted",
  "scheduled",
  "queued",
  "sending",
  "sent",
  "delivered",
];

export interface TwilioFailureClassification {
  readonly outcome: DeliveryOutcome;
  readonly errorCode: string;
}

/**
 * Same shape of rule as SES, over Twilio's numeric codes:
 *
 * - 429, or a throttle code → `rate_limited` (retryable).
 * - 5xx → `failed` (retryable): Twilio decided nothing, so neither do we.
 * - a permanent-recipient code → `bounced_hard` (terminal).
 * - a configuration code, or 401/403 → `failed` (retryable), per ADR-0274.
 * - any other 4xx → `dropped` (terminal): the identical retry cannot succeed.
 */
export function classifyTwilioFailure(
  status: number,
  code: number | null,
): TwilioFailureClassification {
  const suffix = code === null ? "error" : String(code);
  if (status === 429 || (code !== null && TWILIO_THROTTLE_CODES.includes(code))) {
    return { outcome: "rate_limited", errorCode: `twilio_${suffix}` };
  }
  if (status >= 500) {
    return { outcome: "failed", errorCode: `twilio_${code === null ? "server_error" : suffix}` };
  }
  if (code !== null && TWILIO_PERMANENT_RECIPIENT_CODES.includes(code)) {
    return { outcome: "bounced_hard", errorCode: `twilio_${suffix}` };
  }
  if (
    (code !== null && TWILIO_CONFIGURATION_CODES.includes(code)) ||
    status === 401 ||
    status === 403
  ) {
    return {
      outcome: "failed",
      errorCode: `twilio_${code === null ? "not_authorized" : suffix}`,
    };
  }
  return { outcome: "dropped", errorCode: `twilio_${suffix}` };
}

export interface TwilioErrorBody {
  readonly code: number | null;
  readonly message: string | null;
}

export function parseTwilioErrorBody(body: string): TwilioErrorBody {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const rawCode = parsed["code"];
    const rawMessage = parsed["message"];
    return {
      code: typeof rawCode === "number" && Number.isFinite(rawCode) ? rawCode : null,
      message:
        typeof rawMessage === "string" && rawMessage.length > 0 ? rawMessage : null,
    };
  } catch {
    return { code: null, message: null };
  }
}

// ---------------------------------------------------------------------------
// The sender
// ---------------------------------------------------------------------------

/**
 * `SendResult` has no `smsSegments`, but `DeliveryAttemptSchema` requires one for a delivered SMS
 * (today the app defaults it to 1). This widening is the one ADR-0274 predicted; the extra field
 * is structurally assignable to `SendResult`, so the app can read it the day it widens the seam
 * and ignore it until then.
 */
export interface SmsSendResult extends SendResult {
  readonly smsSegments: number | null;
}

export interface TwilioSmsSenderOptions {
  readonly accountSid: string;
  readonly authToken?: string;
  readonly apiKeySid?: string;
  readonly apiKeySecret?: string;
  readonly fromNumber?: string;
  readonly messagingServiceSid?: string;
  readonly statusCallbackUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly baseUrl?: string;
  readonly compose?: SmsComposer;
}

export class TwilioSmsSender implements ChannelSender {
  readonly channel: NotificationChannel = "sms";
  readonly provider: ProviderKind = "twilio";

  private readonly accountSid: string;
  private readonly authUser: string;
  private readonly authPass: string;
  private readonly fromNumber: string | null;
  private readonly messagingServiceSid: string | null;
  private readonly statusCallbackUrl: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly compose: SmsComposer;

  constructor(opts: TwilioSmsSenderOptions) {
    if (opts.accountSid.length === 0) {
      throw new Error("TwilioSmsSender: accountSid is required");
    }
    const hasApiKey =
      opts.apiKeySid !== undefined && opts.apiKeySecret !== undefined;
    const hasAuthToken = opts.authToken !== undefined && opts.authToken.length > 0;
    if (!hasApiKey && !hasAuthToken) {
      throw new Error(
        "TwilioSmsSender: supply either apiKeySid + apiKeySecret or authToken",
      );
    }
    if (
      (opts.fromNumber === undefined) ===
      (opts.messagingServiceSid === undefined)
    ) {
      throw new Error(
        "TwilioSmsSender: supply exactly one of fromNumber or messagingServiceSid",
      );
    }
    this.accountSid = opts.accountSid;
    this.authUser = hasApiKey ? (opts.apiKeySid as string) : opts.accountSid;
    this.authPass = hasApiKey
      ? (opts.apiKeySecret as string)
      : (opts.authToken as string);
    this.fromNumber = opts.fromNumber ?? null;
    this.messagingServiceSid = opts.messagingServiceSid ?? null;
    this.statusCallbackUrl = opts.statusCallbackUrl ?? null;
    this.fetchImpl =
      opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.baseUrl = opts.baseUrl ?? TWILIO_API_BASE_URL;
    this.compose = opts.compose ?? defaultSmsComposer;
  }

  /** The composed body is returned alongside the form so segments are counted from the message. */
  buildRequestBody(request: SendRequest): {
    readonly form: string;
    readonly bodyBytes: number;
  } {
    const body = this.compose(request);
    const form = encodeTwilioForm({
      To: request.recipientAddress,
      ...(this.fromNumber !== null ? { From: this.fromNumber } : {}),
      ...(this.messagingServiceSid !== null
        ? { MessagingServiceSid: this.messagingServiceSid }
        : {}),
      Body: body,
      ...(this.statusCallbackUrl !== null
        ? { StatusCallback: this.statusCallbackUrl }
        : {}),
    });
    return { form, bodyBytes: Buffer.byteLength(body, "utf8") };
  }

  async send(request: SendRequest): Promise<SmsSendResult> {
    if (request.channel !== "sms") {
      return {
        outcome: "failed",
        provider: this.provider,
        providerMessageId: null,
        httpStatus: null,
        bytesSent: null,
        smsSegments: null,
        errorCode: CHANNEL_MISMATCH_ERROR_CODE,
        errorMessage: truncateErrorMessage(
          `twilio sender cannot send channel ${request.channel}`,
        ),
      };
    }

    const { form, bodyBytes } = this.buildRequestBody(request);
    const bytesSent = Buffer.byteLength(form, "utf8");

    // As in the SES sender, a transport failure propagates: the drain's `sendWithTimeout` records
    // `failed` / `sender_threw` and retries, so no code is invented for "the socket died".
    const response = await this.fetchImpl(
      `${this.baseUrl}${twilioMessagesPath(this.accountSid)}`,
      {
        method: "POST",
        headers: {
          authorization: basicAuthHeader(this.authUser, this.authPass),
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: form,
      },
    );
    const text = await response.text();

    if (!response.ok) {
      const parsed = parseTwilioErrorBody(text);
      const classified = classifyTwilioFailure(response.status, parsed.code);
      return {
        outcome: classified.outcome,
        provider: this.provider,
        providerMessageId: null,
        httpStatus: response.status,
        bytesSent,
        smsSegments: null,
        errorCode: classified.errorCode,
        errorMessage: truncateErrorMessage(
          parsed.message ??
            `Twilio responded ${response.status.toString()} with no message`,
        ),
      };
    }

    let sid: string | null = null;
    let status: string | null = null;
    let segments: number | null = null;
    let syncErrorCode: number | null = null;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const rawSid = parsed["sid"];
      if (typeof rawSid === "string" && rawSid.length > 0) sid = rawSid;
      const rawStatus = parsed["status"];
      if (typeof rawStatus === "string") status = rawStatus;
      const rawSegments = parsed["num_segments"];
      const parsedSegments =
        typeof rawSegments === "number"
          ? rawSegments
          : typeof rawSegments === "string"
            ? Number.parseInt(rawSegments, 10)
            : Number.NaN;
      if (Number.isInteger(parsedSegments) && parsedSegments >= 0) {
        // `DeliveryAttemptSchema` caps smsSegments at 20; a higher count would make the attempt
        // row unwritable, so it is clamped rather than lost along with the whole audit entry.
        segments = Math.min(parsedSegments, MAX_SMS_SEGMENTS);
      }
      const rawCode = parsed["error_code"];
      if (typeof rawCode === "number") syncErrorCode = rawCode;
      if (typeof rawCode === "string" && rawCode.length > 0) {
        const n = Number.parseInt(rawCode, 10);
        if (Number.isInteger(n)) syncErrorCode = n;
      }
    } catch {
      // A 2xx with an unreadable body still means Twilio accepted the message.
    }

    // A 2xx whose status is a failure is Twilio reporting an immediate carrier rejection; its
    // error_code decides the outcome exactly as a 4xx body would.
    if (status !== null && !TWILIO_ACCEPTED_STATUSES.includes(status)) {
      const classified = classifyTwilioFailure(400, syncErrorCode);
      return {
        outcome: classified.outcome,
        provider: this.provider,
        providerMessageId: sid,
        httpStatus: response.status,
        bytesSent,
        smsSegments: segments,
        errorCode: classified.errorCode,
        errorMessage: truncateErrorMessage(
          `Twilio returned message status ${status}`,
        ),
      };
    }

    // `delivered` here means "accepted by the provider", which is as far as a synchronous send
    // can see: Twilio confirms or disconfirms carrier delivery later, on the status callback that
    // bounce-webhook.ts verifies. Treating acceptance as anything retryable would re-send a
    // message the recipient has already received.
    return {
      outcome: "delivered",
      provider: this.provider,
      providerMessageId: sid,
      httpStatus: response.status,
      bytesSent,
      smsSegments:
        segments ?? Math.min(computeSmsSegments(bodyBytes), MAX_SMS_SEGMENTS),
      errorCode: null,
      errorMessage: null,
    };
  }
}
