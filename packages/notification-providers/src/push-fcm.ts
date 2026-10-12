import {
  CHANNEL_CAPABILITIES,
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
 * Firebase Cloud Messaging, HTTP v1:
 *   POST https://fcm.googleapis.com/v1/projects/{projectId}/messages:send
 * JSON, `Authorization: Bearer <OAuth2 access token>`.
 *
 * The legacy `/fcm/send` endpoint took a static server key and is dead; v1 takes a short-lived
 * OAuth2 access token for a service account with the `firebase.messaging` scope. This sender does
 * not mint that token, it takes an `FcmAccessTokenProvider`, because minting one is not one request:
 * it is RS256-signing a JWT assertion with the service account's private key, POSTing it to
 * oauth2.googleapis.com, and then caching the result until a minute before its `expires_in` —
 * a second endpoint, a private key at rest, and refresh state with a clock. All three belong to the
 * app that owns the process (which already runs a JWKS refresh poller), not to a pure provider
 * client; and a deployment on GKE or Cloud Run has no key file at all, because the correct token
 * source there is the instance metadata server. Injecting the provider keeps every one of those
 * choices outside this module, and keeps this module's only dependency an injected `fetch`.
 *
 * A deployment must supply: the Firebase project id and a token provider. Nothing else — FCM has
 * no sender identity to configure (the project *is* the sender) and no status callback, because a
 * push has no asynchronous delivery receipt to send one; `UNREGISTERED` on the send is the whole
 * bounce signal, which is why this channel needs no entry in `bounce-webhook.ts`.
 */

export const FCM_API_BASE_URL = "https://fcm.googleapis.com";

export function fcmSendPath(projectId: string): string {
  return `/v1/projects/${encodeURIComponent(projectId)}/messages:send`;
}

/**
 * Returns a bearer token valid now. It may be cached; it may not be stale — a provider that returns
 * an expired token turns every send into a retryable 401, which looks exactly like a revoked
 * service account. If it throws, the throw propagates: the drain's `sendWithTimeout` records
 * `failed` / `sender_threw` and schedules a retry, which is the right answer for "the token
 * endpoint is down" and spares this module from inventing a code for it.
 */
export type FcmAccessTokenProvider = () => Promise<string>;

// ---------------------------------------------------------------------------
// The PHI-safe payload
// ---------------------------------------------------------------------------

/*
 * A push notification is the one channel in this system whose content is displayed by an operating
 * system we do not control, on a lock screen, to whoever is holding the handset, having passed
 * through Google's and (for an iOS device) Apple's servers on the way. `CHANNEL_CAPABILITIES`
 * marks it `requiresOptIn`, but opt-in is consent, not confidentiality: a patient who opted in to
 * push did not consent to their diagnosis appearing on a locked screen in a waiting room.
 *
 * So the rule here is stronger than "do not put PHI in the body", which is the kind of rule a
 * comment states and a future composer quietly breaks:
 *
 *   **Nothing in a push payload may vary with the notification's content.**
 *
 * Everything sent is either (a) one of the notices the deployment declared at construction — a
 * static per-deployment catalog, so it cannot hold one patient's data even in principle — or
 * (b) an identifier already present on the `SendRequest`. The real content is fetched afterwards
 * by the app, over the authenticated API, using the dispatch id in `data`.
 *
 * `pushPayloadViolations` checks that property against the composed payload on every single send,
 * and `send` refuses — without calling FCM — when it does not hold. That makes a composer that
 * reaches for tenant data a failed delivery with a named error code rather than a disclosure, and
 * makes the property a test rather than a comment.
 */

export interface PushNotice {
  readonly title: string;
  readonly body: string;
}

/** Deliberately content-free: a reference to a notice, and where to go to read it. */
export const DEFAULT_PUSH_NOTICE: PushNotice = {
  title: "CrossEngin",
  body: "You have a new notice. Open CrossEngin to read it.",
};

/**
 * The widest set of `data` keys a payload may carry. The default composer sends a strict subset:
 * `template_id` is permitted but not sent, because a template id names the *kind* of notice
 * (`lab_result.critical_ready` is a clinical fact about the recipient) and a deployment that adds
 * it is choosing to disclose that much. Everything here is an identifier the receiving app trades
 * for content over the authenticated API; none of it is content.
 */
export const PUSH_ALLOWED_DATA_KEYS: readonly string[] = [
  "dispatch_id",
  "tenant_id",
  "template_id",
  "locale",
  "attempt",
];

export interface ComposedPush {
  readonly notice: PushNotice;
  readonly data: Readonly<Record<string, string>>;
}

/**
 * `notice` is the catalog entry the sender already resolved for this request's locale, so a composer
 * decides the `data` ids and may swap in another *catalog* notice — it cannot author text, because
 * `pushPayloadViolations` only accepts a notice the catalog declares.
 */
export type PushComposer = (
  request: SendRequest,
  notice: PushNotice,
) => ComposedPush;

/** FCM requires every `data` value to be a string, including the attempt counter. */
export const defaultPushComposer: PushComposer = (request, notice) => ({
  notice,
  data: {
    dispatch_id: request.dispatchId,
    tenant_id: request.tenantId,
    locale: request.locale,
    attempt: String(request.attemptNumber),
  },
});

/**
 * Picks a notice by position: the catalog is ordered, and a deployment that localises it supplies
 * one notice per locale in `pushNoticeLocales` order. With a single-entry catalog — the default —
 * every locale gets it, which is correct for a string that names no content.
 */
export function noticeForLocale(
  notices: readonly PushNotice[],
  locale: string,
  locales: readonly string[] = [],
): PushNotice {
  const index = locales.indexOf(locale);
  const chosen = index >= 0 ? notices[index] : notices[0];
  return chosen ?? DEFAULT_PUSH_NOTICE;
}

export const PUSH_PAYLOAD_VIOLATIONS = [
  "title_not_in_catalog",
  "body_not_in_catalog",
  "data_key_not_allowed",
  "data_value_not_an_identifier",
  "payload_too_large",
] as const;
export type PushPayloadViolation = (typeof PUSH_PAYLOAD_VIOLATIONS)[number];

/** The identifiers a `data` value is allowed to be — the request's own, and nothing else. */
export function allowedPushDataValues(request: SendRequest): ReadonlySet<string> {
  return new Set([
    request.dispatchId,
    request.tenantId,
    request.templateId,
    request.locale,
    String(request.attemptNumber),
  ]);
}

/**
 * Every way a composed payload can fail the reference-only rule, in a stable order. Empty means the
 * payload carries no content — only catalog strings and request identifiers.
 *
 * The violations name rules, never values: a violation report that quoted the offending string
 * would carry the disclosure into an error message, a log line and an audit row, which is the
 * failure this check exists to prevent.
 */
export function pushPayloadViolations(input: {
  readonly composed: ComposedPush;
  readonly notices: readonly PushNotice[];
  readonly request: SendRequest;
  readonly serializedBytes: number;
}): readonly PushPayloadViolation[] {
  const violations: PushPayloadViolation[] = [];
  if (!input.notices.some((n) => n.title === input.composed.notice.title)) {
    violations.push("title_not_in_catalog");
  }
  if (!input.notices.some((n) => n.body === input.composed.notice.body)) {
    violations.push("body_not_in_catalog");
  }
  const allowedValues = allowedPushDataValues(input.request);
  let badKey = false;
  let badValue = false;
  for (const [key, value] of Object.entries(input.composed.data)) {
    if (!PUSH_ALLOWED_DATA_KEYS.includes(key)) badKey = true;
    if (!allowedValues.has(value)) badValue = true;
  }
  if (badKey) violations.push("data_key_not_allowed");
  if (badValue) violations.push("data_value_not_an_identifier");
  // FCM rejects a message over 4096 bytes; the channel contract carries the same number, so the
  // check is the contract's rather than a second copy of it.
  if (input.serializedBytes > CHANNEL_CAPABILITIES.push_mobile.maxBodyBytes) {
    violations.push("payload_too_large");
  }
  return violations;
}

export const PUSH_PAYLOAD_REFUSED_ERROR_CODE = "push_payload_not_reference_only";

/** A permanently-failed access-token mint: the service account is wrong, not the network. */
export const FCM_TOKEN_REFUSED_ERROR_CODE = "fcm_token_not_grantable";

/**
 * Whether a thrown token-mint failure says it is **not** worth retrying (ADR-0327).
 *
 * Checked structurally rather than against a class, so this file stays free of the token-minting
 * module: ADR-0310 made `FcmAccessTokenProvider` a seam precisely because a private key, a second
 * endpoint and a refresh cache do not belong in a pure FCM client, and importing that module back
 * for an `instanceof` would undo the separation to learn one boolean. The contract is "a provider
 * may report retryability"; a provider that reports nothing is treated as retryable, which is the
 * behaviour this had before — a transport blip must not become a dropped notification.
 */
function reportsNonRetryable(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("isRetryable" in err)) return false;
  const reporting = err as { readonly isRetryable: unknown };
  if (typeof reporting.isRetryable !== "function") return false;
  return (reporting.isRetryable as () => unknown)() === false;
}

