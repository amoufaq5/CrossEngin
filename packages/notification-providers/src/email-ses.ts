import { hmacSha256Hex, sha256 } from "@crossengin/crypto";
import type {
  DeliveryOutcome,
  NotificationChannel,
  ProviderKind,
} from "@crossengin/notifications";

/*
 * The `ChannelSender` seam is declared in apps/operate-server/src/delivery-senders.ts, which a
 * package cannot import without inverting the package→app dependency. The three interfaces below
 * are therefore restated here, structurally identical, so these senders drop into the app's
 * `SenderRegistry` unchanged. They are the contract, not a parallel seam: if the app's shape ever
 * changes, the registry stops accepting these classes at compile time, which is the warning we want.
 */

export interface SendRequest {
  readonly dispatchId: string;
  readonly tenantId: string;
  readonly channel: NotificationChannel;
  readonly templateId: string;
  readonly locale: string;
  readonly recipientAddress: string;
  readonly attemptNumber: number;
}

export interface SendResult {
  readonly outcome: DeliveryOutcome;
  readonly provider: ProviderKind;
  readonly providerMessageId: string | null;
  readonly httpStatus: number | null;
  readonly bytesSent: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface ChannelSender {
  readonly channel: NotificationChannel;
  readonly provider: ProviderKind;
  send(request: SendRequest): Promise<SendResult>;
}

/** Mirrors `meta.notification_deliveries.error_message`, which caps at 500 characters. */
export const MAX_ERROR_MESSAGE_LENGTH = 500;

/** The one code we take from the app's vocabulary verbatim: a sender handed the wrong channel. */
export const CHANNEL_MISMATCH_ERROR_CODE = "channel_mismatch";

export function truncateErrorMessage(message: string): string {
  return message.length <= MAX_ERROR_MESSAGE_LENGTH
    ? message
    : message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

// ---------------------------------------------------------------------------
// AWS SigV4
// ---------------------------------------------------------------------------

/*
 * SES has no API-key or bearer scheme: the HTTPS API accepts SigV4 and nothing else (the
 * "SMTP credentials" an SES console offers are for SMTP, a different protocol on port 587/465).
 * So we sign. The whole chain is HMAC-SHA256 plus one SHA-256, both of which @crossengin/crypto
 * already provides, which is why this needs no AWS SDK and no runtime dependency at all.
 *
 * A deployment must supply: AWS_REGION, an access key id + secret access key for a principal
 * holding `ses:SendEmail` (optionally a session token for an assumed role), and a `fromAddress`
 * whose identity is verified in that region. A `configurationSetName` is also required in
 * practice, because it is the configuration set's event destination that forwards bounces and
 * complaints to the endpoint `bounce-webhook.ts` serves.
 */

export const AWS_SIGV4_ALGORITHM = "AWS4-HMAC-SHA256";
export const SES_SERVICE_NAME = "ses";
export const SES_SEND_EMAIL_PATH = "/v2/email/outbound-emails";

/** `Buffer` is the only way to turn crypto's hex digest back into the key bytes of the next HMAC. */
function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface AmzDateStamps {
  /** `20260101T091500Z` — the `x-amz-date` header and the second line of the string to sign. */
  readonly amzDate: string;
  /** `20260101` — the first element of the credential scope. */
  readonly dateStamp: string;
}

export function amzDateStamps(now: Date): AmzDateStamps {
  const iso = now.toISOString();
  const amzDate = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export function credentialScope(
  dateStamp: string,
  region: string,
  service: string,
): string {
  return `${dateStamp}/${region}/${service}/aws4_request`;
}

export interface CanonicalHeaders {
  readonly canonical: string;
  readonly signed: string;
}

/**
 * SigV4 signs headers lowercased, trimmed, and sorted by name — not in the order we happen to
 * send them. Getting the order wrong is the classic `SignatureDoesNotMatch`.
 */
export function canonicalizeHeaders(
  headers: Readonly<Record<string, string>>,
): CanonicalHeaders {
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const lowered = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    lowered.set(name.toLowerCase(), value.trim().replace(/\s+/g, " "));
  }
  const canonical = names
    .map((name) => `${name}:${lowered.get(name) ?? ""}\n`)
    .join("");
  return { canonical, signed: names.join(";") };
}

export function buildCanonicalRequest(input: {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: string;
}): { readonly canonicalRequest: string; readonly signedHeaders: string } {
  const { canonical, signed } = canonicalizeHeaders(input.headers);
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.path,
    input.query,
    canonical,
    signed,
    sha256(input.payload),
  ].join("\n");
  return { canonicalRequest, signedHeaders: signed };
}

export function buildStringToSign(input: {
  readonly amzDate: string;
  readonly scope: string;
  readonly canonicalRequest: string;
}): string {
  return [
    AWS_SIGV4_ALGORITHM,
    input.amzDate,
    input.scope,
    sha256(input.canonicalRequest),
  ].join("\n");
}

export function deriveSigningKeyHex(input: {
  readonly secretAccessKey: string;
  readonly dateStamp: string;
  readonly region: string;
  readonly service: string;
}): string {
  const kSecret = new TextEncoder().encode(`AWS4${input.secretAccessKey}`);
  const kDate = hmacSha256Hex(kSecret, input.dateStamp);
  const kRegion = hmacSha256Hex(hexToBytes(kDate), input.region);
  const kService = hmacSha256Hex(hexToBytes(kRegion), input.service);
  return hmacSha256Hex(hexToBytes(kService), "aws4_request");
}

export interface SignAwsV4Input {
  readonly method: string;
  readonly path: string;
  readonly query?: string;
  readonly host: string;
  readonly payload: string;
  readonly region: string;
  readonly service: string;
  readonly credentials: AwsCredentials;
  readonly now: Date;
  readonly contentType?: string;
}

/**
 * Returns the full header set for one signed request, including `authorization`. The headers it
 * signs are exactly the headers it returns, so a caller cannot accidentally sign a set it does
 * not send.
 */
export function signAwsV4(input: SignAwsV4Input): Record<string, string> {
  const { amzDate, dateStamp } = amzDateStamps(input.now);
  const payloadHash = sha256(input.payload);
  const signable: Record<string, string> = {
    "content-type": input.contentType ?? "application/json",
    host: input.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (input.credentials.sessionToken !== undefined) {
    // A session token must be signed, not merely sent, or STS-issued credentials never verify.
    signable["x-amz-security-token"] = input.credentials.sessionToken;
  }
  const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
    method: input.method,
    path: input.path,
    query: input.query ?? "",
    headers: signable,
    payload: input.payload,
  });
  const scope = credentialScope(dateStamp, input.region, input.service);
  const stringToSign = buildStringToSign({ amzDate, scope, canonicalRequest });
  const signingKey = deriveSigningKeyHex({
    secretAccessKey: input.credentials.secretAccessKey,
    dateStamp,
    region: input.region,
    service: input.service,
  });
  const signature = hmacSha256Hex(hexToBytes(signingKey), stringToSign);
  return {
    ...signable,
    authorization:
      `${AWS_SIGV4_ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// ---------------------------------------------------------------------------
// Composing the message
// ---------------------------------------------------------------------------

export interface ComposedEmail {
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody?: string;
}

export type EmailComposer = (request: SendRequest) => ComposedEmail;

/*
 * `SendRequest` carries a template id and a locale but no rendered body — ADR-0274's drain never
 * renders one — so content enters the stack here. The default deliberately carries no tenant
 * data beyond identifiers: an email body is the one place in this system where a classified
 * field would leave the platform unredacted, so the fallback points at the in-app notice instead
 * of reproducing it. A deployment that wants real bodies injects its own composer.
 */
export const defaultEmailComposer: EmailComposer = (request) => ({
  subject: `CrossEngin notification: ${request.templateId}`,
  textBody:
    `A notification (${request.templateId}) is waiting for you in CrossEngin.\n\n` +
    `Reference: ${request.dispatchId}\n`,
});

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * SES exception names that mean this recipient will never accept mail. They become `bounced_hard`,
 * which is terminal, so the drain stops rather than burning the retry ladder on an address that
 * cannot work.
 */
export const SES_PERMANENT_RECIPIENT_TYPES: readonly string[] = [
  "MessageRejected",
];

/**
 * SES exception names that mean *our* configuration is wrong, not the recipient's address. These
 * become retryable `failed`, following ADR-0274's rule for `no_sender_configured`: fixing the
 * configuration and re-draining should deliver, so the dispatch must still be alive to deliver.
 */
export const SES_CONFIGURATION_TYPES: readonly string[] = [
  "AccountSuspendedException",
  "SendingPausedException",
  "MailFromDomainNotVerifiedException",
  "NotFoundException",
  "AccessDeniedException",
  "UnrecognizedClientException",
  "InvalidSignatureException",
  "InvalidClientTokenId",
  "ExpiredTokenException",
];

export const SES_THROTTLE_TYPES: readonly string[] = [
  "TooManyRequestsException",
  "LimitExceededException",
  "ThrottlingException",
];

export interface SesFailureClassification {
  readonly outcome: DeliveryOutcome;
  readonly errorCode: string;
}

function snakeCode(type: string): string {
  return type
    .replace(/Exception$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .slice(0, 60);
}

/**
 * The classification rule, in order of certainty:
 *
 * - 429 or a throttle exception → `rate_limited` (retryable).
 * - 5xx → `failed` (retryable): SES did not decide anything, so neither do we.
 * - a named permanent-recipient exception → `bounced_hard` (terminal).
 * - a named configuration exception, or 401/403 → `failed` (retryable), per ADR-0274.
 * - any other 4xx → `dropped` (terminal). SES has definitively refused *this request*, and the
 *   retry would be byte-identical; re-sending it is the one thing we know will not help. Failing
 *   closed here means not re-sending, not "assume it was transient".
 */
export function classifySesFailure(
  status: number,
  errorType: string | null,
): SesFailureClassification {
  const type = errorType ?? "";
  if (status === 429 || SES_THROTTLE_TYPES.includes(type)) {
    return {
      outcome: "rate_limited",
      errorCode: `ses_${type === "" ? "throttled" : snakeCode(type)}`,
    };
  }
  if (status >= 500) {
    return { outcome: "failed", errorCode: "ses_server_error" };
  }
  if (SES_PERMANENT_RECIPIENT_TYPES.includes(type)) {
    return { outcome: "bounced_hard", errorCode: `ses_${snakeCode(type)}` };
  }
  if (
    SES_CONFIGURATION_TYPES.includes(type) ||
    status === 401 ||
    status === 403
  ) {
    return {
      outcome: "failed",
      errorCode: `ses_${type === "" ? "not_authorized" : snakeCode(type)}`,
    };
  }
  return {
    outcome: "dropped",
    errorCode: `ses_${type === "" ? "rejected" : snakeCode(type)}`,
  };
}

export interface SesErrorBody {
  readonly type: string | null;
  readonly message: string | null;
}

/** SES v2 reports the exception name in `__type` (sometimes `#`-prefixed) or in `code`. */
export function parseSesErrorBody(body: string): SesErrorBody {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const rawType = parsed["__type"] ?? parsed["code"] ?? parsed["Code"];
    const rawMessage = parsed["message"] ?? parsed["Message"];
    const type =
      typeof rawType === "string" && rawType.length > 0
        ? (rawType.split("#").pop() ?? rawType)
        : null;
    return {
      type,
      message:
        typeof rawMessage === "string" && rawMessage.length > 0
          ? rawMessage
          : null,
    };
  } catch {
    return { type: null, message: null };
  }
}

// ---------------------------------------------------------------------------
// The sender
// ---------------------------------------------------------------------------

export function sesEndpointHost(region: string): string {
  return `email.${region}.amazonaws.com`;
}

/** SES rejects a tag value outside this set, which would turn a good send into a 400. */
function sanitizeTagValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256);
}

