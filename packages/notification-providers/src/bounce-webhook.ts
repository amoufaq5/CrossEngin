import { sha256, verifyWebhookSignature } from "@crossengin/crypto";
import {
  PERMANENT_SUPPRESSION_REASONS,
  SuppressionRecordSchema,
  type NotificationChannel,
  type SuppressionReason,
  type SuppressionRecord,
} from "@crossengin/notifications";

/*
 * This module is attacker-reachable: anything that can POST to the route can claim that an
 * address bounced, and a believed claim writes a suppression that stops that address receiving
 * notifications. So nothing here believes a payload it has not verified, and nothing here guesses:
 * an unverified body, an unparseable body, a shape no provider would send, or a provider code this
 * module does not recognise all end in a refusal with zero suppressions. Per CLAUDE.md, a check
 * that cannot be completed denies.
 *
 * It verifies the platform's own HMAC-SHA256 envelope (`t=<unix>,v1=<hex>`, the same vocabulary
 * `workflow-signal-bridge` verifies) rather than either provider's native scheme, because neither
 * native scheme can be verified here:
 *
 *   - SES bounces and complaints arrive over SNS, which signs asymmetrically (RSA) with a
 *     certificate fetched from the message's own `SigningCertURL`. Verifying it needs a network
 *     fetch and RSA verification; @crossengin/crypto has neither, and a pure module must not
 *     fetch. SNS also offers no shared secret and no replay window.
 *   - Twilio signs `X-Twilio-Signature` as base64 HMAC-**SHA1** over the URL plus sorted POST
 *     parameters. It is a shared secret, but it is SHA-1, which @crossengin/crypto does not do,
 *     and it carries no timestamp at all, so it admits unbounded replay.
 *
 * A deployment therefore terminates the provider's native scheme at the edge — an SNS-subscribed
 * Lambda, or the reverse proxy fronting the API for Twilio — and re-signs the byte-identical body
 * with `signWebhookPayload` before forwarding it here. That is what makes a replay window exist.
 * The window bounds replay, it does not eliminate it: a body re-sent inside the tolerance still
 * verifies, exactly as with a Stripe webhook. It is safe because the planned suppression is
 * idempotent — its id is derived from (tenant, channel, address, reason) and the table is unique
 * on (tenant, channel, address) — so a replayed bounce re-asserts a suppression rather than
 * adding one.
 */

export const BOUNCE_WEBHOOK_SOURCES = ["ses", "twilio"] as const;
export type BounceWebhookSource = (typeof BOUNCE_WEBHOOK_SOURCES)[number];

export const DEFAULT_BOUNCE_TOLERANCE_SECONDS = 300;

export const SUPPRESSION_ID_HEX_LENGTH = 32;
export const MAX_RECIPIENT_ADDRESS_LENGTH = 500;
export const MAX_SUPPRESSION_NOTES_LENGTH = 500;

export const BOUNCE_WEBHOOK_REFUSALS = [
  "signature_malformed",
  "signature_invalid",
  "timestamp_outside_tolerance",
  "body_unparseable",
  "payload_unrecognized",
  "event_not_suppressible",
  "recipient_missing",
  "invalid_suppression",
] as const;
export type BounceWebhookRefusal = (typeof BOUNCE_WEBHOOK_REFUSALS)[number];

export const BOUNCE_EVENT_KINDS = [
  "hard_bounce",
  "transient_bounce",
  "complaint",
  "sms_failure",
] as const;
export type BounceEventKind = (typeof BOUNCE_EVENT_KINDS)[number];

export interface RecognizedBounceEvent {
  readonly source: BounceWebhookSource;
  readonly channel: NotificationChannel;
  readonly kind: BounceEventKind;
  readonly addresses: readonly string[];
  readonly providerMessageId: string | null;
  /** The provider's own verdict code (`Permanent/General`, `21610`, …), for the audit note. */
  readonly providerCode: string | null;
}

export interface BounceWebhookOptions {
  readonly secretBytes: Uint8Array;
  readonly toleranceSeconds?: number;
  /**
   * How long a *transient* bounce suppresses an address, if at all. Unset — the default — means a
   * transient bounce suppresses nothing: `soft_bounce_exceeded` means a threshold was crossed, and
   * counting bounces needs state this pure module does not have. Blocking a mailbox that was
   * merely full would be the wrong kind of fail-closed.
   */
  readonly transientSuppressionHours?: number;
}