// ---------------------------------------------------------------------------
// The recipient
// ---------------------------------------------------------------------------

export const MIN_FCM_REGISTRATION_TOKEN_LENGTH = 32;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FCM_TOKEN_CHARSET = /^[A-Za-z0-9_:.%-]+$/;

/**
 * A registration token is a long base64url-ish string minted on the device, often with a `:`
 * separating the instance id from the rest. This is a shape check, not a validity check — only FCM
 * knows whether a token is live.
 *
 * It exists for one specific failure: the serving recipient directory supplies a **user id** for
 * the `push_mobile` channel today, not a device token. Handed a UUID, FCM answers
 * `INVALID_ARGUMENT`, which classifies terminal — so a misconfigured deployment would write a
 * permanent push suppression against a user id that never had a device. Refusing the address here
 * keeps our own misconfiguration out of the suppression table.
 */
export function looksLikeFcmRegistrationToken(address: string): boolean {
  if (UUID_PATTERN.test(address)) return false;
  if (address.length < MIN_FCM_REGISTRATION_TOKEN_LENGTH) return false;
  return FCM_TOKEN_CHARSET.test(address);
}

export const PUSH_RECIPIENT_REFUSED_ERROR_CODE =
  "push_recipient_not_a_device_token";

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * FCM error codes meaning this token will never receive another message: the app was uninstalled,
 * the token was rotated, or FCM has garbage-collected it. Terminal `bounced_hard`, which is also
 * the only signal that ever suppresses a push address — there is no bounce webhook for push.
 */
