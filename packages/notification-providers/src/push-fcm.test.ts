import { CHANNEL_CAPABILITIES } from "@crossengin/notifications";
import { describe, expect, it } from "vitest";

import type { FetchLike } from "./email-ses.js";
import {
  allowedPushDataValues,
  classifyFcmFailure,
  DEFAULT_PUSH_NOTICE,
  defaultPushComposer,
  FCM_API_BASE_URL,
  FcmPushSender,
  fcmSendPath,
  looksLikeFcmRegistrationToken,
  MIN_FCM_REGISTRATION_TOKEN_LENGTH,
  noticeForLocale,
  parseFcmErrorBody,
  parseFcmMessageName,
  PUSH_ALLOWED_DATA_KEYS,
  PUSH_PAYLOAD_REFUSED_ERROR_CODE,
  PUSH_RECIPIENT_REFUSED_ERROR_CODE,
  pushPayloadViolations,
  type FcmPushSenderOptions,
  type PushNotice,
} from "./push-fcm.js";
import {
  FakeFetch,
  sendRequest,
  TEST_FCM_REGISTRATION_TOKEN,
  TEST_TENANT_ID,
  throwingFetch,
} from "./test-fakes.js";

const PROJECT_ID = "crossengin-prod";

function sender(
  fetchImpl: FetchLike,
  overrides: Partial<FcmPushSenderOptions> = {},
): FcmPushSender {
  return new FcmPushSender({
    projectId: PROJECT_ID,
    accessToken: async () => "ya29.test-access-token",
    fetchImpl,
    ...overrides,
  });
}

function pushRequest(): ReturnType<typeof sendRequest> {
  return sendRequest({
    channel: "push_mobile",
    recipientAddress: TEST_FCM_REGISTRATION_TOKEN,
  });
}

const ACCEPTED = (): FakeFetch =>
  new FakeFetch([
    {
      status: 200,
      body: JSON.stringify({
        name: `projects/${PROJECT_ID}/messages/0:1759000000000000%31bd1c96`,
      }),
    },
  ]);

describe("request shape helpers", () => {
  it("builds the v1 send path for a project", () => {
    expect(fcmSendPath(PROJECT_ID)).toBe(
      `/v1/projects/${PROJECT_ID}/messages:send`,
    );
  });

  it("url-encodes a project id in the path", () => {
    expect(fcmSendPath("a/b")).toBe("/v1/projects/a%2Fb/messages:send");
  });

  it("keeps only the message id out of a returned resource name", () => {
    expect(
      parseFcmMessageName('{"name":"projects/p/messages/0:17590%31bd"}'),
    ).toBe("0:17590%31bd");
  });

  it("returns null for a 200 body it cannot read", () => {
    expect(parseFcmMessageName("<html/>")).toBeNull();
    expect(parseFcmMessageName("{}")).toBeNull();
  });
});

describe("the notice catalog", () => {
  it("serves the single default notice to every locale", () => {
    for (const locale of ["en-US", "ar-SA", "de-DE"]) {
      expect(noticeForLocale([DEFAULT_PUSH_NOTICE], locale)).toEqual(
        DEFAULT_PUSH_NOTICE,
      );
    }
  });

  it("picks positionally when locales are declared", () => {
    const notices: readonly PushNotice[] = [
      { title: "a", body: "a" },
      { title: "b", body: "b" },
    ];
    expect(noticeForLocale(notices, "fr-FR", ["en-US", "fr-FR"]).title).toBe("b");
  });

  it("falls back to the first notice for an undeclared locale", () => {
    const notices: readonly PushNotice[] = [
      { title: "a", body: "a" },
      { title: "b", body: "b" },
    ];
    expect(noticeForLocale(notices, "ja-JP", ["en-US", "fr-FR"]).title).toBe("a");
  });

  it("composes data holding only identifiers, and no template id by default", () => {
    const composed = defaultPushComposer(pushRequest(), DEFAULT_PUSH_NOTICE);
    expect(composed.notice).toEqual(DEFAULT_PUSH_NOTICE);
    expect(composed.data).toEqual({
      dispatch_id: "disp_0123456789abcdef0123456789abcdef",
      tenant_id: TEST_TENANT_ID,
      locale: "en-US",
      attempt: "1",
    });
    expect(composed.data["template_id"]).toBeUndefined();
  });

  it("carries no content: every composed value is an identifier of the request", () => {
    const request = pushRequest();
    const allowed = allowedPushDataValues(request);
    for (const value of Object.values(defaultPushComposer(request, DEFAULT_PUSH_NOTICE).data)) {
      expect(allowed.has(value)).toBe(true);
    }
  });
});