export interface BounceWebhookRequest {
  readonly source: BounceWebhookSource;
  readonly tenantId: string;
  /** The raw body exactly as received: the signature covers these bytes, not a re-serialization. */
  readonly body: string;
  readonly signatureHeader: string;
  readonly now: Date;
}

export type BounceWebhookResult =
  | {
      readonly accepted: true;
      readonly event: RecognizedBounceEvent;
      /** Planned, not written: the caller owns the insert, so this module stays pure. */
      readonly suppressions: readonly SuppressionRecord[];
    }
  | {
      readonly accepted: false;
      readonly refusal: BounceWebhookRefusal;
      readonly reason: string;
    };

function refuse(
  refusal: BounceWebhookRefusal,
  reason: string,
): BounceWebhookResult {
  return { accepted: false, refusal, reason };
}

// ---------------------------------------------------------------------------
// Normalising the address
// ---------------------------------------------------------------------------

/*
 * ADR-0302 left this open: a bounce reporting `Bounced@Example.test` planned a suppression on that
 * exact spelling, while the address the platform sends to is `bounced@example.test`. The store's
 * lookup and `findActiveSuppression` both compare the address exactly, so the row existed, was
 * active, and matched nothing — the worst shape a safety record can take, because the table says the
 * address is suppressed and the drain keeps mailing it.
 *
 * It is fixed here rather than in the store, deliberately. `suppressionIdFor` commits to the address
 * in the row: lowercasing inside the store would leave a row whose id was derived from a string the
 * row does not contain, which makes the id a lie and makes two different raw addresses collide onto
 * one id. Normalising *upstream*, before the id is derived, keeps the id honest — it still commits to
 * exactly what is stored — and is the only place where the channel is known, which matters because
 * the rule is per-channel.
 *
 * Two properties hold for every rule below, and are tested:
 *
 *   1. **Idempotence.** Normalising a normalised address returns it unchanged, so a replayed event
 *      plans the same id.
 *   2. **Normalisation re-spells, it never widens.** No rule may map two addresses that could be
 *      different mailboxes, handsets or devices onto one. Suppressing an address that did not bounce
 *      is not a safer error than failing to suppress one that did; it is a silent outage.
 */

export const ADDRESS_NORMALIZATION_RULES = ["email", "phone", "opaque"] as const;
export type AddressNormalizationRule =
  (typeof ADDRESS_NORMALIZATION_RULES)[number];

/**
 * Which rule each channel's address takes. `sms` and `voice_call` are both telephone numbers and
 * normalise identically to each other and nothing like an email address; `in_app`, `push_mobile` and
 * `webhook` carry opaque identifiers — a user id, a device registration token, a URL.
 */
export const CHANNEL_ADDRESS_NORMALIZATION: Readonly<
  Record<NotificationChannel, AddressNormalizationRule>
> = {
  email: "email",
  sms: "phone",
  voice_call: "phone",
  push_mobile: "opaque",
  in_app: "opaque",
  webhook: "opaque",
};

/**
 * Lowercases the whole address, after trimming and removing one surrounding pair of angle brackets.
 *
 * The domain is uncontroversial: DNS is case-insensitive, so `Example.test` and `example.test` are
 * the same host by definition. The local-part is a real decision. RFC 5321 §2.4 is explicit that only
 * the destination server may interpret its own local-parts and that they are formally
 * case-**sensitive**, so `Bounced@` and `bounced@` are, to the letter, two mailboxes.
 *
 * We lowercase it anyway. No mail provider in production distinguishes them — every major one folds
 * case on delivery — and the alternative is not RFC purity, it is a suppression row that never
 * matches. That costs more than over-matching could: mail sent to an address a provider has already
 * told us is dead cannot arrive, and the bounce and complaint rates it feeds are exactly what gets a
 * whole sending domain throttled or paused, taking every other tenant's mail with it. That is the
 * reasoning `UNCONDITIONAL_SUPPRESSION_REASONS` already rests on (ADR-0302), applied one layer down.
 *
 * Two things it deliberately does *not* do:
 *
 *   - **Subaddressing is kept.** `ops+alerts@example.test` is not rewritten to `ops@example.test`.
 *     Providers differ on whether the tag selects a folder or a mailbox, and collapsing it would turn
 *     one bounced address into a suppression covering addresses that never bounced — widening, which
 *     the invariant above forbids.
 *   - **A display name is not parsed off.** One surrounding `<…>` pair is removed because
 *     `<bounced@example.test>` is unambiguously the same address in RFC 5322 form; `"Ops" <o@e.test>`
 *     is left as it came, because extracting an address from a display form is parsing, and a parser
 *     that gets it wrong suppresses the wrong mailbox.
 */
