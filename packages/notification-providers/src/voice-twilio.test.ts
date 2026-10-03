import { describe, expect, it } from "vitest";

import type { FetchLike } from "./email-ses.js";
import { basicAuthHeader, TWILIO_API_BASE_URL } from "./sms-twilio.js";
import {
  FakeFetch,
  sendRequest,
  TEST_E164_NUMBER,
  throwingFetch,
} from "./test-fakes.js";
import {
  classifyVoiceCallStatus,
  DEFAULT_VOICE_LANGUAGE,
  DEFAULT_VOICE_PAUSE_SECONDS,
  DEFAULT_VOICE_REPEAT_COUNT,
  defaultVoiceComposer,
  escapeXmlText,
  isE164,
  MAX_TWIML_CHARACTERS,
  MAX_VOICE_REPEAT_COUNT,
  renderVoiceTwiml,
  stripXmlForbiddenChars,
  TWILIO_CALL_ACCEPTED_STATUSES,
  twilioCallsPath,
  TwilioVoiceSender,
  VOICE_RECIPIENT_REFUSED_ERROR_CODE,
  voiceLanguageFor,
  type TwilioVoiceSenderOptions,
} from "./voice-twilio.js";

const ACCOUNT_SID = "AC00000000000000000000000000000001";
const FROM_NUMBER = "+15550000000";

function sender(
  fetchImpl: FetchLike,
  overrides: Partial<TwilioVoiceSenderOptions> = {},
): TwilioVoiceSender {
  return new TwilioVoiceSender({
    accountSid: ACCOUNT_SID,
    authToken: "auth-token-value",
    fromNumber: FROM_NUMBER,
    fetchImpl,
    ...overrides,
  });
}

function voiceRequest(): ReturnType<typeof sendRequest> {
  return sendRequest({
    channel: "voice_call",
    recipientAddress: TEST_E164_NUMBER,
  });
}

const QUEUED = (): FakeFetch =>
  new FakeFetch([
    { status: 201, body: '{"sid":"CA9","status":"queued","to":"+15551234567"}' },
  ]);

const TWIML_OPTS = {
  language: DEFAULT_VOICE_LANGUAGE,
  repeatCount: 1,
  pauseSeconds: DEFAULT_VOICE_PAUSE_SECONDS,
};

describe("request shape helpers", () => {
  it("builds the 2010-04-01 Calls resource path", () => {
    expect(twilioCallsPath(ACCOUNT_SID)).toBe(
      `/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`,
    );
  });

  it("url-encodes an account sid in the path", () => {
    expect(twilioCallsPath("a/b")).toBe("/2010-04-01/Accounts/a%2Fb/Calls.json");
  });

  it("composes a default notice carrying no tenant data at all", () => {
    const spoken = defaultVoiceComposer(voiceRequest());
    expect(spoken).toContain("automated call from CrossEngin");
    expect(spoken).not.toContain("design_review.approved");
    expect(spoken).not.toContain("disp_");
  });
});