export const FCM_PERMANENT_RECIPIENT_CODES: readonly string[] = [
  "UNREGISTERED",
  "NOT_FOUND",
];

/**
 * FCM error codes meaning *our* credentials or project are wrong rather than the token. Retryable
 * `failed`, per ADR-0274's `no_sender_configured` rule: fixing the configuration and re-draining
 * must still deliver, so the dispatch has to survive.
 *
 * `SENDER_ID_MISMATCH` sits here rather than with the permanent codes, where its literal meaning
 * ("this token was minted for a different Firebase project") would put it. If the project id is
 * right the token is indeed permanently unusable — but a wrong `FCM_PROJECT_ID` produces this code
 * for *every* token in the deployment, and calling it a hard bounce would suppress push for the
 * whole tenant over one environment variable. Not suppressing is the fail-closed direction.
 */
export const FCM_CONFIGURATION_CODES: readonly string[] = [
  "SENDER_ID_MISMATCH",
  "THIRD_PARTY_AUTH_ERROR",
  "APNS_AUTH_ERROR",
  "PERMISSION_DENIED",
  "UNAUTHENTICATED",
];

export const FCM_THROTTLE_CODES: readonly string[] = [
  "QUOTA_EXCEEDED",
  "RESOURCE_EXHAUSTED",
];

export interface FcmFailureClassification {
  readonly outcome: DeliveryOutcome;
  readonly errorCode: string;
}

function fcmCode(code: string): string {
  return `fcm_${code.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`.slice(0, 60);
}

