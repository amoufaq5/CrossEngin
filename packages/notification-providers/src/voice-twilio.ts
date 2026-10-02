import type {
  DeliveryOutcome,
  NotificationChannel,
  ProviderKind,
} from "@crossengin/notifications";

import {
  CHANNEL_MISMATCH_ERROR_CODE,
  truncateErrorMessage,
  type ChannelSender,
  type FetchLike,
  type SendRequest,
  type SendResult,
} from "./email-ses.js";
import {
  basicAuthHeader,
  classifyTwilioFailure,
  encodeTwilioForm,
  parseTwilioErrorBody,
  TWILIO_API_BASE_URL,
  TWILIO_API_VERSION,
} from "./sms-twilio.js";

/*
 * Twilio Programmable Voice, the same 2010-04-01 REST API as Messages:
 *   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Calls.json
 * form-encoded, HTTP Basic auth. The auth, the error-body shape and the error codes are shared with
 * the SMS sender, so the credential handling and `classifyTwilioFailure` are imported rather than
 * restated — a Twilio 20003 means the same thing whichever resource returned it.
 *
 * A deployment must supply: the Account SID, one credential pair (API key sid + secret, or the auth
 * token) and a `fromNumber` in E.164 that the account owns as a voice-capable caller id. There is no
 * messaging-service equivalent for Calls, so unlike the SMS sender the number is required.
 */

export function twilioCallsPath(accountSid: string): string {
  return `/${TWILIO_API_VERSION}/Accounts/${encodeURIComponent(accountSid)}/Calls.json`;
}

// ---------------------------------------------------------------------------
// TwiML, inline
// ---------------------------------------------------------------------------

/*
 * A call is answered by Twilio asking what to do, and the create request may answer in one of two
 * ways: `Url`, which Twilio fetches at answer time, or `Twiml`, which is the document itself.
 *
 * This sender sends `Twiml`. `Url` would mean standing up a route on operate-server that returns the
 * spoken content of a notification to an unauthenticated GET from Twilio's network — a new
 * attacker-reachable surface whose *response body is the message*, protected by nothing but a hard
 * -to-guess path, on a channel whose content is spoken aloud. It would also move composition into the
 * future: Twilio fetches it when the callee picks up, which may be minutes later, from a process that
 * may have restarted, for a dispatch whose row the drain has already finalised. Inline TwiML keeps
 * the content inside the one authenticated request we initiate, and leaves nothing to serve.
 *
 * The cost of inline TwiML is that it cannot branch — no `<Gather>` digit to acknowledge a page, no
 * second leg. That is the right trade here: acknowledging an incident is `incident-response`'s job,
 * over an authenticated surface that records who acknowledged it, not an unauthenticated keypress
 * from whoever answered the phone.
 */

/** Twilio rejects a `Twiml` parameter longer than this. */
export const MAX_TWIML_CHARACTERS = 4000;

/** TwiML is XML: an unescaped `&` in a template id is a 400, and an unescaped `<` is an injected verb. */
export function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * `<Say language>` goes into an XML attribute, so only a value matching the dispatch locale shape
 * (`en`, `en-US` — the same regex `NotificationDispatchSchema` enforces) is ever interpolated. A
 * locale that does not match falls back rather than being escaped and passed through, because a
 * language Twilio does not know is read in the wrong voice, which is worse than the default.
 */
const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;

export const DEFAULT_VOICE_LANGUAGE = "en-US";

export function voiceLanguageFor(
  locale: string,
  fallback: string = DEFAULT_VOICE_LANGUAGE,
): string {
  return LOCALE_PATTERN.test(locale) ? locale : fallback;
}

export interface VoiceTwimlOptions {
  readonly language: string;
  /** How many times the notice is spoken. A woken human misses the first sentence. */
  readonly repeatCount: number;
  readonly pauseSeconds: number;
}

