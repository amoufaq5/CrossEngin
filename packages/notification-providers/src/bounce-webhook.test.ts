import {
  findActiveSuppression,
  NOTIFICATION_CHANNELS,
} from "@crossengin/notifications";
import { describe, expect, it } from "vitest";

import {
  ADDRESS_NORMALIZATION_RULES,
  BOUNCE_WEBHOOK_SOURCES,
  CHANNEL_ADDRESS_NORMALIZATION,
  DEFAULT_BOUNCE_TOLERANCE_SECONDS,
  normalizeEmailAddress,
  normalizeOpaqueAddress,
  normalizePhoneAddress,
  normalizeRecipientAddress,
  handleBounceWebhook,
  planSuppression,
  recognizeSesEvent,
  TWILIO_FAILED_STATUSES,
  TWILIO_MESSAGE_CALLBACK_STATUSES,
  recognizeTwilioStatusCallback,
  recognizeTwilioVoiceStatusCallback,
  suppressionIdFor,
  suppressionNotes,
  TWILIO_ANSWERED_BY_VALUES,
  TWILIO_CALL_CALLBACK_STATUSES,
  TWILIO_SUPPRESSION_REASONS,
  TWILIO_VOICE_SUPPRESSION_REASONS,
  TWILIO_VOICE_TRANSIENT_CODES,
  unwrapSnsEnvelope,
  VOICE_ANSWERED_BY_VERDICTS,
  VOICE_NEVER_SUPPRESSIBLE_STATUSES,
  VOICE_PROGRESS_STATUSES,
  type BounceWebhookOptions,
  type BounceWebhookRequest,
  type BounceWebhookResult,
} from "./bounce-webhook.js";
import { TWILIO_CALL_RETRYABLE_STATUSES } from "./voice-twilio.js";
import {
  sesBounceEvent,
  sesComplaintEvent,
  signBody,
  snsNotification,
  TEST_TENANT_ID,
  TEST_WEBHOOK_SECRET,
  twilioStatusCallback,
} from "./test-fakes.js";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

const OPTIONS: BounceWebhookOptions = { secretBytes: TEST_WEBHOOK_SECRET };

function signed(
  body: string,
  overrides: Partial<BounceWebhookRequest> = {},
): BounceWebhookRequest {
  return {
    source: "ses",
    tenantId: TEST_TENANT_ID,
    body,
    signatureHeader: signBody(body, NOW_SECONDS),
    now: NOW,
    ...overrides,
  };
}

function expectRefusal(result: BounceWebhookResult, refusal: string): void {
  expect(result.accepted).toBe(false);
  if (result.accepted) return;
  expect(result.refusal).toBe(refusal);
  expect(result.reason.length).toBeGreaterThan(0);
}

describe("the signature gate", () => {
  it("accepts a correctly signed SES permanent bounce", () => {
    const body = sesBounceEvent({});
    const result = handleBounceWebhook(signed(body), OPTIONS);

    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.event.source).toBe("ses");
    expect(result.event.channel).toBe("email");
    expect(result.event.kind).toBe("hard_bounce");
    expect(result.suppressions).toHaveLength(1);
    const suppression = result.suppressions[0];
    expect(suppression?.reason).toBe("hard_bounce");
    expect(suppression?.tenantId).toBe(TEST_TENANT_ID);
    expect(suppression?.channel).toBe("email");
    expect(suppression?.recipientAddress).toBe("gone@example.test");
    expect(suppression?.appliedAt).toBe(NOW.toISOString());
    // The provider that reported the bounce, not NULL: `applied_by` is no longer a `meta.users` id.
    expect(suppression?.appliedBy).toBe("provider:ses");
    expect(suppression?.expiresAt).toBeNull();
    expect(suppression?.sourceDeliveryId).toBeNull();
    expect(suppression?.id).toMatch(/^supp_[0-9a-f]{32}$/);
    expect(suppression?.notes).toContain("ses hard_bounce");
    expect(suppression?.notes).toContain("code=Permanent/General");
    expect(suppression?.notes).toContain("provider_message=0100018f-ses-message-id");
  });

  it("refuses a body that does not match its signature, or a foreign secret", () => {
    const body = sesBounceEvent({});
    expectRefusal(
      handleBounceWebhook(
        { ...signed(body), body: sesBounceEvent({ addresses: ["other@example.test"] }) },
        OPTIONS,
      ),
      "signature_invalid",
    );
    const foreign = new Uint8Array(32).fill(9);
    expectRefusal(
      handleBounceWebhook(
        { ...signed(body), signatureHeader: signBody(body, NOW_SECONDS, foreign) },
        OPTIONS,
      ),
      "signature_invalid",
    );
  });

  it("refuses a malformed signature header", () => {
    const body = sesBounceEvent({});
    for (const header of ["", "v1=deadbeef", "t=abc,v1=deadbeef", "t=1,v1=zz"]) {
      expectRefusal(
        handleBounceWebhook({ ...signed(body), signatureHeader: header }, OPTIONS),
        "signature_malformed",
      );
    }
  });

  it("refuses a replayed timestamp outside the tolerance window", () => {
    const body = sesBounceEvent({});
    const stale = NOW_SECONDS - DEFAULT_BOUNCE_TOLERANCE_SECONDS - 1;
    expectRefusal(
      handleBounceWebhook(
        { ...signed(body), signatureHeader: signBody(body, stale) },
        OPTIONS,
      ),
      "timestamp_outside_tolerance",
    );
  });

  it("refuses a timestamp from the future beyond the tolerance", () => {
    const body = sesBounceEvent({});
    const ahead = NOW_SECONDS + DEFAULT_BOUNCE_TOLERANCE_SECONDS + 1;
    expectRefusal(
      handleBounceWebhook(
        { ...signed(body), signatureHeader: signBody(body, ahead) },
        OPTIONS,
      ),
      "timestamp_outside_tolerance",
    );
  });

  it("accepts the tolerance boundary and honours a narrowed window", () => {
    const body = sesBounceEvent({});
    const edge = NOW_SECONDS - DEFAULT_BOUNCE_TOLERANCE_SECONDS;
    expect(
      handleBounceWebhook(
        { ...signed(body), signatureHeader: signBody(body, edge) },
        OPTIONS,
      ).accepted,
    ).toBe(true);
    expectRefusal(
      handleBounceWebhook(
        { ...signed(body), signatureHeader: signBody(body, NOW_SECONDS - 30) },
        { ...OPTIONS, toleranceSeconds: 10 },
      ),
      "timestamp_outside_tolerance",
    );
  });

  it("refuses an empty body even when the signature over it verifies", () => {
    expectRefusal(handleBounceWebhook(signed(""), OPTIONS), "body_unparseable");
  });

  it("never plans a suppression from any refusal", () => {
    const body = sesBounceEvent({});
    const result = handleBounceWebhook(
      { ...signed(body), signatureHeader: "garbage" },
      OPTIONS,
    );
    expect(result.accepted).toBe(false);
    expect(Object.keys(result)).not.toContain("suppressions");
  });
});

