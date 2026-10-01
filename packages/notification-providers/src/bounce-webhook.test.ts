import { describe, expect, it } from "vitest";

import {
  DEFAULT_BOUNCE_TOLERANCE_SECONDS,
  handleBounceWebhook,
  planSuppression,
  recognizeSesEvent,
  recognizeTwilioStatusCallback,
  suppressionIdFor,
  suppressionNotes,
  TWILIO_SUPPRESSION_REASONS,
  unwrapSnsEnvelope,
  type BounceWebhookOptions,
  type BounceWebhookRequest,
  type BounceWebhookResult,
} from "./bounce-webhook.js";
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
    expect(suppression?.appliedBy).toBeNull();
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
