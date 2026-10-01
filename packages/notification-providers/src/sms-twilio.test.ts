import { describe, expect, it } from "vitest";

import type { FetchLike } from "./email-ses.js";
import { FakeFetch, sendRequest, throwingFetch } from "./test-fakes.js";
import {
  basicAuthHeader,
  classifyTwilioFailure,
  defaultSmsComposer,
  encodeTwilioForm,
  MAX_SMS_SEGMENTS,
  parseTwilioErrorBody,
  TWILIO_ACCEPTED_STATUSES,
  TWILIO_API_BASE_URL,
  twilioMessagesPath,
  TwilioSmsSender,
  type TwilioSmsSenderOptions,
} from "./sms-twilio.js";

const ACCOUNT_SID = "AC00000000000000000000000000000001";

function sender(
  fetchImpl: FetchLike,
  overrides: Partial<TwilioSmsSenderOptions> = {},
): TwilioSmsSender {
  return new TwilioSmsSender({
    accountSid: ACCOUNT_SID,
    authToken: "auth-token-value",
    fromNumber: "+15550000000",
    fetchImpl,
    ...overrides,
  });
}

function smsRequest(): ReturnType<typeof sendRequest> {
  return sendRequest({ channel: "sms", recipientAddress: "+15551234567" });
}