describe("TwiML rendering", () => {
  it("escapes every character that is markup in XML", () => {
    expect(escapeXmlText(`a&b<c>d"e'f`)).toBe(
      "a&amp;b&lt;c&gt;d&quot;e&apos;f",
    );
  });

  it("drops the control characters XML cannot represent at all", () => {
    expect(escapeXmlText("a\u0000b\u000Bc\u007Fd")).toBe("abcd");
    expect(stripXmlForbiddenChars("keep\tthis\nand\rthis")).toBe(
      "keep\tthis\nand\rthis",
    );
  });

  it("cannot be made to inject a verb through the spoken text", () => {
    const twiml = renderVoiceTwiml(
      '</Say><Dial>+15559998888</Dial><Say>',
      TWIML_OPTS,
    );
    // The only element-opening `<` in the document are the ones this function wrote.
    expect(twiml).not.toContain("<Dial>");
    expect(twiml).toContain("&lt;Dial&gt;");
  });

  it("wraps the notice in a Response with the locale as the Say language", () => {
    expect(renderVoiceTwiml("hello", { ...TWIML_OPTS, language: "fr-FR" })).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say language="fr-FR">hello</Say></Response>',
    );
  });

  it("repeats the notice with a pause between passes", () => {
    const twiml = renderVoiceTwiml("hi", { ...TWIML_OPTS, repeatCount: 2 });
    expect(twiml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response>' +
        '<Say language="en-US">hi</Say>' +
        '<Pause length="1"/>' +
        '<Say language="en-US">hi</Say>' +
        "</Response>",
    );
  });

  it("falls back to en-US for a language Twilio would not know", () => {
    expect(voiceLanguageFor("not a locale")).toBe(DEFAULT_VOICE_LANGUAGE);
    expect(voiceLanguageFor('en" onload="x')).toBe(DEFAULT_VOICE_LANGUAGE);
    expect(voiceLanguageFor("ar-SA")).toBe("ar-SA");
  });

  it("clips the spoken text, not the document, when it would exceed Twilio's cap", () => {
    const twiml = renderVoiceTwiml("x".repeat(9000), TWIML_OPTS);
    expect(twiml.length).toBeLessThanOrEqual(MAX_TWIML_CHARACTERS);
    expect(twiml.startsWith('<?xml version="1.0" encoding="UTF-8"?><Response>')).toBe(
      true,
    );
    expect(twiml.endsWith("</Say></Response>")).toBe(true);
  });

  it("keeps the clipped document well-formed when the clip lands inside an entity", () => {
    // Every character escapes to five, so a long run of `&` makes the budget land mid-entity.
    const twiml = renderVoiceTwiml("&".repeat(2000), TWIML_OPTS);
    expect(twiml.length).toBeLessThanOrEqual(MAX_TWIML_CHARACTERS);
    expect(/&(?!amp;)/.test(twiml)).toBe(false);
  });

  it("respects the cap with every repeat count", () => {
    for (let n = 1; n <= MAX_VOICE_REPEAT_COUNT; n += 1) {
      const twiml = renderVoiceTwiml("y".repeat(9000), {
        ...TWIML_OPTS,
        repeatCount: n,
      });
      expect(twiml.length).toBeLessThanOrEqual(MAX_TWIML_CHARACTERS);
    }
  });
});

describe("construction", () => {
  it("rejects a missing account sid", () => {
    expect(() => sender(new FakeFetch().fn, { accountSid: "" })).toThrow(
      /accountSid/,
    );
  });

  it("rejects having no credential pair at all", () => {
    expect(
      () =>
        new TwilioVoiceSender({
          accountSid: ACCOUNT_SID,
          fromNumber: FROM_NUMBER,
          fetchImpl: new FakeFetch().fn,
        }),
    ).toThrow(/apiKeySid \+ apiKeySecret or authToken/);
  });

  it("rejects a caller id that is not E.164", () => {
    expect(() => sender(new FakeFetch().fn, { fromNumber: "5550000000" })).toThrow(
      /E\.164/,
    );
    expect(() => sender(new FakeFetch().fn, { fromNumber: "" })).toThrow(/E\.164/);
  });

  it("rejects a repeat count outside 1..5", () => {
    for (const repeatCount of [0, -1, 6, 1.5]) {
      expect(() => sender(new FakeFetch().fn, { repeatCount })).toThrow(
        /repeatCount/,
      );
    }
  });

  it("rejects a fallback language it would interpolate unescaped", () => {
    expect(() =>
      sender(new FakeFetch().fn, { language: '"><Dial>+1555</Dial>' }),
    ).toThrow(/language/);
  });

  it("prefers an api key over the account auth token for Basic auth", async () => {
    const fake = QUEUED();
    await sender(fake.fn, { apiKeySid: "SK1", apiKeySecret: "key-secret" }).send(
      voiceRequest(),
    );
    expect(fake.only.headers["authorization"]).toBe(
      basicAuthHeader("SK1", "key-secret"),
    );
  });
});