/**
 * The same rule as the SES and Twilio senders, over FCM's `FcmError` codes:
 *
 * - 429, or a throttle code → `rate_limited` (retryable).
 * - 5xx → `failed` (retryable): FCM decided nothing, so neither do we.
 * - a permanent-recipient code → `bounced_hard` (terminal).
 * - a configuration code, or 401/403 → `failed` (retryable), per ADR-0274.
 * - any other 4xx → `dropped` (terminal): the identical retry cannot succeed, and `INVALID_ARGUMENT`
 *   is a malformed message of ours, not evidence about the recipient — so it must not bounce.
 *
 * Only a *named* code bounces. A bodyless 404 is not read as `UNREGISTERED` even though that is its
 * usual cause, because a wrong project id answers 404 on the path as well — and suppressing every
 * device in a deployment over an environment variable is the error worth avoiding. Without a code it
 * falls through to `dropped`: terminal for this attempt, but no suppression.
 */
/**
 * Whether FCM refused the *credential* we presented, rather than the message (ADR-0327).
 *
 * One definition, two readers: `classifyFcmFailure` turns it into an outcome, and `send` uses it to
 * discard the cached access token. Deriving it from the resulting `errorCode` instead was wrong and
 * a test caught it — the code carries the provider's own status suffix, so `PERMISSION_DENIED`
 * yields `fcm_permission_denied` and a string comparison against `fcm_not_authorized` silently
 * matched none of the suffixed cases, which is every case FCM actually names.
 */
export function fcmRefusedTheCredential(status: number, code: string | null): boolean {
  return (
    status === 401 || status === 403 || (code !== null && FCM_CONFIGURATION_CODES.includes(code))
  );
}

export function classifyFcmFailure(
  status: number,
  code: string | null,
): FcmFailureClassification {
  const suffix = code === null ? null : fcmCode(code);
  if (status === 429 || (code !== null && FCM_THROTTLE_CODES.includes(code))) {
    return { outcome: "rate_limited", errorCode: suffix ?? "fcm_throttled" };
  }
  if (status >= 500) {
    return { outcome: "failed", errorCode: suffix ?? "fcm_server_error" };
  }
  if (code !== null && FCM_PERMANENT_RECIPIENT_CODES.includes(code)) {
    return { outcome: "bounced_hard", errorCode: fcmCode(code) };
  }
  if (fcmRefusedTheCredential(status, code)) {
    return { outcome: "failed", errorCode: suffix ?? "fcm_not_authorized" };
  }
  return { outcome: "dropped", errorCode: suffix ?? "fcm_rejected" };
}

export interface FcmErrorBody {
  readonly code: string | null;
  readonly message: string | null;
}

const FCM_ERROR_DETAIL_TYPE = "type.googleapis.com/google.firebase.fcm.v1.FcmError";

/**
 * FCM v1 reports a Google API error — `{error:{code,status,message,details:[…]}}`. The precise
 * verdict is the `FcmError` detail's `errorCode` (`UNREGISTERED`); `status` is the coarser gRPC name
 * (`NOT_FOUND`). The detail is preferred and `status` is the fallback, so a response that omits the
 * detail still classifies.
 */
export function parseFcmErrorBody(body: string): FcmErrorBody {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed["error"];
    if (typeof error !== "object" || error === null || Array.isArray(error)) {
      return { code: null, message: null };
    }
    const record = error as Record<string, unknown>;
    let code: string | null = null;
    const details = record["details"];
    if (Array.isArray(details)) {
      for (const detail of details) {
        if (typeof detail !== "object" || detail === null) continue;
        const entry = detail as Record<string, unknown>;
        if (entry["@type"] !== FCM_ERROR_DETAIL_TYPE) continue;
        const raw = entry["errorCode"];
        if (typeof raw === "string" && raw.length > 0) {
          code = raw;
          break;
        }
      }
    }
    if (code === null) {
      const raw = record["status"];
      if (typeof raw === "string" && raw.length > 0) code = raw;
    }
    const rawMessage = record["message"];
    return {
      code,
      message:
        typeof rawMessage === "string" && rawMessage.length > 0
          ? rawMessage
          : null,
    };
  } catch {
    return { code: null, message: null };
  }
}