describe("SES payload recognition", () => {
  it("unwraps an SNS Notification and suppresses the wrapped bounce", () => {
    const body = snsNotification(sesBounceEvent({ addresses: ["dead@example.test"] }));
    const result = handleBounceWebhook(signed(body), OPTIONS);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.suppressions[0]?.recipientAddress).toBe("dead@example.test");
  });

  it("refuses an SNS SubscriptionConfirmation rather than acting on it", () => {
    const body = JSON.stringify({
      Type: "SubscriptionConfirmation",
      Token: "t",
      SubscribeURL: "https://sns.example.test/confirm",
    });
    expectRefusal(handleBounceWebhook(signed(body), OPTIONS), "payload_unrecognized");
  });

  it("unwraps a bare event unchanged and refuses an unreadable Message", () => {
    expect(unwrapSnsEnvelope(sesBounceEvent({}))?.["eventType"]).toBe("Bounce");
    expect(unwrapSnsEnvelope(snsNotification("not json"))).toBeNull();
  });

  it("accepts the older notificationType spelling", () => {
    const body = sesBounceEvent({ useNotificationType: true });
    expect(handleBounceWebhook(signed(body), OPTIONS).accepted).toBe(true);
  });

  it("refuses the shapes SES never sends", () => {
    const shapes = [
      // No event name at all.
      JSON.stringify({ mail: {} }),
      // A Bounce with no `bounce` object: forged or mangled, either way not evidence.
      JSON.stringify({ eventType: "Bounce", mail: { messageId: "m" } }),
      // A Complaint with no `complaint` object.
      JSON.stringify({ eventType: "Complaint", mail: {} }),
    ];
    for (const body of shapes) {
      expectRefusal(handleBounceWebhook(signed(body), OPTIONS), "payload_unrecognized");
    }
  });

  it("refuses a Bounce naming no recipient", () => {
    const body = JSON.stringify({
      eventType: "Bounce",
      bounce: { bounceType: "Permanent", bouncedRecipients: [] },
    });
    expectRefusal(handleBounceWebhook(signed(body), OPTIONS), "recipient_missing");
  });

  it("ignores a recipient address longer than the column allows", () => {
    const body = sesBounceEvent({ addresses: [`${"a".repeat(500)}@example.test`] });
    expectRefusal(handleBounceWebhook(signed(body), OPTIONS), "recipient_missing");
  });

  it("refuses an Undetermined bounce type", () => {
    const body = sesBounceEvent({ bounceType: "Undetermined" });
    expectRefusal(handleBounceWebhook(signed(body), OPTIONS), "event_not_suppressible");
  });

  it("does not suppress a transient bounce by default", () => {
    const body = sesBounceEvent({ bounceType: "Transient", bounceSubType: "MailboxFull" });
    const recognized = recognizeSesEvent(body);
    expect(recognized.ok).toBe(true);
    expectRefusal(handleBounceWebhook(signed(body), OPTIONS), "event_not_suppressible");
  });

  it("suppresses a transient bounce for a bounded window when configured to", () => {
    const body = sesBounceEvent({ bounceType: "Transient" });
    const result = handleBounceWebhook(signed(body), {
      ...OPTIONS,
      transientSuppressionHours: 6,
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.suppressions[0]?.reason).toBe("soft_bounce_exceeded");
    expect(result.suppressions[0]?.expiresAt).toBe(
      new Date(NOW.getTime() + 6 * 3_600_000).toISOString(),
    );
  });

  it("maps a complaint to spam_complaint", () => {
    const result = handleBounceWebhook(signed(sesComplaintEvent()), OPTIONS);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.event.kind).toBe("complaint");
    expect(result.event.providerCode).toBe("abuse");
    expect(result.suppressions[0]?.reason).toBe("spam_complaint");
    expect(result.suppressions[0]?.expiresAt).toBeNull();
  });

  it("plans one suppression per bounced recipient", () => {
    const body = sesBounceEvent({ addresses: ["a@example.test", "b@example.test"] });
    const result = handleBounceWebhook(signed(body), OPTIONS);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.suppressions.map((s) => s.recipientAddress)).toEqual([
      "a@example.test",
      "b@example.test",
    ]);
    expect(new Set(result.suppressions.map((s) => s.id)).size).toBe(2);
  });

  it("carries no suppression signal for a Delivery or Open event", () => {
    for (const eventType of ["Delivery", "Open", "Send", "Click"]) {
      const body = JSON.stringify({ eventType, mail: { messageId: "m" } });
      expectRefusal(handleBounceWebhook(signed(body), OPTIONS), "event_not_suppressible");
    }
  });

});

