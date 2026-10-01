import { describe, expect, it } from "vitest";

import {
  amzDateStamps,
  buildCanonicalRequest,
  buildStringToSign,
  canonicalizeHeaders,
  classifySesFailure,
  credentialScope,
  defaultEmailComposer,
  deriveSigningKeyHex,
  parseSesErrorBody,
  SES_SEND_EMAIL_PATH,
  SesEmailSender,
  sesEndpointHost,
  signAwsV4,
  truncateErrorMessage,
  type AwsCredentials,
  type FetchLike,
  type SesEmailSenderOptions,
} from "./email-ses.js";
import { FakeFetch, sendRequest, throwingFetch } from "./test-fakes.js";

const CREDENTIALS: AwsCredentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

const FIXED_NOW = new Date("2026-09-30T12:34:56.000Z");

function sender(
  fetchImpl: FetchLike,
  overrides: Partial<SesEmailSenderOptions> = {},
): SesEmailSender {
  return new SesEmailSender({
    region: "eu-west-1",
    credentials: CREDENTIALS,
    fromAddress: "no-reply@example.test",
    fetchImpl,
    clock: () => FIXED_NOW,
    ...overrides,
  });
}

describe("sigv4 primitives", () => {
  it("formats the amz date, date stamp and credential scope", () => {
    expect(amzDateStamps(FIXED_NOW)).toEqual({
      amzDate: "20260930T123456Z",
      dateStamp: "20260930",
    });
    expect(credentialScope("20260930", "eu-west-1", "ses")).toBe(
      "20260930/eu-west-1/ses/aws4_request",
    );
  });

  it("lowercases and sorts signed headers", () => {
    const { canonical, signed } = canonicalizeHeaders({
      "X-Amz-Date": "20260930T123456Z",
      Host: "email.eu-west-1.amazonaws.com",
      "Content-Type": "application/json",
    });
    expect(signed).toBe("content-type;host;x-amz-date");
    expect(canonical).toBe(
      "content-type:application/json\nhost:email.eu-west-1.amazonaws.com\nx-amz-date:20260930T123456Z\n",
    );
  });

  it("collapses internal whitespace in a header value", () => {
    const { canonical } = canonicalizeHeaders({ host: "  a   b  " });
    expect(canonical).toBe("host:a b\n");
  });

  it("puts the payload hash last in the canonical request", () => {
    const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
      method: "post",
      path: SES_SEND_EMAIL_PATH,
      query: "",
      headers: { host: "h" },
      payload: "{}",
    });
    const lines = canonicalRequest.split("\n");
    expect(lines[0]).toBe("POST");
    expect(lines[1]).toBe(SES_SEND_EMAIL_PATH);
    expect(lines[2]).toBe("");
    expect(signedHeaders).toBe("host");
    expect(lines[lines.length - 1]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("starts the string to sign with the algorithm and hashes the canonical request", () => {
    const stringToSign = buildStringToSign({
      amzDate: "20260930T123456Z",
      scope: "20260930/eu-west-1/ses/aws4_request",
      canonicalRequest: "canonical",
    });
    const lines = stringToSign.split("\n");
    expect(lines[0]).toBe("AWS4-HMAC-SHA256");
    expect(lines[1]).toBe("20260930T123456Z");
    expect(lines[2]).toBe("20260930/eu-west-1/ses/aws4_request");
    expect(lines[3]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derives a 64-hex signing key that depends on every input", () => {
    const base = {
      secretAccessKey: CREDENTIALS.secretAccessKey,
      dateStamp: "20260930",
      region: "eu-west-1",
      service: "ses",
    };
    const key = deriveSigningKeyHex(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveSigningKeyHex({ ...base, dateStamp: "20261001" })).not.toBe(key);
    expect(deriveSigningKeyHex({ ...base, region: "us-east-1" })).not.toBe(key);
    expect(deriveSigningKeyHex({ ...base, service: "sns" })).not.toBe(key);
  });

  it("signs exactly the headers it returns", () => {
    const headers = signAwsV4({
      method: "POST",
      path: SES_SEND_EMAIL_PATH,
      host: sesEndpointHost("eu-west-1"),
      payload: "{}",
      region: "eu-west-1",
      service: "ses",
      credentials: CREDENTIALS,
      now: FIXED_NOW,
    });
    const signedHeaders = /SignedHeaders=([^,]+)/.exec(
      headers["authorization"] ?? "",
    )?.[1];
    expect(signedHeaders).toBe("content-type;host;x-amz-content-sha256;x-amz-date");
    for (const name of (signedHeaders ?? "").split(";")) {
      expect(Object.keys(headers)).toContain(name);
    }
    expect(headers["authorization"]).toContain(
      `Credential=${CREDENTIALS.accessKeyId}/20260930/eu-west-1/ses/aws4_request`,
    );
    expect(headers["authorization"]).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  it("includes and signs a session token when one is supplied", () => {
    const headers = signAwsV4({
      method: "POST",
      path: SES_SEND_EMAIL_PATH,
      host: sesEndpointHost("eu-west-1"),
      payload: "{}",
      region: "eu-west-1",
      service: "ses",
      credentials: { ...CREDENTIALS, sessionToken: "FwoGZXIvYXdz" },
      now: FIXED_NOW,
    });
    expect(headers["x-amz-security-token"]).toBe("FwoGZXIvYXdz");
    expect(headers["authorization"]).toContain("x-amz-security-token");
  });

  it("changes the signature when the payload changes", () => {
    const common = {
      method: "POST",
      path: SES_SEND_EMAIL_PATH,
      host: sesEndpointHost("eu-west-1"),
      region: "eu-west-1",
      service: "ses",
      credentials: CREDENTIALS,
      now: FIXED_NOW,
    } as const;
    const a = signAwsV4({ ...common, payload: "{}" })["authorization"];
    const b = signAwsV4({ ...common, payload: '{"a":1}' })["authorization"];
    expect(a).not.toBe(b);
  });
});

describe("construction", () => {
  it("builds the regional endpoint host", () => {
    expect(sesEndpointHost("us-east-2")).toBe("email.us-east-2.amazonaws.com");
  });

  it("rejects a missing region", () => {
    expect(() => sender(new FakeFetch().fn, { region: "" })).toThrow(/region/);
  });

  it("rejects a secret too short to key an HMAC", () => {
    expect(() =>
      sender(new FakeFetch().fn, {
        credentials: { accessKeyId: "AKIA", secretAccessKey: "short" },
      }),
    ).toThrow(/secretAccessKey/);
  });

  it("rejects a missing from address", () => {
    expect(() => sender(new FakeFetch().fn, { fromAddress: "" })).toThrow(/fromAddress/);
  });

  it("renders a display name into the From header when given one", () => {
    expect(sender(new FakeFetch().fn, { fromName: "CrossEngin" }).fromHeaderValue()).toBe(
      "CrossEngin <no-reply@example.test>",
    );
    expect(sender(new FakeFetch().fn).fromHeaderValue()).toBe("no-reply@example.test");
  });
});

describe("payload", () => {
  it("addresses the recipient and tags the dispatch", () => {
    const payload = JSON.parse(
      sender(new FakeFetch().fn).buildPayload(sendRequest()),
    ) as Record<string, unknown>;
    expect(payload["Destination"]).toEqual({ ToAddresses: ["ops@example.test"] });
    expect(payload["EmailTags"]).toEqual([
      { Name: "dispatch_id", Value: "disp_0123456789abcdef0123456789abcdef" },
      { Name: "tenant_id", Value: "11111111-1111-4111-8111-111111111111" },
      { Name: "attempt", Value: "1" },
    ]);
  });

  it("omits the configuration set unless one is configured", () => {
    const without = JSON.parse(
      sender(new FakeFetch().fn).buildPayload(sendRequest()),
    ) as Record<string, unknown>;
    expect(without["ConfigurationSetName"]).toBeUndefined();
    const with_ = JSON.parse(
      sender(new FakeFetch().fn, {
        configurationSetName: "crossengin-events",
      }).buildPayload(sendRequest()),
    ) as Record<string, unknown>;
    expect(with_["ConfigurationSetName"]).toBe("crossengin-events");
  });

  it("sends a text body by default and an html body when the composer supplies one", () => {
    const text = JSON.parse(
      sender(new FakeFetch().fn).buildPayload(sendRequest()),
    ) as { Content: { Simple: { Body: Record<string, unknown> } } };
    expect(text.Content.Simple.Body["Html"]).toBeUndefined();
    const html = JSON.parse(
      sender(new FakeFetch().fn, {
        compose: () => ({ subject: "s", textBody: "t", htmlBody: "<p>t</p>" }),
      }).buildPayload(sendRequest()),
    ) as { Content: { Simple: { Body: { Html?: { Data: string } } } } };
    expect(html.Content.Simple.Body.Html?.Data).toBe("<p>t</p>");
  });

  it("sanitizes a tag value SES would reject", () => {
    const payload = JSON.parse(
      sender(new FakeFetch().fn).buildPayload(
        sendRequest({ dispatchId: "disp with spaces!" }),
      ),
    ) as { EmailTags: readonly { Name: string; Value: string }[] };
    expect(payload.EmailTags[0]?.Value).toBe("disp_with_spaces_");
  });

  it("composes a default body that leaks no tenant data beyond identifiers", () => {
    const composed = defaultEmailComposer(sendRequest());
    expect(composed.subject).toContain("design_review.approved");
    expect(composed.textBody).toContain("disp_0123456789abcdef0123456789abcdef");
    expect(composed.htmlBody).toBeUndefined();
  });
});

describe("send", () => {
  it("POSTs the signed request to the SES v2 outbound-emails resource", async () => {
    const fake = new FakeFetch([{ status: 200, body: '{"MessageId":"0100-abc"}' }]);
    const result = await sender(fake.fn).send(sendRequest());

    expect(fake.only.method).toBe("POST");
    expect(fake.only.url).toBe(
      "https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails",
    );
    expect(fake.only.headers["content-type"]).toBe("application/json");
    expect(fake.only.headers["host"]).toBe("email.eu-west-1.amazonaws.com");
    expect(fake.only.headers["x-amz-date"]).toBe("20260930T123456Z");
    expect(fake.only.headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.only.headers["authorization"]).toContain("AWS4-HMAC-SHA256 Credential=");
    expect(fake.only.body).toBe(sender(fake.fn).buildPayload(sendRequest()));

    expect(result.outcome).toBe("delivered");
    expect(result.provider).toBe("ses");
    expect(result.providerMessageId).toBe("0100-abc");
    expect(result.httpStatus).toBe(200);
    expect(result.bytesSent).toBeGreaterThan(0);
    expect(result.errorCode).toBeNull();
  });

  it("honours a base url override without changing the signed host", async () => {
    const fake = new FakeFetch([{ status: 200, body: "{}" }]);
    await sender(fake.fn, { baseUrl: "http://localhost:4566" }).send(sendRequest());
    expect(fake.only.url).toBe("http://localhost:4566/v2/email/outbound-emails");
    expect(fake.only.headers["host"]).toBe("email.eu-west-1.amazonaws.com");
  });

  it("delivers with a null message id when a 200 body is unreadable", async () => {
    const fake = new FakeFetch([{ status: 200, body: "not json" }]);
    const result = await sender(fake.fn).send(sendRequest());
    expect(result.outcome).toBe("delivered");
    expect(result.providerMessageId).toBeNull();
  });

  it("refuses a channel it is not the sender for", async () => {
    const fake = new FakeFetch();
    const result = await sender(fake.fn).send(sendRequest({ channel: "sms" }));
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("channel_mismatch");
    expect(fake.requests).toHaveLength(0);
  });

  it("maps a rejected recipient to a terminal bounced_hard", async () => {
    const fake = new FakeFetch([
      {
        status: 400,
        body: '{"__type":"MessageRejected","message":"Email address is not verified"}',
      },
    ]);
    const result = await sender(fake.fn).send(sendRequest());
    expect(result.outcome).toBe("bounced_hard");
    expect(result.errorCode).toBe("ses_message_rejected");
    expect(result.errorMessage).toBe("Email address is not verified");
    expect(result.httpStatus).toBe(400);
  });

  it("maps throttling to rate_limited so the retry ladder backs off", async () => {
    const fake = new FakeFetch([
      { status: 429, body: '{"__type":"TooManyRequestsException"}' },
    ]);
    const result = await sender(fake.fn).send(sendRequest());
    expect(result.outcome).toBe("rate_limited");
    expect(result.errorCode).toBe("ses_too_many_requests");
  });

  it("maps a 5xx to a retryable failed", async () => {
    const fake = new FakeFetch([{ status: 503, body: "" }]);
    const result = await sender(fake.fn).send(sendRequest());
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("ses_server_error");
  });

  it("lets a transport failure propagate for the drain's sendWithTimeout to classify", async () => {
    await expect(sender(throwingFetch()).send(sendRequest())).rejects.toThrow(
      "ECONNRESET",
    );
  });
});

describe("failure classification", () => {
  it("treats a configuration failure as retryable, per ADR-0274", () => {
    expect(classifySesFailure(400, "AccountSuspendedException")).toEqual({
      outcome: "failed",
      errorCode: "ses_account_suspended",
    });
    expect(classifySesFailure(403, null)).toEqual({
      outcome: "failed",
      errorCode: "ses_not_authorized",
    });
    expect(classifySesFailure(400, "MailFromDomainNotVerifiedException").outcome).toBe(
      "failed",
    );
  });

  it("treats any other 4xx as terminal, because the identical retry cannot succeed", () => {
    expect(classifySesFailure(400, "SomethingNew")).toEqual({
      outcome: "dropped",
      errorCode: "ses_something_new",
    });
    expect(classifySesFailure(404, null).outcome).toBe("dropped");
  });

  it("prefers throttling over every other rule", () => {
    expect(classifySesFailure(429, "MessageRejected").outcome).toBe("rate_limited");
    expect(classifySesFailure(400, "ThrottlingException").outcome).toBe("rate_limited");
  });

  it("keeps every error code inside the 80-character column", () => {
    const code = classifySesFailure(
      400,
      "AnExtremelyLongExceptionNameThatSomeFutureApiVersionMightConceivablyIntroduceException",
    ).errorCode;
    expect(code.length).toBeLessThanOrEqual(80);
  });
});

describe("error body parsing", () => {
  it("reads every spelling SES uses, and nulls for anything else", () => {
    expect(
      parseSesErrorBody('{"__type":"com.amazon.coral#MessageRejected"}').type,
    ).toBe("MessageRejected");
    expect(parseSesErrorBody('{"code":"Throttling","Message":"slow down"}')).toEqual({
      type: "Throttling",
      message: "slow down",
    });
    expect(parseSesErrorBody("<html>502</html>")).toEqual({
      type: null,
      message: null,
    });
  });
});

describe("truncateErrorMessage", () => {
  it("leaves a short message alone and cuts a long one to 500", () => {
    expect(truncateErrorMessage("short")).toBe("short");
    expect(truncateErrorMessage("x".repeat(600))).toHaveLength(500);
  });
});