describe("the reference-only (PHI-safe) rule", () => {
  const request = pushRequest();
  const notices = [DEFAULT_PUSH_NOTICE];

  it("accepts the default composition", () => {
    expect(
      pushPayloadViolations({
        composed: defaultPushComposer(request, DEFAULT_PUSH_NOTICE),
        notices,
        request,
        serializedBytes: 200,
      }),
    ).toEqual([]);
  });

  it("rejects a title the catalog does not declare", () => {
    expect(
      pushPayloadViolations({
        composed: {
          notice: { title: "Lab result for Jane Roe", body: DEFAULT_PUSH_NOTICE.body },
          data: {},
          },
        notices,
        request,
        serializedBytes: 200,
      }),
    ).toEqual(["title_not_in_catalog"]);
  });

  it("rejects a body the catalog does not declare", () => {
    expect(
      pushPayloadViolations({
        composed: {
          notice: {
            title: DEFAULT_PUSH_NOTICE.title,
            body: "Your HIV test result is ready.",
          },
          data: {},
        },
        notices,
        request,
        serializedBytes: 200,
      }),
    ).toEqual(["body_not_in_catalog"]);
  });

  it("rejects a data key outside the allow-list", () => {
    expect(
      pushPayloadViolations({
        composed: {
          notice: DEFAULT_PUSH_NOTICE,
          data: { patient_name: request.dispatchId },
        },
        notices,
        request,
        serializedBytes: 200,
      }),
    ).toEqual(["data_key_not_allowed"]);
  });

  it("rejects an allowed key smuggling a value that is not an identifier", () => {
    expect(
      pushPayloadViolations({
        composed: {
          notice: DEFAULT_PUSH_NOTICE,
          data: { dispatch_id: "Jane Roe, 1984-02-02, oncology" },
        },
        notices,
        request,
        serializedBytes: 200,
      }),
    ).toEqual(["data_value_not_an_identifier"]);
  });

  it("rejects a payload over the channel's byte cap", () => {
    expect(
      pushPayloadViolations({
        composed: defaultPushComposer(request, DEFAULT_PUSH_NOTICE),
        notices,
        request,
        serializedBytes: CHANNEL_CAPABILITIES.push_mobile.maxBodyBytes + 1,
      }),
    ).toEqual(["payload_too_large"]);
  });

  it("permits template_id as a key, since it is on the allow-list", () => {
    expect(PUSH_ALLOWED_DATA_KEYS).toContain("template_id");
    expect(
      pushPayloadViolations({
        composed: {
          notice: DEFAULT_PUSH_NOTICE,
          data: { template_id: request.templateId },
        },
        notices,
        request,
        serializedBytes: 200,
      }),
    ).toEqual([]);
  });
});

describe("construction", () => {
  it("rejects a missing project id", () => {
    expect(() => sender(new FakeFetch().fn, { projectId: "" })).toThrow(
      /projectId/,
    );
  });

  it("rejects an empty notice catalog, which could never send", () => {
    expect(() => sender(new FakeFetch().fn, { notices: [] })).toThrow(
      /notices must not be empty/,
    );
  });

  it("rejects a notice with no title or no body", () => {
    expect(() =>
      sender(new FakeFetch().fn, { notices: [{ title: "", body: "b" }] }),
    ).toThrow(/title and a body/);
  });

  it("rejects a locale list that does not line up with the catalog", () => {
    expect(() =>
      sender(new FakeFetch().fn, {
        notices: [DEFAULT_PUSH_NOTICE],
        noticeLocales: ["en-US", "fr-FR"],
      }),
    ).toThrow(/one entry per notice/);
  });

  it("exposes the catalog it will accept a notice from", () => {
    expect(sender(new FakeFetch().fn).noticeCatalog()).toEqual([
      DEFAULT_PUSH_NOTICE,
    ]);
  });
});