export interface SesEmailSenderOptions {
  readonly region: string;
  readonly credentials: AwsCredentials;
  readonly fromAddress: string;
  readonly fromName?: string;
  /** The configuration set whose event destination feeds `bounce-webhook.ts`. */
  readonly configurationSetName?: string;
  readonly fetchImpl?: FetchLike;
  /** Overridden for a VPC endpoint, or by a test. */
  readonly baseUrl?: string;
  readonly clock?: () => Date;
  readonly compose?: EmailComposer;
}

export class SesEmailSender implements ChannelSender {
  readonly channel: NotificationChannel = "email";
  readonly provider: ProviderKind = "ses";

  private readonly region: string;
  private readonly credentials: AwsCredentials;
  private readonly fromAddress: string;
  private readonly fromName: string | null;
  private readonly configurationSetName: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly clock: () => Date;
  private readonly compose: EmailComposer;

  constructor(opts: SesEmailSenderOptions) {
    if (opts.region.length === 0) {
      throw new Error("SesEmailSender: region is required");
    }
    if (opts.credentials.accessKeyId.length === 0) {
      throw new Error("SesEmailSender: credentials.accessKeyId is required");
    }
    // hmacSha256Hex refuses a key under 16 bytes, and the signing chain starts at
    // "AWS4" + secret — so a secret this short cannot sign anything and must fail at
    // construction rather than on the first send.
    if (opts.credentials.secretAccessKey.length < 12) {
      throw new Error(
        "SesEmailSender: credentials.secretAccessKey must be at least 12 characters",
      );
    }
    if (opts.fromAddress.length === 0) {
      throw new Error("SesEmailSender: fromAddress is required");
    }
    this.region = opts.region;
    this.credentials = opts.credentials;
    this.fromAddress = opts.fromAddress;
    this.fromName = opts.fromName ?? null;
    this.configurationSetName = opts.configurationSetName ?? null;
    this.fetchImpl =
      opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.baseUrl = opts.baseUrl ?? `https://${sesEndpointHost(opts.region)}`;
    this.clock = opts.clock ?? ((): Date => new Date());
    this.compose = opts.compose ?? defaultEmailComposer;
  }