describe("send", () => {
  it("POSTs an inline-TwiML call to the Calls resource", async () => {
    const fake = QUEUED();
    const result = await sender(fake.fn).send(voiceRequest());

    expect(fake.only.method).toBe("POST");
    expect(fake.only.url).toBe(
      `${TWILIO_API_BASE_URL}/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`,
    );
    expect(fake.only.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(fake.only.headers["accept"]).toBe("application/json");
    expect(fake.only.headers["authorization"]).toBe(
      basicAuthHeader(ACCOUNT_SID, "auth-token-value"),
    );

    const form = new URLSearchParams(fake.only.body ?? "");
    expect(form.get("To")).toBe(TEST_E164_NUMBER);
    expect(form.get("From")).toBe(FROM_NUMBER);
    expect(form.get("Twiml")).toContain("<Say language=\"en-US\">");
    // The decision: TwiML inline, never a Url for Twilio to fetch.
    expect(form.get("Url")).toBeNull();

    expect(result.outcome).toBe("delivered");
    expect(result.provider).toBe("twilio_voice");
    expect(result.providerMessageId).toBe("CA9");
    expect(result.httpStatus).toBe(201);
    expect(result.bytesSent).toBe(Buffer.byteLength(fake.only.body ?? ""));
    expect(result.errorCode).toBeNull();
  });

  it("speaks the notice twice by default", async () => {
    const fake = QUEUED();
    await sender(fake.fn).send(voiceRequest());
    const twiml = new URLSearchParams(fake.only.body ?? "").get("Twiml") ?? "";
    expect(twiml.split("<Say").length - 1).toBe(DEFAULT_VOICE_REPEAT_COUNT);
  });

  it("speaks in the dispatch's locale", async () => {
    const fake = QUEUED();
    await sender(fake.fn).send(
      sendRequest({
        channel: "voice_call",
        recipientAddress: TEST_E164_NUMBER,
        locale: "de-DE",
      }),
    );
    expect(new URLSearchParams(fake.only.body ?? "").get("Twiml")).toContain(
      'language="de-DE"',
    );
  });

  it("asks for the status callback events that carry AnsweredBy", async () => {
    const fake = QUEUED();
    await sender(fake.fn, {
      statusCallbackUrl: "https://api.example.test/v1/webhooks/twilio-voice",
      machineDetection: "DetectMessageEnd",
    }).send(voiceRequest());

    const form = new URLSearchParams(fake.only.body ?? "");
    expect(form.get("StatusCallback")).toBe(
      "https://api.example.test/v1/webhooks/twilio-voice",
    );
    expect(form.get("StatusCallbackEvent")).toContain("answered");
    expect(form.get("MachineDetection")).toBe("DetectMessageEnd");
  });

  it("omits machine detection and the callback when unconfigured", async () => {
    const fake = QUEUED();
    await sender(fake.fn).send(voiceRequest());
    const form = new URLSearchParams(fake.only.body ?? "");
    expect(form.get("StatusCallback")).toBeNull();
    expect(form.get("MachineDetection")).toBeNull();
  });

  it("refuses a channel it is not the sender for", async () => {
    const fake = new FakeFetch();
    const result = await sender(fake.fn).send(sendRequest({ channel: "sms" }));
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("channel_mismatch");
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses an email address in place of a number, without suppressing it", async () => {
    const fake = new FakeFetch();
    const result = await sender(fake.fn).send(
      sendRequest({ channel: "voice_call", recipientAddress: "ops@example.test" }),
    );
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe(VOICE_RECIPIENT_REFUSED_ERROR_CODE);
    expect(result.errorMessage).not.toContain("ops@example.test");
    expect(fake.requests).toHaveLength(0);
  });

  it("treats every accepted call status as provider acceptance", async () => {
    for (const status of TWILIO_CALL_ACCEPTED_STATUSES) {
      const fake = new FakeFetch([
        { status: 201, body: JSON.stringify({ sid: "CA1", status }) },
      ]);
      expect((await sender(fake.fn).send(voiceRequest())).outcome).toBe(
        "delivered",
      );
    }
  });

  it("retries a busy line and an unanswered call rather than suppressing the number", async () => {
    for (const [status, code] of [
      ["busy", "twilio_voice_busy"],
      ["no-answer", "twilio_voice_no_answer"],
    ] as const) {
      const fake = new FakeFetch([
        { status: 201, body: JSON.stringify({ sid: "CA1", status }) },
      ]);
      const result = await sender(fake.fn).send(voiceRequest());
      expect(result.outcome).toBe("failed");
      expect(result.errorCode).toBe(code);
      expect(result.providerMessageId).toBe("CA1");
    }
  });

  it("classifies a 2xx whose call status already failed by its error code", async () => {
    const fake = new FakeFetch([
      {
        status: 201,
        body: '{"sid":"CA1","status":"failed","error_code":"21211"}',
      },
    ]);
    const result = await sender(fake.fn).send(voiceRequest());
    expect(result.outcome).toBe("bounced_hard");
    expect(result.errorCode).toBe("twilio_21211");
  });

  it("treats a cancelled call as terminal without inventing a reason", async () => {
    const fake = new FakeFetch([
      { status: 201, body: '{"sid":"CA1","status":"canceled"}' },
    ]);
    const result = await sender(fake.fn).send(voiceRequest());
    expect(result.outcome).toBe("dropped");
    expect(result.errorCode).toBe("twilio_voice_canceled");
  });

  it("maps an unowned caller id to a retryable failed", async () => {
    const fake = new FakeFetch([
      {
        status: 400,
        body: '{"code":21606,"message":"The From phone number is not a valid, SMS-capable Twilio phone number"}',
      },
    ]);
    const result = await sender(fake.fn).send(voiceRequest());
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("twilio_21606");
  });

  it("maps a 429 to rate_limited and a 5xx to a retryable failed", async () => {
    const throttled = new FakeFetch([{ status: 429, body: '{"code":20429}' }]);
    expect((await sender(throttled.fn).send(voiceRequest())).outcome).toBe(
      "rate_limited",
    );
    const down = new FakeFetch([{ status: 502, body: "" }]);
    const result = await sender(down.fn).send(voiceRequest());
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("twilio_server_error");
  });

  it("accepts a 2xx with an unreadable body", async () => {
    const fake = new FakeFetch([{ status: 201, body: "<html/>" }]);
    const result = await sender(fake.fn).send(voiceRequest());
    expect(result.outcome).toBe("delivered");
    expect(result.providerMessageId).toBeNull();
  });

  it("keeps the Twiml parameter inside Twilio's cap for a long composer", async () => {
    const fake = QUEUED();
    const built = sender(fake.fn, {
      compose: () => "z".repeat(20_000),
    }).buildRequestBody(voiceRequest());
    expect(built.twimlChars).toBeLessThanOrEqual(MAX_TWIML_CHARACTERS);
  });

  it("lets a transport failure propagate to the drain", async () => {
    await expect(
      sender(throwingFetch("EPIPE")).send(voiceRequest()),
    ).rejects.toThrow("EPIPE");
  });
});

describe("E.164 recognition", () => {
  it("accepts a plausible international number", () => {
    for (const number of ["+15551234567", "+441632960961", "+9661234567"]) {
      expect(isE164(number)).toBe(true);
    }
  });

  it("rejects a number with punctuation, a leading zero, or no plus", () => {
    for (const number of [
      "+1 (555) 123-4567",
      "+05551234567",
      "15551234567",
      "ops@example.test",
      "",
      `+${"9".repeat(16)}`,
    ]) {
      expect(isE164(number)).toBe(false);
    }
  });
});

describe("call status classification", () => {
  it("routes an unknown status through the shared Twilio rule", () => {
    expect(classifyVoiceCallStatus("weird", 20003).outcome).toBe("failed");
    expect(classifyVoiceCallStatus("weird", 99999).outcome).toBe("dropped");
  });

  it("does not need an error code for busy or no-answer", () => {
    expect(classifyVoiceCallStatus("busy", null).outcome).toBe("failed");
    expect(classifyVoiceCallStatus("no-answer", null).outcome).toBe("failed");
  });
});