describe("send", () => {
  it("POSTs a bearer-authenticated JSON message to the v1 endpoint", async () => {
    const fake = ACCEPTED();
    const result = await sender(fake.fn).send(pushRequest());

    expect(fake.only.method).toBe("POST");
    expect(fake.only.url).toBe(
      `${FCM_API_BASE_URL}/v1/projects/${PROJECT_ID}/messages:send`,
    );
    expect(fake.only.headers["authorization"]).toBe(
      "Bearer ya29.test-access-token",
    );
    expect(fake.only.headers["content-type"]).toBe("application/json");
    expect(fake.only.headers["accept"]).toBe("application/json");

    const body = JSON.parse(fake.only.body ?? "{}") as {
      message: {
        token: string;
        notification: { title: string; body: string };
        data: Record<string, string>;
      };
    };
    expect(body.message.token).toBe(TEST_FCM_REGISTRATION_TOKEN);
    expect(body.message.notification).toEqual(DEFAULT_PUSH_NOTICE);
    expect(body.message.data["dispatch_id"]).toBe(
      "disp_0123456789abcdef0123456789abcdef",
    );

    expect(result.outcome).toBe("delivered");
    expect(result.provider).toBe("fcm");
    expect(result.providerMessageId).toBe("0:1759000000000000%31bd1c96");
    expect(result.httpStatus).toBe(200);
    expect(result.bytesSent).toBe(Buffer.byteLength(fake.only.body ?? ""));
    expect(result.errorCode).toBeNull();
  });

  it("sends the locale's notice when the catalog is localised", async () => {
    const fake = ACCEPTED();
    await sender(fake.fn, {
      notices: [DEFAULT_PUSH_NOTICE, { title: "CrossEngin", body: "Vous avez un avis." }],
      noticeLocales: ["en-US", "fr-FR"],
    }).send(sendRequest({
      channel: "push_mobile",
      recipientAddress: TEST_FCM_REGISTRATION_TOKEN,
      locale: "fr-FR",
    }));
    expect(fake.only.body).toContain("Vous avez un avis.");
  });

  it("refuses a channel it is not the sender for", async () => {
    const fake = new FakeFetch();
    const result = await sender(fake.fn).send(sendRequest({ channel: "sms" }));
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("channel_mismatch");
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses a user id in place of a device token, without suppressing it", async () => {
    const fake = new FakeFetch();
    const result = await sender(fake.fn).send(
      sendRequest({ channel: "push_mobile", recipientAddress: TEST_TENANT_ID }),
    );
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe(PUSH_RECIPIENT_REFUSED_ERROR_CODE);
    expect(fake.requests).toHaveLength(0);
  });

  it("never quotes the device token in a refusal message", async () => {
    const fake = new FakeFetch();
    const result = await sender(fake.fn).send(
      sendRequest({ channel: "push_mobile", recipientAddress: "short-token" }),
    );
    expect(result.errorMessage).not.toContain("short-token");
    expect(result.errorMessage).toContain("11 chars");
  });

  it("refuses a composer that reaches for content, and sends nothing", async () => {
    const fake = new FakeFetch();
    const result = await sender(fake.fn, {
      compose: () => ({
        notice: { title: "Lab result", body: "Jane Roe: biopsy positive" },
        data: { diagnosis: "C50.9" },
      }),
    }).send(pushRequest());

    expect(fake.requests).toHaveLength(0);
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe(PUSH_PAYLOAD_REFUSED_ERROR_CODE);
    expect(result.errorCode).not.toBeNull();
  });

  it("names the violated rules in a refusal, and never the offending text", async () => {
    const fake = new FakeFetch();
    const result = await sender(fake.fn, {
      compose: () => ({
        notice: { title: "Jane Roe", body: "biopsy positive" },
        data: { diagnosis: "C50.9" },
      }),
    }).send(pushRequest());

    expect(result.errorMessage).toContain("title_not_in_catalog");
    expect(result.errorMessage).toContain("body_not_in_catalog");
    expect(result.errorMessage).toContain("data_key_not_allowed");
    expect(result.errorMessage).not.toContain("Jane Roe");
    expect(result.errorMessage).not.toContain("biopsy");
    expect(result.errorMessage).not.toContain("C50.9");
  });

  it("maps an unregistered token to a terminal bounced_hard", async () => {
    const fake = new FakeFetch([
      {
        status: 404,
        body: JSON.stringify({
          error: {
            code: 404,
            message: "Requested entity was not found.",
            status: "NOT_FOUND",
            details: [
              {
                "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                errorCode: "UNREGISTERED",
              },
            ],
          },
        }),
      },
    ]);
    const result = await sender(fake.fn).send(pushRequest());
    expect(result.outcome).toBe("bounced_hard");
    expect(result.errorCode).toBe("fcm_unregistered");
    expect(result.errorMessage).toContain("not found");
  });

  it("maps a revoked service account to a retryable failed", async () => {
    const fake = new FakeFetch([
      {
        status: 401,
        body: JSON.stringify({
          error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" },
        }),
      },
    ]);
    const result = await sender(fake.fn).send(pushRequest());
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("fcm_unauthenticated");
  });

  it("maps a malformed message to a terminal dropped, not a bounce", async () => {
    const fake = new FakeFetch([
      {
        status: 400,
        body: JSON.stringify({
          error: { code: 400, message: "Invalid value at 'message.token'", status: "INVALID_ARGUMENT" },
        }),
      },
    ]);
    const result = await sender(fake.fn).send(pushRequest());
    expect(result.outcome).toBe("dropped");
    expect(result.errorCode).toBe("fcm_invalid_argument");
  });

  it("maps a quota failure to rate_limited and a 5xx to a retryable failed", async () => {
    const quota = new FakeFetch([
      {
        status: 429,
        body: JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } }),
      },
    ]);
    expect((await sender(quota.fn).send(pushRequest())).outcome).toBe(
      "rate_limited",
    );

    const down = new FakeFetch([{ status: 503, body: "" }]);
    const result = await sender(down.fn).send(pushRequest());
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("fcm_server_error");
  });

  it("accepts a 200 with an unreadable body", async () => {
    const fake = new FakeFetch([{ status: 200, body: "<html/>" }]);
    const result = await sender(fake.fn).send(pushRequest());
    expect(result.outcome).toBe("delivered");
    expect(result.providerMessageId).toBeNull();
  });

  it("lets a token provider failure propagate to the drain", async () => {
    const fake = new FakeFetch();
    await expect(
      sender(fake.fn, {
        accessToken: async () => {
          throw new Error("metadata server unreachable");
        },
      }).send(pushRequest()),
    ).rejects.toThrow("metadata server unreachable");
    expect(fake.requests).toHaveLength(0);
  });

  it("lets a transport failure propagate to the drain", async () => {
    await expect(sender(throwingFetch("ECONNRESET")).send(pushRequest())).rejects.toThrow(
      "ECONNRESET",
    );
  });

  it("asks for a fresh token on every send", async () => {
    const fake = new FakeFetch([
      { status: 200, body: '{"name":"projects/p/messages/1"}' },
      { status: 200, body: '{"name":"projects/p/messages/2"}' },
    ]);
    let issued = 0;
    const s = sender(fake.fn, {
      accessToken: async () => {
        issued += 1;
        return `token-${String(issued)}`;
      },
    });
    await s.send(pushRequest());
    await s.send(pushRequest());
    expect(issued).toBe(2);
    expect(fake.requests[1]?.headers["authorization"]).toBe("Bearer token-2");
  });
});