describe("request shape helpers", () => {
  it("builds the 2010-04-01 Messages resource path", () => {
    expect(twilioMessagesPath(ACCOUNT_SID)).toBe(
      `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
    );
  });

  it("url-encodes an account sid in the path", () => {
    expect(twilioMessagesPath("a/b")).toBe("/2010-04-01/Accounts/a%2Fb/Messages.json");
  });

  it("form-encodes keys and values and skips undefined", () => {
    expect(
      encodeTwilioForm({ To: "+1 555", Body: "a&b=c", Skip: undefined, N: 2 }),
    ).toBe("To=%2B1%20555&Body=a%26b%3Dc&N=2");
  });

  it("builds a Basic credential from a user and pass", () => {
    expect(basicAuthHeader("sid", "secret")).toBe(
      `Basic ${Buffer.from("sid:secret", "utf8").toString("base64")}`,
    );
  });

  it("composes a default body carrying only the template id", () => {
    expect(defaultSmsComposer(smsRequest())).toBe(
      "CrossEngin: a notification (design_review.approved) is waiting for you.",
    );
  });
});

describe("construction", () => {
  it("rejects a missing account sid", () => {
    expect(() => sender(new FakeFetch().fn, { accountSid: "" })).toThrow(/accountSid/);
  });

  it("rejects having no credential pair at all", () => {
    expect(
      () =>
        new TwilioSmsSender({
          accountSid: ACCOUNT_SID,
          fromNumber: "+15550000000",
          fetchImpl: new FakeFetch().fn,
        }),
    ).toThrow(/apiKeySid \+ apiKeySecret or authToken/);
  });

  it("rejects both sender identities, and neither", () => {
    expect(() =>
      sender(new FakeFetch().fn, { messagingServiceSid: "MG1" }),
    ).toThrow(/exactly one of fromNumber or messagingServiceSid/);
    expect(
      () =>
        new TwilioSmsSender({
          accountSid: ACCOUNT_SID,
          authToken: "t",
          fetchImpl: new FakeFetch().fn,
        }),
    ).toThrow(/exactly one of fromNumber or messagingServiceSid/);
  });

  it("prefers an api key over the account auth token for Basic auth", async () => {
    const fake = new FakeFetch([{ status: 201, body: '{"sid":"SM1","status":"queued"}' }]);
    await sender(fake.fn, {
      apiKeySid: "SK1",
      apiKeySecret: "key-secret",
    }).send(smsRequest());
    expect(fake.only.headers["authorization"]).toBe(basicAuthHeader("SK1", "key-secret"));
  });

  it("falls back to account sid and auth token when no api key is given", async () => {
    const fake = new FakeFetch([{ status: 201, body: '{"sid":"SM1","status":"queued"}' }]);
    await sender(fake.fn).send(smsRequest());
    expect(fake.only.headers["authorization"]).toBe(
      basicAuthHeader(ACCOUNT_SID, "auth-token-value"),
    );
  });
});

describe("send", () => {
  it("POSTs a form-encoded message to the Messages resource", async () => {
    const fake = new FakeFetch([
      { status: 201, body: '{"sid":"SM9","status":"queued","num_segments":"1"}' },
    ]);
    const result = await sender(fake.fn).send(smsRequest());

    expect(fake.only.method).toBe("POST");
    expect(fake.only.url).toBe(
      `${TWILIO_API_BASE_URL}/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
    );
    expect(fake.only.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(fake.only.headers["accept"]).toBe("application/json");
    expect(fake.only.body).toContain("To=%2B15551234567");
    expect(fake.only.body).toContain("From=%2B15550000000");
    expect(fake.only.body).toContain("Body=CrossEngin");

    expect(result.outcome).toBe("delivered");
    expect(result.provider).toBe("twilio");
    expect(result.providerMessageId).toBe("SM9");
    expect(result.httpStatus).toBe(201);
    expect(result.smsSegments).toBe(1);
    expect(result.errorCode).toBeNull();
  });

  it("sends MessagingServiceSid instead of From when configured that way", async () => {
    const fake = new FakeFetch([{ status: 201, body: '{"sid":"SM1","status":"accepted"}' }]);
    await sender(fake.fn, {
      fromNumber: undefined,
      messagingServiceSid: "MG00000000000000000000000000000001",
    }).send(smsRequest());
    expect(fake.only.body).toContain("MessagingServiceSid=MG000");
    expect(fake.only.body).not.toContain("From=");
  });

  it("includes a status callback url when configured", async () => {
    const fake = new FakeFetch([{ status: 201, body: '{"sid":"SM1","status":"queued"}' }]);
    await sender(fake.fn, {
      statusCallbackUrl: "https://api.example.test/v1/webhooks/twilio",
    }).send(smsRequest());
    expect(fake.only.body).toContain(
      "StatusCallback=https%3A%2F%2Fapi.example.test%2Fv1%2Fwebhooks%2Ftwilio",
    );
  });

  it("treats every accepted status as provider acceptance", async () => {
    for (const status of TWILIO_ACCEPTED_STATUSES) {
      const fake = new FakeFetch([
        { status: 201, body: JSON.stringify({ sid: "SM1", status }) },
      ]);
      const result = await sender(fake.fn).send(smsRequest());
      expect(result.outcome).toBe("delivered");
    }
  });

  it("counts segments from the composed body when Twilio does not report them", async () => {
    const fake = new FakeFetch([{ status: 201, body: '{"sid":"SM1","status":"queued"}' }]);
    const result = await sender(fake.fn, {
      compose: () => "x".repeat(400),
    }).send(smsRequest());
    expect(result.smsSegments).toBe(Math.ceil(400 / 153));
  });

  it("clamps a reported segment count to what DeliveryAttemptSchema accepts", async () => {
    const fake = new FakeFetch([
      { status: 201, body: '{"sid":"SM1","status":"queued","num_segments":"99"}' },
    ]);
    const result = await sender(fake.fn).send(smsRequest());
    expect(result.smsSegments).toBe(MAX_SMS_SEGMENTS);
  });

  it("refuses a channel it is not the sender for", async () => {
    const fake = new FakeFetch();
    const result = await sender(fake.fn).send(sendRequest({ channel: "email" }));
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("channel_mismatch");
    expect(result.smsSegments).toBeNull();
    expect(fake.requests).toHaveLength(0);
  });

  it("maps an invalid To number to a terminal bounced_hard", async () => {
    const fake = new FakeFetch([
      {
        status: 400,
        body: '{"code":21211,"message":"The \'To\' number is not a valid phone number."}',
      },
    ]);
    const result = await sender(fake.fn).send(smsRequest());
    expect(result.outcome).toBe("bounced_hard");
    expect(result.errorCode).toBe("twilio_21211");
    expect(result.errorMessage).toContain("not a valid phone number");
  });

  it("maps an unsubscribed recipient to a terminal bounced_hard", async () => {
    const fake = new FakeFetch([
      { status: 400, body: '{"code":21610,"message":"Attempt to send to unsubscribed recipient"}' },
    ]);
    const result = await sender(fake.fn).send(smsRequest());
    expect(result.outcome).toBe("bounced_hard");
    expect(result.errorCode).toBe("twilio_21610");
  });

  it("maps bad credentials to a retryable failed", async () => {
    const fake = new FakeFetch([
      { status: 401, body: '{"code":20003,"message":"Authentication Error"}' },
    ]);
    const result = await sender(fake.fn).send(smsRequest());
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("twilio_20003");
  });

  it("maps a 429 to rate_limited", async () => {
    const fake = new FakeFetch([{ status: 429, body: '{"code":20429}' }]);
    const result = await sender(fake.fn).send(smsRequest());
    expect(result.outcome).toBe("rate_limited");
  });

  it("maps a 5xx to a retryable failed", async () => {
    const fake = new FakeFetch([{ status: 502, body: "" }]);
    const result = await sender(fake.fn).send(smsRequest());
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("twilio_server_error");
  });

  it("classifies a 2xx whose message status is already a failure", async () => {
    const fake = new FakeFetch([
      {
        status: 201,
        body: '{"sid":"SM1","status":"failed","error_code":21614,"num_segments":"1"}',
      },
    ]);
    const result = await sender(fake.fn).send(smsRequest());
    expect(result.outcome).toBe("bounced_hard");
    expect(result.errorCode).toBe("twilio_21614");
    expect(result.providerMessageId).toBe("SM1");
  });

  it("treats a cancelled message as terminal without inventing a reason", async () => {
    const fake = new FakeFetch([{ status: 201, body: '{"sid":"SM1","status":"canceled"}' }]);
    const result = await sender(fake.fn).send(smsRequest());
    expect(result.outcome).toBe("dropped");
    expect(result.errorCode).toBe("twilio_error");
  });

  it("accepts a 2xx with an unreadable body", async () => {
    const fake = new FakeFetch([{ status: 201, body: "<html/>" }]);
    const result = await sender(fake.fn).send(smsRequest());
    expect(result.outcome).toBe("delivered");
    expect(result.providerMessageId).toBeNull();
  });

  it("lets a transport failure propagate to the drain", async () => {
    await expect(sender(throwingFetch("EPIPE")).send(smsRequest())).rejects.toThrow(
      "EPIPE",
    );
  });
});

describe("failure classification", () => {
  it("prefers throttling over every other rule", () => {
    expect(classifyTwilioFailure(429, 21211).outcome).toBe("rate_limited");
    expect(classifyTwilioFailure(400, 20429).outcome).toBe("rate_limited");
  });

  it("treats a trial-account restriction as configuration, not a bad address", () => {
    expect(classifyTwilioFailure(400, 21219).outcome).toBe("failed");
  });

  it("treats an unknown 4xx code as terminal", () => {
    expect(classifyTwilioFailure(400, 99999)).toEqual({
      outcome: "dropped",
      errorCode: "twilio_99999",
    });
  });

  it("names the code in every error code it produces", () => {
    for (const code of [21211, 20003, 20429, 99999]) {
      expect(classifyTwilioFailure(400, code).errorCode).toContain(String(code));
    }
  });
});

describe("error body parsing", () => {
  it("reads a numeric code and a message", () => {
    expect(parseTwilioErrorBody('{"code":21610,"message":"blocked"}')).toEqual({
      code: 21610,
      message: "blocked",
    });
  });

  it("returns nulls for a non-JSON body", () => {
    expect(parseTwilioErrorBody("Bad Gateway")).toEqual({ code: null, message: null });
  });

  it("ignores a non-numeric code", () => {
    expect(parseTwilioErrorBody('{"code":"21610"}').code).toBeNull();
  });
});