// ---------------------------------------------------------------------------
// The sender
// ---------------------------------------------------------------------------

export interface FcmPushSenderOptions {
  readonly projectId: string;
  readonly accessToken: FcmAccessTokenProvider;
  /** The declared notice catalog. Omitted means the single content-free default. */
  readonly notices?: readonly PushNotice[];
  /** Locales positionally matching `notices`; omitted means one notice for every locale. */
  readonly noticeLocales?: readonly string[];
  readonly fetchImpl?: FetchLike;
  /** Overridden for an egress proxy, or by a test. */
  readonly baseUrl?: string;
  readonly compose?: PushComposer;
  /**
   * Discards the cached access token, called when FCM itself says the credential is not accepted
   * (ADR-0327).
   *
   * A token provider caches until shortly before the token's stated expiry, so a key revoked
   * mid-lifetime leaves every send answering 401 for up to the rest of that hour — and the retry
   * budget is spent re-presenting the same dead token. One call on a `fcm_not_authorized` and the
   * next send mints a fresh one, which either works (the key was rotated) or fails at the token
   * endpoint, where the failure is *diagnosable* instead of looking like a delivery problem.
   *
   * Optional, and a no-op when omitted: a provider with no cache has nothing to discard.
   */
  readonly invalidateToken?: () => void;
}

export class FcmPushSender implements ChannelSender {
  readonly channel: NotificationChannel = "push_mobile";
  readonly provider: ProviderKind = "fcm";

  private readonly projectId: string;
  private readonly accessToken: FcmAccessTokenProvider;
  private readonly invalidateToken: (() => void) | undefined;
  private readonly notices: readonly PushNotice[];
  private readonly noticeLocales: readonly string[];
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly compose: PushComposer;

  constructor(opts: FcmPushSenderOptions) {
    if (opts.projectId.length === 0) {
      throw new Error("FcmPushSender: projectId is required");
    }
    const notices = opts.notices ?? [DEFAULT_PUSH_NOTICE];
    if (notices.length === 0) {
      // An empty catalog makes every payload fail the reference-only check, so this sender could
      // never send anything: that is a construction error, not a per-send one.
      throw new Error("FcmPushSender: notices must not be empty");
    }
    for (const notice of notices) {
      if (notice.title.length === 0 || notice.body.length === 0) {
        throw new Error("FcmPushSender: every notice needs a title and a body");
      }
    }
    if (
      opts.noticeLocales !== undefined &&
      opts.noticeLocales.length !== notices.length
    ) {
      // A short locale list would silently send the wrong language rather than failing, so the two
      // must line up positionally or not be given at all.
      throw new Error(
        "FcmPushSender: noticeLocales must have one entry per notice",
      );
    }
    this.projectId = opts.projectId;
    this.accessToken = opts.accessToken;
    this.invalidateToken = opts.invalidateToken;
    this.notices = notices;
    this.noticeLocales = opts.noticeLocales ?? [];
    this.fetchImpl =
      opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.baseUrl = opts.baseUrl ?? FCM_API_BASE_URL;
    this.compose = opts.compose ?? defaultPushComposer;
  }

  /** The catalog this sender will accept a composed notice from. */
  noticeCatalog(): readonly PushNotice[] {
    return this.notices;
  }

  composeFor(request: SendRequest): ComposedPush {
    return this.compose(
      request,
      noticeForLocale(this.notices, request.locale, this.noticeLocales),
    );
  }

  buildPayload(request: SendRequest, composed: ComposedPush): string {
    return JSON.stringify({
      message: {
        token: request.recipientAddress,
        notification: {
          title: composed.notice.title,
          body: composed.notice.body,
        },
        data: composed.data,
      },
    });
  }