export function renderVoiceTwiml(
  spokenText: string,
  opts: VoiceTwimlOptions,
): string {
  const language = voiceLanguageFor(opts.language);
  const build = (text: string): string => {
    const say = `<Say language="${language}">${text}</Say>`;
    const parts: string[] = [];
    for (let i = 0; i < opts.repeatCount; i += 1) {
      if (i > 0) parts.push(`<Pause length="${String(opts.pauseSeconds)}"/>`);
      parts.push(say);
    }
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${parts.join("")}</Response>`;
  };

  const escaped = escapeXmlText(spokenText);
  const rendered = build(escaped);
  if (rendered.length <= MAX_TWIML_CHARACTERS) return rendered;
  // Over the cap, the spoken text is clipped rather than the document: a truncated document is not
  // XML and Twilio rejects the whole call, where a truncated sentence still reaches the callee. The
  // slice is taken on the escaped text and then trimmed back off any half-written entity, because
  // `&am` is also not XML.
  const overhead = rendered.length - escaped.length * opts.repeatCount;
  const budget = Math.max(
    0,
    Math.floor((MAX_TWIML_CHARACTERS - overhead) / opts.repeatCount),
  );
  const clipped = escaped.slice(0, budget).replace(/&[A-Za-z#0-9]*$/, "");
  return build(clipped);
}

export type VoiceComposer = (request: SendRequest) => string;

/*
 * As with SMS, `SendRequest` carries no rendered body, and a voice call is the least private channel
 * in the stack: it is spoken aloud into whatever room answered, and a voicemail service stores a
 * recording of it on infrastructure belonging to neither us nor the tenant. So the default notice
 * carries no tenant data at all — not even the template id, which on this channel would be read out
 * loud. A deployment that wants more injects a composer and owns that decision.
 */
export const defaultVoiceComposer: VoiceComposer = () =>
  "This is an automated call from CrossEngin. " +
  "A notification is waiting for you. Please sign in to CrossEngin to read it.";

// ---------------------------------------------------------------------------
// Call statuses
// ---------------------------------------------------------------------------

/**
 * Call statuses on a 2xx that mean Twilio has taken the call on. A freshly created call is `queued`;
 * the others appear only if Twilio has already progressed the call by the time it answers us.
 */
export const TWILIO_CALL_ACCEPTED_STATUSES: readonly string[] = [
  "queued",
  "initiated",
  "ringing",
  "in-progress",
  "completed",
];

/**
 * Statuses that mean the call did not connect but the number is fine: nobody picked up, or the line
 * was engaged. Retryable `failed` — on a page, ringing again in a minute is the entire point, and
 * neither is evidence to suppress the number with.
 */
export const TWILIO_CALL_RETRYABLE_STATUSES: Readonly<Record<string, string>> = {
  busy: "twilio_voice_busy",
  "no-answer": "twilio_voice_no_answer",
};

export interface VoiceStatusClassification {
  readonly outcome: DeliveryOutcome;
  readonly errorCode: string;
}

/**
 * Classifies a non-accepted status on a 2xx create.
 *
 * `failed` is the one status that carries a Twilio error code, so it routes through the shared
 * `classifyTwilioFailure` — an invalid `To` is 21211 on a call exactly as on a message. `canceled`
 * is terminal `dropped`: somebody or something cancelled this call, and re-placing it would be
 * undoing that.
 */
export function classifyVoiceCallStatus(
  status: string,
  errorCode: number | null,
): VoiceStatusClassification {
  const retryable = TWILIO_CALL_RETRYABLE_STATUSES[status];
  if (retryable !== undefined) {
    return { outcome: "failed", errorCode: retryable };
  }
  if (status === "canceled") {
    return { outcome: "dropped", errorCode: "twilio_voice_canceled" };
  }
  return classifyTwilioFailure(400, errorCode);
}

// ---------------------------------------------------------------------------
// The recipient
// ---------------------------------------------------------------------------

const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

export function isE164(address: string): boolean {
  return E164_PATTERN.test(address);
}

export const VOICE_RECIPIENT_REFUSED_ERROR_CODE = "voice_recipient_not_e164";

// ---------------------------------------------------------------------------
// The sender
// ---------------------------------------------------------------------------

export const MACHINE_DETECTION_MODES = ["Detect", "DetectMessageEnd"] as const;
export type MachineDetectionMode = (typeof MACHINE_DETECTION_MODES)[number];

export const DEFAULT_VOICE_REPEAT_COUNT = 2;
export const MAX_VOICE_REPEAT_COUNT = 5;
export const DEFAULT_VOICE_PAUSE_SECONDS = 1;

export interface TwilioVoiceSenderOptions {
  readonly accountSid: string;
  readonly authToken?: string;
  readonly apiKeySid?: string;
  readonly apiKeySecret?: string;
  /** A voice-capable caller id the account owns, in E.164. Calls has no messaging-service analogue. */
  readonly fromNumber: string;
  readonly statusCallbackUrl?: string;
  /**
   * Asks Twilio to decide whether a human or an answering machine picked up. The verdict
   * (`AnsweredBy`) is reported on the status callback, never on this request — see the note on
   * `send`. `DetectMessageEnd` additionally waits for the greeting to finish before speaking, which
   * is what stops a notice being talked over by "please leave a message".
   */
  readonly machineDetection?: MachineDetectionMode;
  readonly repeatCount?: number;
  readonly language?: string;
  readonly fetchImpl?: FetchLike;
  readonly baseUrl?: string;
  readonly compose?: VoiceComposer;
}

export class TwilioVoiceSender implements ChannelSender {
  readonly channel: NotificationChannel = "voice_call";
  readonly provider: ProviderKind = "twilio_voice";

  private readonly accountSid: string;
  private readonly authUser: string;
  private readonly authPass: string;
  private readonly fromNumber: string;
  private readonly statusCallbackUrl: string | null;
  private readonly machineDetection: MachineDetectionMode | null;
  private readonly repeatCount: number;
  private readonly language: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly compose: VoiceComposer;

  constructor(opts: TwilioVoiceSenderOptions) {
    if (opts.accountSid.length === 0) {
      throw new Error("TwilioVoiceSender: accountSid is required");
    }
    const hasApiKey =
      opts.apiKeySid !== undefined && opts.apiKeySecret !== undefined;
    const hasAuthToken =
      opts.authToken !== undefined && opts.authToken.length > 0;
    if (!hasApiKey && !hasAuthToken) {
      throw new Error(
        "TwilioVoiceSender: supply either apiKeySid + apiKeySecret or authToken",
      );
    }
    // A caller id that is not E.164 is rejected by Twilio on every single call, so it fails here.
    if (!isE164(opts.fromNumber)) {
      throw new Error(
        "TwilioVoiceSender: fromNumber must be an E.164 number (+15550000000)",
      );
    }
    const repeatCount = opts.repeatCount ?? DEFAULT_VOICE_REPEAT_COUNT;
    if (
      !Number.isInteger(repeatCount) ||
      repeatCount < 1 ||
      repeatCount > MAX_VOICE_REPEAT_COUNT
    ) {
      throw new Error(
        `TwilioVoiceSender: repeatCount must be an integer in 1..${String(MAX_VOICE_REPEAT_COUNT)}`,
      );
    }
    const language = opts.language ?? DEFAULT_VOICE_LANGUAGE;
    if (!LOCALE_PATTERN.test(language)) {
      // The fallback language is interpolated into a TwiML attribute, so an unvalidated one would be
      // the one string in the document that escaping never saw.
      throw new Error(
        "TwilioVoiceSender: language must look like en or en-US",
      );
    }
    this.accountSid = opts.accountSid;
    this.authUser = hasApiKey ? (opts.apiKeySid as string) : opts.accountSid;
    this.authPass = hasApiKey
      ? (opts.apiKeySecret as string)
      : (opts.authToken as string);
    this.fromNumber = opts.fromNumber;
    this.statusCallbackUrl = opts.statusCallbackUrl ?? null;
    this.machineDetection = opts.machineDetection ?? null;
    this.repeatCount = repeatCount;
    this.language = language;
    this.fetchImpl =
      opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.baseUrl = opts.baseUrl ?? TWILIO_API_BASE_URL;
    this.compose = opts.compose ?? defaultVoiceComposer;
  }

  buildTwiml(request: SendRequest): string {
    return renderVoiceTwiml(this.compose(request), {
      language: voiceLanguageFor(request.locale, this.language),
      repeatCount: this.repeatCount,
      pauseSeconds: DEFAULT_VOICE_PAUSE_SECONDS,
    });
  }

  buildRequestBody(request: SendRequest): {
    readonly form: string;
    readonly twimlChars: number;
  } {
    const twiml = this.buildTwiml(request);
    const form = encodeTwilioForm({
      To: request.recipientAddress,
      From: this.fromNumber,
      Twiml: twiml,
      ...(this.statusCallbackUrl !== null
        ? {
            StatusCallback: this.statusCallbackUrl,
            // Without naming the events, Twilio sends only `completed`; `answered` is what carries
            // the AnsweredBy verdict that machine detection produces.
            StatusCallbackEvent: "initiated ringing answered completed",
          }
        : {}),
      ...(this.machineDetection !== null
        ? { MachineDetection: this.machineDetection }
        : {}),
    });
    return { form, twimlChars: twiml.length };
  }

  /**
   * What `delivered` means here, and what it does not.
   *
   * The Calls create response reports `status: "queued"` — Twilio has accepted the call for
   * origination and nothing more. Whether anybody heard it is knowable only later, from the status
   * callback: `CallStatus=completed` with a `CallDuration`, and, with machine detection on,
   * `AnsweredBy=human` versus `machine_start` / `machine_end_beep` / `fax` / `unknown`. A
   * synchronous send cannot see any of it, which is the same horizon the SMS sender reports against.
   *
   * `queued` is in `DELIVERY_OUTCOMES` and would describe this literally, but it is neither terminal
   * nor retryable: `advanceDispatch` counts it as neither delivered nor failed, so a dispatch of
   * nothing but queued calls finalises as `failed` with no retry scheduled. Reporting it would
   * therefore record every successful page as a failure. So `delivered` is the honest maximum this
   * seam can express, and it means **accepted for origination** — not answered, and certainly not
   * acknowledged. A page that a human must confirm having received is the incident-response
   * escalation ladder's job; this sender's verdict is not an acknowledgement and nothing should read
   * it as one.
   */
  async send(request: SendRequest): Promise<SendResult> {
    if (request.channel !== "voice_call") {
      return this.refuse(
        CHANNEL_MISMATCH_ERROR_CODE,
        `twilio voice sender cannot send channel ${request.channel}`,
        null,
      );
    }
    if (!isE164(request.recipientAddress)) {
      /*
       * Refused before Twilio sees it, and the number is never quoted. The serving recipient
       * directory hands this channel the user's *email address* today, and Twilio answers an email
       * in `To` with 21211 — which classifies `bounced_hard`, terminal, and would write a permanent
       * voice suppression against an address that was never a phone number. A retryable `failed`
       * keeps our own misconfiguration out of the suppression table.
       */
      return this.refuse(
        VOICE_RECIPIENT_REFUSED_ERROR_CODE,
        `recipient address (${request.recipientAddress.length} chars) is not an E.164 number`,
        null,
      );
    }

    const { form } = this.buildRequestBody(request);
    const bytesSent = Buffer.byteLength(form, "utf8");

    // A transport failure propagates, as in the other senders: the drain records `failed` /
    // `sender_threw` and retries on the existing ladder.
    const response = await this.fetchImpl(
      `${this.baseUrl}${twilioCallsPath(this.accountSid)}`,
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
        errorCode: classified.errorCode,
        errorMessage: truncateErrorMessage(
          parsed.message ??
            `Twilio responded ${response.status.toString()} with no message`,
        ),
      };
    }

    let sid: string | null = null;
    let status: string | null = null;
    let syncErrorCode: number | null = null;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const rawSid = parsed["sid"];
      if (typeof rawSid === "string" && rawSid.length > 0) sid = rawSid;
      const rawStatus = parsed["status"];
      if (typeof rawStatus === "string") status = rawStatus;
      syncErrorCode = numericCode(parsed["error_code"]);
    } catch {
      // A 2xx with an unreadable body still means Twilio accepted the call.
    }

    if (status !== null && !TWILIO_CALL_ACCEPTED_STATUSES.includes(status)) {
      const classified = classifyVoiceCallStatus(status, syncErrorCode);
      return {
        outcome: classified.outcome,
        provider: this.provider,
        providerMessageId: sid,
        httpStatus: response.status,
        bytesSent,
        errorCode: classified.errorCode,
        errorMessage: truncateErrorMessage(
          `Twilio returned call status ${status}`,
        ),
      };
    }

    return {
      outcome: "delivered",
      provider: this.provider,
      providerMessageId: sid,
      httpStatus: response.status,
      bytesSent,
      errorCode: null,
      errorMessage: null,
    };
  }

  private refuse(
    errorCode: string,
    message: string,
    httpStatus: number | null,
  ): SendResult {
    return {
      outcome: "failed",
      provider: this.provider,
      providerMessageId: null,
      httpStatus,
      bytesSent: null,
      errorCode,
      errorMessage: truncateErrorMessage(message),
    };
  }
}

function numericCode(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "string" && raw.length > 0) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}