export function normalizeEmailAddress(raw: string): string {
  const trimmed = raw.trim();
  const unwrapped =
    trimmed.startsWith("<") && trimmed.endsWith(">") && trimmed.length > 2
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  return unwrapped.toLowerCase();
}

/**
 * Anything that is unambiguously one telephone number written with punctuation: digits, an optional
 * leading `+`, and the separators a provider or a human might put between them.
 */
const PHONE_SHAPED = /^(tel:)?\+?[0-9][0-9\s().\-]*$/;

/**
 * Strips the punctuation out of a telephone number, keeping the digits and a leading `+`.
 *
 * Case folding is a no-op on a phone number; what varies between a provider's echo and a directory's
 * record is formatting — `+1 (555) 123-4567` against `+15551234567`. So this rule is nothing like the
 * email rule, and conflating them is how an email address gets "normalised" into an empty string.
 *
 * A `+` is neither added nor removed. E.164 requires it, and inventing one would be asserting a
 * country code we were not told; dropping one would merge a national number with an international
 * number that happens to share its digits.
 *
 * Normalisation applies **only when the value is recognisably a phone number**. Anything else is
 * returned trimmed and otherwise untouched, because rewriting an unrecognised address into a
 * phone-shaped one would invent an address rather than re-spell it. That case is live, not
 * hypothetical: the serving recipient directory hands the `sms` and `voice_call` channels the user's
 * email address today, so a Twilio failure can carry one in `To`.
 */
export function normalizePhoneAddress(raw: string): string {
  const trimmed = raw.trim();
  if (!PHONE_SHAPED.test(trimmed)) return trimmed;
  const withoutScheme = trimmed.startsWith("tel:") ? trimmed.slice(4) : trimmed;
  const digits = withoutScheme.replace(/[^0-9]/g, "");
  return withoutScheme.startsWith("+") ? `+${digits}` : digits;
}

const UUID_SHAPED =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Trims, and lowercases only a UUID.
 *
 * An opaque address is not something a human typed, so there is no spelling to forgive. A push
 * registration token is base64url and case-**significant**: folding it would produce a token that
 * matches no device and could in principle collide with another one. A webhook URL has a
 * case-sensitive path. Neither may be touched beyond whitespace.
 *
 * A UUID is the exception, and the reason this rule is not simply `trim`: `in_app` and `push_mobile`
 * addresses are the recipient's user id today, hex case carries no meaning in a UUID, and Postgres
 * renders one lowercase — so an upper-case spelling is the same identifier and can be folded safely.
 */