  async send(request: SendRequest): Promise<SendResult> {
    if (request.channel !== "push_mobile") {
      return this.refuse(
        CHANNEL_MISMATCH_ERROR_CODE,
        `fcm sender cannot send channel ${request.channel}`,
      );
    }
    if (!looksLikeFcmRegistrationToken(request.recipientAddress)) {
      // The address is never quoted: it is a device token, and a token in an error message is a
      // token in the audit table. The length is a shape fact, not the token.
      return this.refuse(
        PUSH_RECIPIENT_REFUSED_ERROR_CODE,
        `recipient address (${request.recipientAddress.length} chars) is not shaped like an FCM registration token`,
      );
    }

    const composed = this.composeFor(request);
    const payload = this.buildPayload(request, composed);
    const bytesSent = Buffer.byteLength(payload, "utf8");
    const violations = pushPayloadViolations({
      composed,
      notices: this.notices,
      request,
      serializedBytes: bytesSent,
    });
    if (violations.length > 0) {
      // Refused before any network call: the point of the check is that the payload does not leave
      // the process. `failed` is retryable, which is right — the composer is configuration, and
      // fixing it must deliver the dispatch rather than having dropped it silently.
      return this.refuse(
        PUSH_PAYLOAD_REFUSED_ERROR_CODE,
        `composed push payload is not reference-only: ${violations.join(", ")}`,
      );
    }

    // Minting the token is the one pre-flight step that can fail *permanently* (ADR-0327). A 5xx at
    // Google's token endpoint is a transport blip and `failed` is right, because retrying delivers.
    // `invalid_grant` is a wrong or revoked service account: letting it propagate made it
    // indistinguishable from the blip, so a misconfigured deployment retried the same refusal
    // forever and the dispatch never settled. A non-retryable token error is `dropped` instead —
    // the delivery is over, the reason is on the record, and an operator fixes the credential rather
    // than watching a queue grow.
    let token: string;
    try {
      token = await this.accessToken();
    } catch (err) {
      if (reportsNonRetryable(err)) {
        return {
          ...this.refuse(
            FCM_TOKEN_REFUSED_ERROR_CODE,
            err instanceof Error ? err.message : String(err),
          ),
          outcome: "dropped",
        };
      }
      throw err;
    }
    const path = fcmSendPath(this.projectId);
    // As in the other senders, a transport failure propagates rather than being classified: there
    // is no provider verdict to classify, and the drain already records `failed` / `sender_threw`.
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: payload,
    });
    const text = await response.text();

    if (!response.ok) {
      const parsed = parseFcmErrorBody(text);
      const classified = classifyFcmFailure(response.status, parsed.code);
      if (fcmRefusedTheCredential(response.status, parsed.code)) {
        // FCM has rejected the credential we presented. Keeping it cached would re-present it on
        // every send until it expires on its own, so the retry spends its whole budget on a token
        // the provider has already refused.
        this.invalidateToken?.();
      }
      return {
        outcome: classified.outcome,
        provider: this.provider,
        providerMessageId: null,
        httpStatus: response.status,
        bytesSent,
        errorCode: classified.errorCode,
        errorMessage: truncateErrorMessage(
          parsed.message ??
            `FCM responded ${response.status.toString()} with no message`,
        ),
      };
    }

    return {
      outcome: "delivered",
      provider: this.provider,
      providerMessageId: parseFcmMessageName(text),
      httpStatus: response.status,
      bytesSent,
      errorCode: null,
      errorMessage: null,
    };
  }

  private refuse(errorCode: string, message: string): SendResult {
    return {
      outcome: "failed",
      provider: this.provider,
      providerMessageId: null,
      httpStatus: null,
      bytesSent: null,
      errorCode,
      errorMessage: truncateErrorMessage(message),
    };
  }
}

/**
 * A success body is `{"name":"projects/p/messages/0:1759…%31bd"}`. Only the id after `messages/` is
 * kept: the project prefix is the same on every row and `providerMessageId` caps at 255 characters.
 * An unreadable 200 still means FCM accepted the message; the only loss is the id.
 */
export function parseFcmMessageName(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const name = parsed["name"];
    if (typeof name !== "string" || name.length === 0) return null;
    const marker = "/messages/";
    const at = name.indexOf(marker);
    const id = at === -1 ? name : name.slice(at + marker.length);
    return id.length === 0 ? null : id.slice(0, 255);
  } catch {
    return null;
  }
}