  fromHeaderValue(): string {
    return this.fromName === null
      ? this.fromAddress
      : `${this.fromName} <${this.fromAddress}>`;
  }

  buildPayload(request: SendRequest): string {
    const message = this.compose(request);
    const body: Record<string, unknown> = {
      Text: { Data: message.textBody, Charset: "UTF-8" },
    };
    if (message.htmlBody !== undefined) {
      body["Html"] = { Data: message.htmlBody, Charset: "UTF-8" };
    }
    const payload: Record<string, unknown> = {
      FromEmailAddress: this.fromHeaderValue(),
      Destination: { ToAddresses: [request.recipientAddress] },
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: "UTF-8" },
          Body: body,
        },
      },
      // These tags come back on every bounce and complaint event, which is how a suppression
      // planned from the webhook can be attributed to the dispatch that caused it.
      EmailTags: [
        { Name: "dispatch_id", Value: sanitizeTagValue(request.dispatchId) },
        { Name: "tenant_id", Value: sanitizeTagValue(request.tenantId) },
        {
          Name: "attempt",
          Value: sanitizeTagValue(String(request.attemptNumber)),
        },
      ],
    };
    if (this.configurationSetName !== null) {
      payload["ConfigurationSetName"] = this.configurationSetName;
    }
    return JSON.stringify(payload);
  }

  async send(request: SendRequest): Promise<SendResult> {
    if (request.channel !== "email") {
      return {
        outcome: "failed",
        provider: this.provider,
        providerMessageId: null,
        httpStatus: null,
        bytesSent: null,
        errorCode: CHANNEL_MISMATCH_ERROR_CODE,
        errorMessage: truncateErrorMessage(
          `ses sender cannot send channel ${request.channel}`,
        ),
      };
    }

    const payload = this.buildPayload(request);
    const bytesSent = Buffer.byteLength(payload, "utf8");
    const headers = signAwsV4({
      method: "POST",
      path: SES_SEND_EMAIL_PATH,
      host: sesEndpointHost(this.region),
      payload,
      region: this.region,
      service: SES_SERVICE_NAME,
      credentials: this.credentials,
      now: this.clock(),
    });

    // A transport failure is the one case we do not classify: there is no provider verdict to
    // classify. It propagates, and the drain's `sendWithTimeout` records it as
    // `failed` / `sender_threw` and schedules a retry — the existing ladder, unextended.
    const response = await this.fetchImpl(
      `${this.baseUrl}${SES_SEND_EMAIL_PATH}`,
      { method: "POST", headers, body: payload },
    );
    const text = await response.text();

    if (!response.ok) {
      const parsed = parseSesErrorBody(text);
      const classified = classifySesFailure(response.status, parsed.type);
      return {
        outcome: classified.outcome,
        provider: this.provider,
        providerMessageId: null,
        httpStatus: response.status,
        bytesSent,
        errorCode: classified.errorCode,
        errorMessage: truncateErrorMessage(
          parsed.message ??
            `SES responded ${response.status.toString()} with no message`,
        ),
      };
    }

    let messageId: string | null = null;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const raw = parsed["MessageId"];
      if (typeof raw === "string" && raw.length > 0) messageId = raw;
    } catch {
      // A 200 with an unreadable body still means SES accepted the message; the only loss is
      // the provider message id, which the audit row records as null.
    }

    return {
      outcome: "delivered",
      provider: this.provider,
      providerMessageId: messageId,
      httpStatus: response.status,
      bytesSent,
      errorCode: null,
      errorMessage: null,
    };
  }
}