export function normalizeOpaqueAddress(raw: string): string {
  const trimmed = raw.trim();
  return UUID_SHAPED.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

export function normalizeRecipientAddress(
  channel: NotificationChannel,
  raw: string,
): string {
  switch (CHANNEL_ADDRESS_NORMALIZATION[channel]) {
    case "email":
      return normalizeEmailAddress(raw);
    case "phone":
      return normalizePhoneAddress(raw);
    case "opaque":
      return normalizeOpaqueAddress(raw);
  }
}

// ---------------------------------------------------------------------------
// Planning a suppression
// ---------------------------------------------------------------------------

/**
 * Derived from the tuple the suppressions table is unique on, plus the reason, so a replayed or
 * re-delivered provider event plans the identical row rather than a second one.
 *
 * It hashes exactly the address it is given and does no normalising of its own: the id has to commit
 * to the address actually stored, so `planSuppression` normalises first and calls this with the
 * result. A caller that derives an id for a row it already holds therefore passes that row's address
 * and gets that row's id.
 */
export function suppressionIdFor(input: {
  readonly tenantId: string;
  readonly channel: NotificationChannel;
  readonly recipientAddress: string;
  readonly reason: SuppressionReason;
}): string {
  const digest = sha256(
    `${input.tenantId}|${input.channel}|${input.recipientAddress}|${input.reason}`,
  );
  return `supp_${digest.slice(0, SUPPRESSION_ID_HEX_LENGTH)}`;
}

export function suppressionNotes(
  event: RecognizedBounceEvent,
): string | undefined {
  const parts = [`${event.source} ${event.kind}`];
  if (event.providerCode !== null) parts.push(`code=${event.providerCode}`);
  if (event.providerMessageId !== null) {
    parts.push(`provider_message=${event.providerMessageId}`);
  }
  const note = parts.join("; ");
  return note.slice(0, MAX_SUPPRESSION_NOTES_LENGTH);
}

export function planSuppression(input: {
  readonly tenantId: string;
  readonly channel: NotificationChannel;
  readonly recipientAddress: string;
  readonly reason: SuppressionReason;
  readonly appliedAt: Date;
  readonly expiresAt: Date | null;
  readonly notes?: string;
}): SuppressionRecord | null {
  const appliedAt = input.appliedAt.toISOString();
  // Normalised here, once, before anything else reads it — so the id, the stored address and the
  // uniqueness tuple are all derived from the same canonical string (see the rules above).
  const recipientAddress = normalizeRecipientAddress(
    input.channel,
    input.recipientAddress,
  );
  const candidate = {
    id: suppressionIdFor({
      tenantId: input.tenantId,
      channel: input.channel,
      recipientAddress,
      reason: input.reason,
    }),
    tenantId: input.tenantId,
    channel: input.channel,
    recipientAddress,
    reason: input.reason,
    appliedAt,
    // No human applied this one, and the provider is not a `meta.users` row.
    appliedBy: null,
    expiresAt: PERMANENT_SUPPRESSION_REASONS.has(input.reason)
      ? null
      : (input.expiresAt?.toISOString() ?? null),
    // The provider reports its own message id, never our `meta.notification_deliveries` UUID, so
    // the link back to the attempt lives in `notes` instead of being invented here.
    sourceDeliveryId: null,
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  };
  const parsed = SuppressionRecordSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// SES / SNS payloads
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function stringAt(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * An SES event reaches us either bare or wrapped in an SNS `Notification`, whose `Message` is the
 * event as a JSON *string*. Anything else SNS can POST — a `SubscriptionConfirmation`, an
 * `UnsubscribeConfirmation` — is deliberately not unwrapped: confirming a subscription is not this
 * module's job, and acting on one would be acting on a payload whose meaning we do not model.
 */
export function unwrapSnsEnvelope(body: string): Record<string, unknown> | null {
  const outer = asRecord(safeJsonParse(body));
  if (outer === null) return null;
  const type = stringAt(outer, "Type");
  if (type === null) return outer;
  if (type !== "Notification") return null;
  const message = stringAt(outer, "Message");
  if (message === null) return null;
  return asRecord(safeJsonParse(message));
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function emailAddressesFrom(value: unknown, key: string): readonly string[] {
  if (!Array.isArray(value)) return [];
  const addresses: string[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === null) continue;
    const address = stringAt(record, key);
    if (address !== null && address.length <= MAX_RECIPIENT_ADDRESS_LENGTH) {
      addresses.push(address);
    }
  }
  return addresses;
}

export type SesRecognition =
  | { readonly ok: true; readonly event: RecognizedBounceEvent }
  | { readonly ok: false; readonly refusal: BounceWebhookRefusal; readonly reason: string };

/**
 * SES event publishing names the event in `eventType`; the older SNS feedback notification names
 * it in `notificationType`. Both are accepted; a payload carrying neither is not an SES event.
 */
export function recognizeSesEvent(body: string): SesRecognition {
  const event = unwrapSnsEnvelope(body);
  if (event === null) {
    return {
      ok: false,
      refusal: "payload_unrecognized",
      reason: "body is not an SES event or an SNS Notification wrapping one",
    };
  }
  const kind = stringAt(event, "eventType") ?? stringAt(event, "notificationType");
  if (kind === null) {
    return {
      ok: false,
      refusal: "payload_unrecognized",
      reason: "SES event carries neither eventType nor notificationType",
    };
  }
  const mail = asRecord(event["mail"]);
  const providerMessageId = mail === null ? null : stringAt(mail, "messageId");

  if (kind === "Bounce") {
    const bounce = asRecord(event["bounce"]);
    if (bounce === null) {
      // SES never sends a Bounce without a `bounce` object; a payload that does is forged or
      // mangled, and either way is not evidence of a bounce.
      return {
        ok: false,
        refusal: "payload_unrecognized",
        reason: "Bounce event has no bounce object",
      };
    }
    const bounceType = stringAt(bounce, "bounceType");
    const subType = stringAt(bounce, "bounceSubType");
    const addresses = emailAddressesFrom(
      bounce["bouncedRecipients"],
      "emailAddress",
    );
    if (addresses.length === 0) {
      return {
        ok: false,
        refusal: "recipient_missing",
        reason: "Bounce event lists no bouncedRecipients with an emailAddress",
      };
    }
    if (bounceType !== "Permanent" && bounceType !== "Transient") {
      // `Undetermined` is SES saying it does not know why; so do we.
      return {
        ok: false,
        refusal: "event_not_suppressible",
        reason: `bounceType ${bounceType ?? "<missing>"} is not a suppression signal`,
      };
    }
    return {
      ok: true,
      event: {
        source: "ses",
        channel: "email",
        kind: bounceType === "Permanent" ? "hard_bounce" : "transient_bounce",
        addresses,
        providerMessageId,
        providerCode: subType === null ? bounceType : `${bounceType}/${subType}`,
      },
    };
  }

  if (kind === "Complaint") {
    const complaint = asRecord(event["complaint"]);
    if (complaint === null) {
      return {
        ok: false,
        refusal: "payload_unrecognized",
        reason: "Complaint event has no complaint object",
      };
    }
    const addresses = emailAddressesFrom(
      complaint["complainedRecipients"],
      "emailAddress",
    );
    if (addresses.length === 0) {
      return {
        ok: false,
        refusal: "recipient_missing",
        reason:
          "Complaint event lists no complainedRecipients with an emailAddress",
      };
    }
    return {
      ok: true,
      event: {
        source: "ses",
        channel: "email",
        kind: "complaint",
        addresses,
        providerMessageId,
        providerCode: stringAt(complaint, "complaintFeedbackType"),
      },
    };
  }

  return {
    ok: false,
    refusal: "event_not_suppressible",
    reason: `SES event ${kind} carries no suppression signal`,
  };
}

// ---------------------------------------------------------------------------
// Twilio status callbacks
// ---------------------------------------------------------------------------

/** Twilio message statuses that report a failure rather than progress. */
export const TWILIO_FAILED_STATUSES: readonly string[] = [
  "failed",
  "undelivered",
];

/**
 * The only Twilio error codes this module will turn into a suppression, and the reason each one
 * means. Anything absent here is refused rather than guessed: an unrecognised code is not
 * evidence that an address should stop receiving notifications.
 *
 * `hard_bounce` is the vocabulary's word for a permanently undeliverable address; the reason enum
 * is channel-agnostic, so it covers a dead handset as well as a dead mailbox. 30003 (handset
 * unreachable) and 21219 (unverified number on a trial account) are deliberately absent: the first
 * describes a phone that is switched off and the second describes our own account, and neither is
 * a reason to stop writing to the address.
 */
export const TWILIO_SUPPRESSION_REASONS: Readonly<
  Record<string, SuppressionReason>
> = {
  "21211": "hard_bounce",
  "21214": "hard_bounce",
  "21217": "hard_bounce",
  "21610": "unsubscribe",
  "21612": "hard_bounce",
  "21614": "hard_bounce",
  "30005": "hard_bounce",
  "30006": "hard_bounce",
  "30007": "spam_complaint",
};

export type TwilioRecognition =
  | { readonly ok: true; readonly event: RecognizedBounceEvent; readonly reason: SuppressionReason }
  | { readonly ok: false; readonly refusal: BounceWebhookRefusal; readonly reason: string };

/** A Twilio status callback is a form-encoded POST body, not JSON. */
export function recognizeTwilioStatusCallback(body: string): TwilioRecognition {
  const params = new URLSearchParams(body);
  const status = params.get("MessageStatus") ?? params.get("SmsStatus");
  if (status === null || status.length === 0) {
    return {
      ok: false,
      refusal: "payload_unrecognized",
      reason: "status callback carries no MessageStatus",
    };
  }
  if (!TWILIO_FAILED_STATUSES.includes(status)) {
    return {
      ok: false,
      refusal: "event_not_suppressible",
      reason: `message status ${status} is not a failure`,
    };
  }
  const to = params.get("To");
  if (to === null || to.length === 0 || to.length > MAX_RECIPIENT_ADDRESS_LENGTH) {
    return {
      ok: false,
      refusal: "recipient_missing",
      reason: "status callback carries no usable To",
    };
  }
  const code = params.get("ErrorCode");
  if (code === null || code.length === 0) {
    return {
      ok: false,
      refusal: "event_not_suppressible",
      reason: `status ${status} carries no ErrorCode to attribute it to`,
    };
  }
  const reason = TWILIO_SUPPRESSION_REASONS[code];
  if (reason === undefined) {
    return {
      ok: false,
      refusal: "event_not_suppressible",
      reason: `Twilio error code ${code} is not a known suppression signal`,
    };
  }
  return {
    ok: true,
    reason,
    event: {
      source: "twilio",
      channel: "sms",
      kind: "sms_failure",
      addresses: [to],
      providerMessageId: params.get("MessageSid"),
      providerCode: code,
    },
  };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

function sesReasonFor(
  event: RecognizedBounceEvent,
  transientHours: number | undefined,
): { readonly reason: SuppressionReason; readonly expiresAt: Date | null } | null {
  if (event.kind === "hard_bounce") return { reason: "hard_bounce", expiresAt: null };
  if (event.kind === "complaint") return { reason: "spam_complaint", expiresAt: null };
  if (event.kind === "transient_bounce") {
    if (transientHours === undefined || transientHours <= 0) return null;
    return { reason: "soft_bounce_exceeded", expiresAt: null };
  }
  return null;
}

export function handleBounceWebhook(
  request: BounceWebhookRequest,
  options: BounceWebhookOptions,
): BounceWebhookResult {
  const tolerance = options.toleranceSeconds ?? DEFAULT_BOUNCE_TOLERANCE_SECONDS;
  const verified = verifyWebhookSignature(
    options.secretBytes,
    request.body,
    request.signatureHeader,
    {
      toleranceSeconds: tolerance,
      nowSeconds: Math.floor(request.now.getTime() / 1000),
    },
  );
  if (!verified.ok) {
    if (verified.reason === "malformed_header") {
      return refuse("signature_malformed", "signature header is malformed");
    }
    if (verified.reason === "timestamp_outside_tolerance") {
      return refuse(
        "timestamp_outside_tolerance",
        `signature timestamp outside ±${tolerance.toString()}s tolerance`,
      );
    }
    return refuse("signature_invalid", "signature does not verify");
  }

  if (request.body.length === 0) {
    return refuse("body_unparseable", "body is empty");
  }

  if (request.source === "ses") {
    const recognized = recognizeSesEvent(request.body);
    if (!recognized.ok) return refuse(recognized.refusal, recognized.reason);
    const mapped = sesReasonFor(
      recognized.event,
      options.transientSuppressionHours,
    );
    if (mapped === null) {
      return refuse(
        "event_not_suppressible",
        `${recognized.event.kind} does not suppress under this configuration`,
      );
    }
    const expiresAt =
      mapped.reason === "soft_bounce_exceeded" &&
      options.transientSuppressionHours !== undefined
        ? new Date(
            request.now.getTime() +
              options.transientSuppressionHours * 3_600_000,
          )
        : mapped.expiresAt;
    return planAll(request, recognized.event, mapped.reason, expiresAt);
  }

  const recognized = recognizeTwilioStatusCallback(request.body);
  if (!recognized.ok) return refuse(recognized.refusal, recognized.reason);
  return planAll(request, recognized.event, recognized.reason, null);
}

function planAll(
  request: BounceWebhookRequest,
  event: RecognizedBounceEvent,
  reason: SuppressionReason,
  expiresAt: Date | null,
): BounceWebhookResult {
  const notes = suppressionNotes(event);
  const suppressions: SuppressionRecord[] = [];
  for (const address of event.addresses) {
    const planned = planSuppression({
      tenantId: request.tenantId,
      channel: event.channel,
      recipientAddress: address,
      reason,
      appliedAt: request.now,
      expiresAt,
      ...(notes !== undefined ? { notes } : {}),
    });
    if (planned === null) {
      // A record we cannot build is a record the caller cannot persist. Refusing the whole
      // webhook keeps an all-or-nothing boundary: a partially believed bounce is worse than an
      // unbelieved one, because it is invisible.
      return refuse(
        "invalid_suppression",
        `planned suppression for ${event.channel} recipient failed SuppressionRecordSchema`,
      );
    }
    suppressions.push(planned);
  }
  if (suppressions.length === 0) {
    return refuse("recipient_missing", "event named no suppressible recipient");
  }
  return { accepted: true, event, suppressions };
}