describe("Twilio status callbacks", () => {
  function twilio(params: Readonly<Record<string, string>>): BounceWebhookResult {
    const body = twilioStatusCallback(params);
    return handleBounceWebhook(signed(body, { source: "twilio" }), OPTIONS);
  }

  it("maps an unsubscribed recipient to an unsubscribe suppression", () => {
    const result = twilio({
      MessageStatus: "undelivered",
      ErrorCode: "21610",
      To: "+15551234567",
      MessageSid: "SM123",
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.event.channel).toBe("sms");
    expect(result.event.kind).toBe("sms_failure");
    expect(result.suppressions[0]?.reason).toBe("unsubscribe");
    expect(result.suppressions[0]?.recipientAddress).toBe("+15551234567");
    expect(result.suppressions[0]?.notes).toContain("code=21610");
    expect(result.suppressions[0]?.notes).toContain("provider_message=SM123");
    // Attributed to the source that reported it, so the two providers are distinguishable in the
    // stored row rather than both reading NULL.
    expect(result.suppressions[0]?.appliedBy).toBe("provider:twilio");
  });

  it("maps an invalid number to a hard bounce, under either status spelling", () => {
    const result = twilio({
      MessageStatus: "failed",
      ErrorCode: "21211",
      To: "+15551234567",
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.suppressions[0]?.reason).toBe("hard_bounce");

    const legacy = twilio({
      SmsStatus: "failed",
      ErrorCode: "21211",
      To: "+15551234567",
    });
    expect(legacy.accepted).toBe(true);
  });

  it("maps carrier filtering to a spam complaint", () => {
    const result = twilio({
      MessageStatus: "undelivered",
      ErrorCode: "30007",
      To: "+15551234567",
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.suppressions[0]?.reason).toBe("spam_complaint");
  });

  it("refuses a successful delivery callback", () => {
    expectRefusal(
      twilio({ MessageStatus: "delivered", To: "+15551234567" }),
      "event_not_suppressible",
    );
  });

  it("refuses a failure whose error code is not in the explicit table", () => {
    expectRefusal(
      twilio({ MessageStatus: "failed", ErrorCode: "99999", To: "+15551234567" }),
      "event_not_suppressible",
    );
    // A switched-off handset and our own trial-account restriction are deliberately absent.
    expect(TWILIO_SUPPRESSION_REASONS["30003"]).toBeUndefined();
    expect(TWILIO_SUPPRESSION_REASONS["21219"]).toBeUndefined();
  });

  it("refuses a failure that names no error code to attribute it to", () => {
    expectRefusal(
      twilio({ MessageStatus: "failed", To: "+15551234567" }),
      "event_not_suppressible",
    );
  });

  it("refuses a callback carrying no destination", () => {
    expectRefusal(
      twilio({ MessageStatus: "failed", ErrorCode: "21211" }),
      "recipient_missing",
    );
  });

  it("refuses a body that is not a status callback at all", () => {
    expectRefusal(twilio({ Hello: "world" }), "payload_unrecognized");
    const recognized = recognizeTwilioStatusCallback("");
    expect(recognized.ok).toBe(false);
  });

  it("refuses a MessageStatus Twilio does not define as unrecognised, not as a non-failure", () => {
    // ADR-0329. "Not a failure" is a claim about a status this module understands; a status it has
    // never seen is a claim it cannot make. If Twilio adds a terminal failure status, the old
    // answer kept messaging a number that had stopped working, silently and forever — the exact
    // fail-open shape ADR-0302 removed from the suppression *readers*.
    expectRefusal(
      twilio({ MessageStatus: "incinerated", To: "+15551234567", ErrorCode: "21610" }),
      "payload_unrecognized",
    );
  });

  it("names every status Twilio documents, because a missing one costs a retry storm", () => {
    // The list errs wide on purpose: an unknown status now answers 400 and Twilio retries non-2xx,
    // so a *missing* legitimate status is a retry storm while an extra value Twilio never sends
    // costs nothing (it is refused one step later as not a failure). The two mistakes are not
    // symmetric, which is why this asserts presence rather than an exact set.
    for (const status of ["queued", "sending", "sent", "delivered", "read", "canceled"]) {
      expectRefusal(
        twilio({ MessageStatus: status, To: "+15551234567" }),
        "event_not_suppressible",
      );
    }
    // And every failure status is in the wider set, or it would be refused before it was read.
    for (const status of TWILIO_FAILED_STATUSES) {
      expect(TWILIO_MESSAGE_CALLBACK_STATUSES).toContain(status);
    }
  });
});

describe("Twilio voice status callbacks", () => {
  const VOICE_NUMBER = "+15551234567";

  function voice(
    params: Readonly<Record<string, string>>,
    options: BounceWebhookOptions = OPTIONS,
  ): BounceWebhookResult {
    const body = twilioStatusCallback(params);
    return handleBounceWebhook(
      signed(body, { source: "twilio_voice" }),
      options,
    );
  }

  /** A `failed` callback carrying one code, with everything else Twilio really sends. */
  function failedWith(
    code: string,
    extra: Readonly<Record<string, string>> = {},
  ): BounceWebhookResult {
    return voice({
      CallStatus: "failed",
      CallSid: "CA0123456789abcdef0123456789abcdef",
      To: VOICE_NUMBER,
      From: "+15550000000",
      ErrorCode: code,
      ...extra,
    });
  }

  it("is a declared source, alongside — not instead of — the two that existed", () => {
    expect(BOUNCE_WEBHOOK_SOURCES).toContain("twilio_voice");
    expect(BOUNCE_WEBHOOK_SOURCES).toContain("twilio");
    expect(BOUNCE_WEBHOOK_SOURCES).toContain("ses");
    // The slug is the ProviderKind of TwilioVoiceSender, so `applied_by` and the delivery
    // attempt's provider column are the same string.
    expect(BOUNCE_WEBHOOK_SOURCES).not.toContain("voice");
  });

  it("suppresses an unallocated number, attributed to the voice provider", () => {
    const result = failedWith("21214");
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.event.source).toBe("twilio_voice");
    expect(result.event.channel).toBe("voice_call");
    expect(result.event.kind).toBe("voice_failure");
    expect(result.event.providerCode).toBe("21214");
    expect(result.event.providerMessageId).toBe(
      "CA0123456789abcdef0123456789abcdef",
    );
    expect(result.suppressions).toHaveLength(1);
    const suppression = result.suppressions[0];
    expect(suppression?.channel).toBe("voice_call");
    expect(suppression?.reason).toBe("hard_bounce");
    expect(suppression?.recipientAddress).toBe(VOICE_NUMBER);
    expect(suppression?.appliedBy).toBe("provider:twilio_voice");
    expect(suppression?.expiresAt).toBeNull();
    expect(suppression?.id).toMatch(/^supp_[0-9a-f]{32}$/);
    expect(suppression?.notes).toContain("twilio_voice voice_failure");
    expect(suppression?.notes).toContain("code=21214");
  });

  it("accounts for every CallStatus, and never accepts one with an empty plan", () => {
    for (const CallStatus of TWILIO_CALL_CALLBACK_STATUSES) {
      const result = voice({
        CallStatus,
        To: VOICE_NUMBER,
        CallSid: "CA1",
        // A permanent code on every status, so only the status can decide.
        ErrorCode: "21214",
      });
      if (result.accepted) {
        expect(CallStatus).toBe("failed");
        expect(result.suppressions.length).toBeGreaterThan(0);
      } else {
        expect(result.refusal.length).toBeGreaterThan(0);
        expect(result.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it("never suppresses a busy line, even when a permanent code rides along", () => {
    // The most important test in the file. A person was there and did not pick up; suppressing
    // would silence a working number because somebody was on another call, and `hard_bounce` is
    // unconditional, so it would outrank even a security alert afterwards.
    expectRefusal(
      voice({ CallStatus: "busy", To: VOICE_NUMBER, CallSid: "CA1" }),
      "event_not_suppressible",
    );
    expectRefusal(
      voice({
        CallStatus: "busy",
        To: VOICE_NUMBER,
        ErrorCode: "21214",
        CallSid: "CA1",
      }),
      "event_not_suppressible",
    );
  });

  it("never suppresses a no-answer, even when a permanent code rides along", () => {
    expectRefusal(
      voice({ CallStatus: "no-answer", To: VOICE_NUMBER, CallSid: "CA1" }),
      "event_not_suppressible",
    );
    // The status is checked before the code table precisely so this cannot route around it.
    expectRefusal(
      voice({
        CallStatus: "no-answer",
        To: VOICE_NUMBER,
        ErrorCode: "21211",
        CallSid: "CA1",
      }),
      "event_not_suppressible",
    );
  });

  it("holds the never-suppress set to exactly the two reachable-but-unanswered statuses", () => {
    expect([...VOICE_NEVER_SUPPRESSIBLE_STATUSES].sort()).toEqual([
      "busy",
      "no-answer",
    ]);
    // A tripwire on the sender, not a coupling: a status the sender decides is worth *retrying* is
    // by construction not evidence to suppress on, so one appearing there and not here is a bug.
    for (const status of Object.keys(TWILIO_CALL_RETRYABLE_STATUSES)) {
      expect(VOICE_NEVER_SUPPRESSIBLE_STATUSES.has(status)).toBe(true);
    }
  });

  it("refuses a cancelled call, which is our decision and not a verdict", () => {
    expectRefusal(
      voice({ CallStatus: "canceled", To: VOICE_NUMBER, CallSid: "CA1" }),
      "event_not_suppressible",
    );
  });

  it("refuses a completed call: a delivery is not a bounce", () => {
    expectRefusal(
      voice({
        CallStatus: "completed",
        To: VOICE_NUMBER,
        CallSid: "CA1",
        CallDuration: "14",
      }),
      "event_not_suppressible",
    );
  });

  it("refuses every progress callback, of which there are three per call", () => {
    for (const CallStatus of VOICE_PROGRESS_STATUSES) {
      expectRefusal(
        voice({ CallStatus, To: VOICE_NUMBER, CallSid: "CA1" }),
        "event_not_suppressible",
      );
    }
  });

  it("suppresses on every permanent code in the table", () => {
    for (const [code, reason] of Object.entries(
      TWILIO_VOICE_SUPPRESSION_REASONS,
    )) {
      const result = failedWith(code);
      expect(result.accepted).toBe(true);
      if (!result.accepted) continue;
      expect(result.suppressions[0]?.reason).toBe(reason);
      expect(result.suppressions[0]?.channel).toBe("voice_call");
    }
  });

  it("suppresses on nothing for a transient code, not even briefly", () => {
    for (const code of TWILIO_VOICE_TRANSIENT_CODES) {
      expectRefusal(failedWith(code), "event_not_suppressible");
    }
  });

  it("keeps the two code tables disjoint", () => {
    for (const code of Object.keys(TWILIO_VOICE_SUPPRESSION_REASONS)) {
      expect(TWILIO_VOICE_TRANSIENT_CODES.has(code)).toBe(false);
    }
    // 13225 is Twilio refusing the number; 21216 is Twilio refusing us. Same English, opposite
    // sides of the boundary.
    expect(TWILIO_VOICE_SUPPRESSION_REASONS["13225"]).toBe("hard_bounce");
    expect(TWILIO_VOICE_TRANSIENT_CODES.has("21216")).toBe(true);
    // A geo-permission denial is ours, so it never reaches the suppression table.
    expect(TWILIO_VOICE_SUPPRESSION_REASONS["21215"]).toBeUndefined();
    expect(TWILIO_VOICE_TRANSIENT_CODES.has("21215")).toBe(true);
  });

  it("maps every voice code to hard_bounce, because the channel has no STOP and no FBL", () => {
    for (const reason of Object.values(TWILIO_VOICE_SUPPRESSION_REASONS)) {
      expect(reason).toBe("hard_bounce");
    }
    // SMS 21610 (replied STOP) has no voice analogue: inline TwiML cannot gather a keypress.
    expect(TWILIO_SUPPRESSION_REASONS["21610"]).toBe("unsubscribe");
    expect(Object.values(TWILIO_VOICE_SUPPRESSION_REASONS)).not.toContain(
      "unsubscribe",
    );
    expect(Object.values(TWILIO_VOICE_SUPPRESSION_REASONS)).not.toContain(
      "spam_complaint",
    );
  });

  it("refuses a failure whose code is in neither table", () => {
    expectRefusal(failedWith("99999"), "event_not_suppressible");
    // The SMS-only codes are not silently inherited.
    expect(TWILIO_VOICE_SUPPRESSION_REASONS["30007"]).toBeUndefined();
    expect(TWILIO_VOICE_SUPPRESSION_REASONS["21610"]).toBeUndefined();
  });

  it("refuses a failure that names no code to attribute it to", () => {
    expectRefusal(
      voice({ CallStatus: "failed", To: VOICE_NUMBER, CallSid: "CA1" }),
      "event_not_suppressible",
    );
  });

  it("ignores transientSuppressionHours entirely on this source", () => {
    // Every voice reason is permanent, and the codes a window would otherwise fit describe our
    // own configuration rather than a destination.
    const configured: BounceWebhookOptions = {
      ...OPTIONS,
      transientSuppressionHours: 6,
    };
    expectRefusal(failedWith("21215", {}), "event_not_suppressible");
    expect(
      handleBounceWebhook(
        signed(
          twilioStatusCallback({
            CallStatus: "failed",
            To: VOICE_NUMBER,
            ErrorCode: "21215",
          }),
          { source: "twilio_voice" },
        ),
        configured,
      ).accepted,
    ).toBe(false);
    const permanent = handleBounceWebhook(
      signed(
        twilioStatusCallback({
          CallStatus: "failed",
          To: VOICE_NUMBER,
          ErrorCode: "21214",
        }),
        { source: "twilio_voice" },
      ),
      configured,
    );
    expect(permanent.accepted).toBe(true);
    if (!permanent.accepted) return;
    expect(permanent.suppressions[0]?.expiresAt).toBeNull();
  });

  it("refuses a fax, and says so, rather than suppressing on one heuristic sample", () => {
    const result = voice({
      CallStatus: "completed",
      To: VOICE_NUMBER,
      CallSid: "CA1",
      AnsweredBy: "fax",
    });
    expectRefusal(result, "event_not_suppressible");
    if (result.accepted) return;
    expect(result.reason).toContain("AnsweredBy=fax");
    expect(result.reason).toContain(VOICE_ANSWERED_BY_VERDICTS.fax);
  });

  it("treats voicemail as a delivery, not a failure", () => {
    for (const AnsweredBy of ["machine_start", "machine_end_beep", "human"]) {
      const result = voice({
        CallStatus: "completed",
        To: VOICE_NUMBER,
        CallSid: "CA1",
        AnsweredBy,
      });
      expectRefusal(result, "event_not_suppressible");
      if (result.accepted) continue;
      expect(result.reason).toContain(`AnsweredBy=${AnsweredBy}`);
    }
  });

  it("refuses an unknown machine-detection verdict as evidence of nothing", () => {
    const result = voice({
      CallStatus: "completed",
      To: VOICE_NUMBER,
      CallSid: "CA1",
      AnsweredBy: "unknown",
    });
    expectRefusal(result, "event_not_suppressible");
    if (result.accepted) return;
    expect(result.reason).toContain("no verdict");
  });

  it("gives every AnsweredBy value a stated verdict, and none of them a suppression", () => {
    for (const value of TWILIO_ANSWERED_BY_VALUES) {
      expect(VOICE_ANSWERED_BY_VERDICTS[value].length).toBeGreaterThan(0);
      expect(
        voice({
          CallStatus: "completed",
          To: VOICE_NUMBER,
          CallSid: "CA1",
          AnsweredBy: value,
        }).accepted,
      ).toBe(false);
    }
  });

  it("does not echo an AnsweredBy value Twilio does not define", () => {
    const result = voice({
      CallStatus: "completed",
      To: VOICE_NUMBER,
      CallSid: "CA1",
      AnsweredBy: "<script>alert(1)</script>",
    });
    expectRefusal(result, "event_not_suppressible");
    if (result.accepted) return;
    expect(result.reason).not.toContain("script");
  });

  it("refuses a body carrying no CallStatus", () => {
    expectRefusal(
      voice({ To: VOICE_NUMBER, CallSid: "CA1" }),
      "payload_unrecognized",
    );
    expect(recognizeTwilioVoiceStatusCallback("").ok).toBe(false);
    expect(recognizeTwilioVoiceStatusCallback("garbage").ok).toBe(false);
  });

  it("names the misroute when a messaging callback arrives on the voice source", () => {
    const result = voice({
      MessageStatus: "failed",
      ErrorCode: "21211",
      To: VOICE_NUMBER,
    });
    expectRefusal(result, "payload_unrecognized");
    if (result.accepted) return;
    expect(result.reason).toContain("messaging status callback");
    const legacy = voice({ SmsStatus: "failed", To: VOICE_NUMBER });
    expectRefusal(legacy, "payload_unrecognized");
  });

  it("refuses a CallStatus Twilio does not define, rather than calling it 'not a failure'", () => {
    // A status we have never seen is a Twilio change or our bug. Answering `event_not_suppressible`
    // would assert we understood it and found nothing to do, which is how a dead number keeps
    // being called.
    for (const CallStatus of ["answered", "delivered", "ok", "FAILED"]) {
      expectRefusal(
        voice({ CallStatus, To: VOICE_NUMBER, ErrorCode: "21214" }),
        "payload_unrecognized",
      );
    }
  });

  it("refuses a callback carrying no destination", () => {
    expectRefusal(
      voice({ CallStatus: "failed", ErrorCode: "21214", CallSid: "CA1" }),
      "recipient_missing",
    );
  });

  it("refuses a destination that is not a telephone number at all", () => {
    // Live, not hypothetical: the recipient directory hands voice_call an email address today, and
    // 21211 against one would be our own misconfiguration recorded as an unconditional verdict
    // about the callee.
    const result = failedWith("21211", { To: "ops@example.test" });
    expectRefusal(result, "recipient_missing");
    if (result.accepted) return;
    expect(result.reason).toContain("16 chars");
    expect(result.reason).not.toContain("ops@example.test");
    // A SIP or Client destination lands here too: no code in the table describes one.
    expectRefusal(
      failedWith("21214", { To: "client:alice" }),
      "recipient_missing",
    );
    expectRefusal(
      failedWith("21214", { To: "sip:alice@example.test" }),
      "recipient_missing",
    );
  });

  it("refuses a destination longer than the column allows", () => {
    expectRefusal(
      failedWith("21214", { To: `+1${"5".repeat(600)}` }),
      "recipient_missing",
    );
  });

  it("carries the CallSid as the provider message id, and nothing else, into the note", () => {
    const result = failedWith("21217");
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const notes = result.suppressions[0]?.notes ?? "";
    expect(notes).toContain("provider_message=CA0123456789abcdef0123456789abcdef");
    expect(notes).toContain("code=21217");
    // The number is the row's subject, not its provenance.
    expect(notes).not.toContain(VOICE_NUMBER);
    expect(notes).not.toContain("5551234567");
  });

  it("never puts the destination number in a refusal reason", () => {
    const refusals = [
      voice({ CallStatus: "busy", To: VOICE_NUMBER, CallSid: "CA1" }),
      voice({ CallStatus: "no-answer", To: VOICE_NUMBER }),
      voice({ CallStatus: "canceled", To: VOICE_NUMBER }),
      voice({ CallStatus: "completed", To: VOICE_NUMBER, AnsweredBy: "fax" }),
      voice({ CallStatus: "ringing", To: VOICE_NUMBER }),
      voice({ CallStatus: "failed", To: VOICE_NUMBER }),
      voice({ CallStatus: "nonsense", To: VOICE_NUMBER }),
      voice({ To: VOICE_NUMBER }),
      failedWith("99999"),
      failedWith("21215"),
      failedWith("21211", { To: "ops@example.test" }),
    ];
    for (const result of refusals) {
      expect(result.accepted).toBe(false);
      if (result.accepted) continue;
      expect(result.reason).not.toContain(VOICE_NUMBER);
      expect(result.reason).not.toContain("5551234567");
      expect(result.reason).not.toContain("ops@example.test");
    }
  });

  it("plans the identical record for a re-delivered callback", () => {
    // Twilio posts per call and may repost; the id commits to the address and the reason, never to
    // the CallSid, so a repost re-asserts one row instead of adding a second.
    const first = failedWith("21214");
    const second = failedWith("21214", {
      CallSid: "CAffffffffffffffffffffffffffffffff",
    });
    expect(first.accepted && second.accepted).toBe(true);
    if (!first.accepted || !second.accepted) return;
    expect(first.suppressions[0]?.id).toBe(second.suppressions[0]?.id);
  });

  it("normalizes a formatted destination before deriving the id", () => {
    const result = failedWith("21214", { To: "+1 (555) 123-4567" });
    // `isE164` is applied to the number as Twilio wrote it, so a punctuated To is refused rather
    // than silently canonicalised — Twilio sends E.164 on the wire.
    expectRefusal(result, "recipient_missing");
    const plain = failedWith("21214");
    expect(plain.accepted).toBe(true);
    if (!plain.accepted) return;
    expect(
      findActiveSuppression(plain.suppressions, "voice_call", VOICE_NUMBER, NOW),
    ).not.toBeNull();
  });

  it("suppresses the voice channel only, leaving the same number's sms alone", () => {
    const result = failedWith("21214");
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(
      findActiveSuppression(result.suppressions, "voice_call", VOICE_NUMBER, NOW),
    ).not.toBeNull();
    expect(
      findActiveSuppression(result.suppressions, "sms", VOICE_NUMBER, NOW),
    ).toBeNull();
    // And the two channels' ids differ, so neither row can stand in for the other.
    expect(result.suppressions[0]?.id).not.toBe(
      suppressionIdFor({
        tenantId: TEST_TENANT_ID,
        channel: "sms",
        recipientAddress: VOICE_NUMBER,
        reason: "hard_bounce",
      }),
    );
  });

  it("refuses an empty body on the voice source before reading it", () => {
    expectRefusal(
      handleBounceWebhook(signed("", { source: "twilio_voice" }), OPTIONS),
      "body_unparseable",
    );
  });

  it("does not parse a voice callback with the messaging recognizer", () => {
    // The source is the deployment's declaration of which sender it configured; the channel is
    // never sniffed out of the payload.
    const body = twilioStatusCallback({
      CallStatus: "failed",
      To: VOICE_NUMBER,
      ErrorCode: "21214",
    });
    expect(recognizeTwilioStatusCallback(body).ok).toBe(false);
    expect(recognizeTwilioVoiceStatusCallback(body).ok).toBe(true);
  });
});

describe("planning a suppression", () => {
  it("derives a stable id from tenant, channel, address and reason", () => {
    const key = {
      tenantId: TEST_TENANT_ID,
      channel: "email" as const,
      recipientAddress: "gone@example.test",
      reason: "hard_bounce" as const,
    };
    expect(suppressionIdFor(key)).toBe(suppressionIdFor(key));
    expect(suppressionIdFor({ ...key, reason: "spam_complaint" })).not.toBe(
      suppressionIdFor(key),
    );
    expect(suppressionIdFor({ ...key, channel: "sms" })).not.toBe(
      suppressionIdFor(key),
    );
  });

  it("plans the identical record for a replayed webhook", () => {
    const body = sesBounceEvent({});
    const first = handleBounceWebhook(signed(body), OPTIONS);
    const second = handleBounceWebhook(signed(body), OPTIONS);
    expect(first.accepted && second.accepted).toBe(true);
    if (!first.accepted || !second.accepted) return;
    expect(first.suppressions).toEqual(second.suppressions);
  });

  it("forces expiresAt null for a permanent reason even if one is passed", () => {
    const planned = planSuppression({
      tenantId: TEST_TENANT_ID,
      channel: "email",
      recipientAddress: "gone@example.test",
      reason: "hard_bounce",
      appliedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    });
    expect(planned?.expiresAt).toBeNull();
  });

  it("returns null rather than an unpersistable record", () => {
    expect(
      planSuppression({
        tenantId: "not-a-uuid",
        channel: "email",
        recipientAddress: "gone@example.test",
        reason: "hard_bounce",
        appliedAt: NOW,
        expiresAt: null,
      }),
    ).toBeNull();
  });

  it("refuses the whole webhook when a record cannot be built", () => {
    expectRefusal(
      handleBounceWebhook(
        signed(sesBounceEvent({}), { tenantId: "not-a-uuid" }),
        OPTIONS,
      ),
      "invalid_suppression",
    );
  });

  it("keeps the note inside the column, and omits what the provider did not say", () => {
    const note = suppressionNotes({
      source: "ses",
      channel: "email",
      kind: "hard_bounce",
      addresses: ["a@example.test"],
      providerMessageId: "m".repeat(800),
      providerCode: "Permanent/General",
    });
    expect(note).toBeDefined();
    expect((note ?? "").length).toBeLessThanOrEqual(500);
    expect(
      suppressionNotes({
        source: "twilio",
        channel: "sms",
        kind: "sms_failure",
        addresses: ["+15551234567"],
        providerMessageId: null,
        providerCode: null,
      }),
    ).toBe("twilio sms_failure");
  });
});

describe("address normalization", () => {
  it("maps every channel to a rule", () => {
    for (const channel of NOTIFICATION_CHANNELS) {
      expect(ADDRESS_NORMALIZATION_RULES).toContain(
        CHANNEL_ADDRESS_NORMALIZATION[channel],
      );
    }
  });

  it("gives the sms and voice channels the same rule, and not the email one", () => {
    expect(CHANNEL_ADDRESS_NORMALIZATION.sms).toBe("phone");
    expect(CHANNEL_ADDRESS_NORMALIZATION.voice_call).toBe("phone");
    expect(CHANNEL_ADDRESS_NORMALIZATION.email).toBe("email");
  });

  it("is idempotent for every rule, on every channel", () => {
    const samples = [
      "Bounced@Example.test",
      "<Gone@Example.TEST>",
      "+1 (555) 123-4567",
      "tel:+15551234567",
      "11111111-1111-4111-8111-111111111111".toUpperCase(),
      "dQw4w9WgXcQ:APA91bH_Token",
      "https://hook.example.test/Path",
    ];
    for (const channel of NOTIFICATION_CHANNELS) {
      for (const sample of samples) {
        const once = normalizeRecipientAddress(channel, sample);
        expect(normalizeRecipientAddress(channel, once)).toBe(once);
      }
    }
  });

  it("never lengthens an address, so the column bound still holds", () => {
    for (const channel of NOTIFICATION_CHANNELS) {
      for (const sample of ["  A@B.test ", "+1 555 123 4567", "<x@y.test>"]) {
        expect(
          normalizeRecipientAddress(channel, sample).length,
        ).toBeLessThanOrEqual(sample.length);
      }
    }
  });

  describe("email", () => {
    it("folds case across the whole address", () => {
      expect(normalizeEmailAddress("Bounced@Example.test")).toBe(
        "bounced@example.test",
      );
    });

    it("strips one surrounding pair of angle brackets", () => {
      expect(normalizeEmailAddress(" <Gone@Example.test> ")).toBe(
        "gone@example.test",
      );
    });

    it("leaves a display form alone rather than parsing an address out of it", () => {
      expect(normalizeEmailAddress('"Ops" <o@e.test>')).toBe('"ops" <o@e.test>');
    });

    it("keeps subaddressing, which would otherwise widen one bounce into many", () => {
      expect(normalizeEmailAddress("Ops+Alerts@Example.test")).toBe(
        "ops+alerts@example.test",
      );
      expect(normalizeEmailAddress("ops+alerts@example.test")).not.toBe(
        normalizeEmailAddress("ops@example.test"),
      );
    });
  });

  describe("phone", () => {
    it("drops the punctuation a provider or a human writes", () => {
      expect(normalizePhoneAddress("+1 (555) 123-4567")).toBe("+15551234567");
      expect(normalizePhoneAddress(" tel:+1.555.123.4567 ")).toBe("+15551234567");
      expect(normalizePhoneAddress("555 123 4567")).toBe("5551234567");
    });

    it("neither adds nor removes the leading plus", () => {
      expect(normalizePhoneAddress("15551234567")).toBe("15551234567");
      expect(normalizePhoneAddress("+15551234567")).toBe("+15551234567");
      expect(normalizePhoneAddress("15551234567")).not.toBe(
        normalizePhoneAddress("+15551234567"),
      );
    });

    it("leaves a value that is not a phone number untouched beyond trimming", () => {
      // Live, not hypothetical: the recipient directory hands sms and voice an email today.
      expect(normalizePhoneAddress(" ops@example.test ")).toBe("ops@example.test");
      expect(normalizePhoneAddress("+1-555-EXT")).toBe("+1-555-EXT");
    });
  });

  describe("opaque", () => {
    it("lowercases a UUID, which is what the resolver supplies for in_app and push", () => {
      const upper = TEST_TENANT_ID.toUpperCase();
      expect(normalizeOpaqueAddress(upper)).toBe(TEST_TENANT_ID);
    });

    it("never folds the case of a push registration token", () => {
      const token = "dQw4w9WgXcQ:APA91bHShapeOnly_0123456789abcdefgh";
      expect(normalizeOpaqueAddress(` ${token} `)).toBe(token);
    });

    it("never folds the case of a webhook url path", () => {
      expect(normalizeOpaqueAddress("https://Hook.example.test/Path")).toBe(
        "https://Hook.example.test/Path",
      );
    });
  });
});

describe("planSuppression normalizes before deriving the id", () => {
  it("plans the lowercased address an email bounce actually mails", () => {
    const planned = planSuppression({
      tenantId: TEST_TENANT_ID,
      channel: "email",
      recipientAddress: "Bounced@Example.test",
      reason: "hard_bounce",
      appliedAt: NOW,
      expiresAt: null,
    });
    expect(planned?.recipientAddress).toBe("bounced@example.test");
  });

  it("gives two spellings of one address the same id, so a replay re-asserts one row", () => {
    const ids = ["Bounced@Example.test", "bounced@example.test", "<BOUNCED@EXAMPLE.TEST>"].map(
      (recipientAddress) =>
        planSuppression({
          tenantId: TEST_TENANT_ID,
          channel: "email",
          recipientAddress,
          reason: "hard_bounce",
          appliedAt: NOW,
          expiresAt: null,
        })?.id,
    );
    expect(new Set(ids).size).toBe(1);
  });

  it("keeps the id a commitment to the address the row actually holds", () => {
    const planned = planSuppression({
      tenantId: TEST_TENANT_ID,
      channel: "email",
      recipientAddress: "Bounced@Example.test",
      reason: "hard_bounce",
      appliedAt: NOW,
      expiresAt: null,
    });
    expect(planned?.id).toBe(
      suppressionIdFor({
        tenantId: TEST_TENANT_ID,
        channel: "email",
        recipientAddress: planned?.recipientAddress ?? "",
        reason: "hard_bounce",
      }),
    );
  });

  it("normalizes an sms number by format, not by case", () => {
    const planned = planSuppression({
      tenantId: TEST_TENANT_ID,
      channel: "sms",
      recipientAddress: "+1 (555) 123-4567",
      reason: "hard_bounce",
      appliedAt: NOW,
      expiresAt: null,
    });
    expect(planned?.recipientAddress).toBe("+15551234567");
  });

  it("matches a mixed-case SES bounce against the address the platform sends to", () => {
    const result = handleBounceWebhook(
      signed(sesBounceEvent({ addresses: ["Bounced@Example.test"] })),
      OPTIONS,
    );
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.suppressions[0]?.recipientAddress).toBe("bounced@example.test");
    // The event keeps the provider's verbatim claim; only the planned row is canonical.
    expect(result.event.addresses).toEqual(["Bounced@Example.test"]);
    expect(
      findActiveSuppression(
        result.suppressions,
        "email",
        "bounced@example.test",
        NOW,
      ),
    ).not.toBeNull();
  });

  it("matches a differently formatted Twilio number against the stored one", () => {
    const result = handleBounceWebhook(
      signed(
        twilioStatusCallback({
          MessageStatus: "failed",
          To: "+1 (555) 123-4567",
          ErrorCode: "21211",
          MessageSid: "SM1",
        }),
        { source: "twilio" },
      ),
      OPTIONS,
    );
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(
      findActiveSuppression(result.suppressions, "sms", "+15551234567", NOW),
    ).not.toBeNull();
  });
});