describe("registration token shape", () => {
  it("rejects a UUID, which is what the resolver supplies today", () => {
    expect(looksLikeFcmRegistrationToken(TEST_TENANT_ID)).toBe(false);
    expect(looksLikeFcmRegistrationToken(TEST_TENANT_ID.toUpperCase())).toBe(false);
  });

  it("rejects anything shorter than a token can be", () => {
    expect(
      looksLikeFcmRegistrationToken("a".repeat(MIN_FCM_REGISTRATION_TOKEN_LENGTH - 1)),
    ).toBe(false);
    expect(
      looksLikeFcmRegistrationToken("a".repeat(MIN_FCM_REGISTRATION_TOKEN_LENGTH)),
    ).toBe(true);
  });

  it("rejects a token carrying characters FCM never mints", () => {
    expect(looksLikeFcmRegistrationToken(`${"a".repeat(40)} ${"b".repeat(40)}`)).toBe(
      false,
    );
    expect(looksLikeFcmRegistrationToken(`${"a".repeat(40)}@example.test`)).toBe(false);
  });

  it("accepts a realistically shaped token", () => {
    expect(looksLikeFcmRegistrationToken(TEST_FCM_REGISTRATION_TOKEN)).toBe(true);
  });
});

describe("failure classification", () => {
  it("prefers throttling over every other rule", () => {
    expect(classifyFcmFailure(429, "UNREGISTERED").outcome).toBe("rate_limited");
    expect(classifyFcmFailure(400, "QUOTA_EXCEEDED").outcome).toBe("rate_limited");
  });

  it("treats a sender id mismatch as configuration, not a dead device", () => {
    // A wrong FCM_PROJECT_ID produces this for every token in the deployment; calling it a hard
    // bounce would suppress push for a whole tenant over one environment variable.
    expect(classifyFcmFailure(403, "SENDER_ID_MISMATCH").outcome).toBe("failed");
  });

  it("treats an unknown 4xx as terminal without bouncing it", () => {
    expect(classifyFcmFailure(418, "TEAPOT")).toEqual({
      outcome: "dropped",
      errorCode: "fcm_teapot",
    });
  });

  it("falls back to a named code when the body carried none", () => {
    expect(classifyFcmFailure(400, null).errorCode).toBe("fcm_rejected");
    expect(classifyFcmFailure(401, null).errorCode).toBe("fcm_not_authorized");
    expect(classifyFcmFailure(500, null).errorCode).toBe("fcm_server_error");
    expect(classifyFcmFailure(429, null).errorCode).toBe("fcm_throttled");
  });

  it("will not bounce a 404 that named no code, since a wrong project id is also a 404", () => {
    expect(classifyFcmFailure(404, null)).toEqual({
      outcome: "dropped",
      errorCode: "fcm_rejected",
    });
    expect(classifyFcmFailure(404, "UNREGISTERED").outcome).toBe("bounced_hard");
  });

  it("keeps every error code within the audit column's width", () => {
    for (const code of ["UNREGISTERED", "A".repeat(200), "has spaces"]) {
      expect(classifyFcmFailure(400, code).errorCode.length).toBeLessThanOrEqual(80);
    }
  });
});

describe("error body parsing", () => {
  it("prefers the FcmError detail over the coarse gRPC status", () => {
    expect(
      parseFcmErrorBody(
        JSON.stringify({
          error: {
            status: "NOT_FOUND",
            message: "gone",
            details: [
              {
                "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                errorCode: "UNREGISTERED",
              },
            ],
          },
        }),
      ),
    ).toEqual({ code: "UNREGISTERED", message: "gone" });
  });

  it("ignores a detail of another type", () => {
    expect(
      parseFcmErrorBody(
        JSON.stringify({
          error: {
            status: "INVALID_ARGUMENT",
            details: [{ "@type": "type.googleapis.com/google.rpc.BadRequest" }],
          },
        }),
      ).code,
    ).toBe("INVALID_ARGUMENT");
  });

  it("returns nulls for a body with no error object", () => {
    expect(parseFcmErrorBody("Service Unavailable")).toEqual({
      code: null,
      message: null,
    });
    expect(parseFcmErrorBody('{"error":"nope"}')).toEqual({
      code: null,
      message: null,
    });
  });
});
